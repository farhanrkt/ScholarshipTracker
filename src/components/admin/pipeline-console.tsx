"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CircleStop,
  Loader2,
  Play,
  RotateCw,
  Terminal,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { JobName } from "@/lib/pipeline/jobs";

/**
 * The buttons that run the crawlers, and the log they produce.
 *
 * HOW THIS WORKS NOW. A run is a row in the database, and this component drives
 * it: start it, then call `tick` over and over until it reports `done`. Each
 * tick does as much work as fits in one function call and returns the lines it
 * produced.
 *
 * That indirection is what makes the pipeline work on Vercel, where nothing
 * lives longer than a request. It also makes the run survive this component:
 * close the tab and the job keeps its place, reopen the page and it re-attaches
 * to whatever is in flight and keeps going. The old streaming console could do
 * neither — the run WAS the HTTP connection, so losing one lost the other.
 *
 * The log is the feature, not decoration. These runs take minutes and spend a
 * rate-limited quota; a spinner that says nothing for four minutes gives an
 * operator no way to tell a slow crawl from a stuck one.
 */

interface JobField {
  key: "filter" | "count" | "depth";
  label: string;
  placeholder: string;
  hint: string;
  numeric?: boolean;
}

const FIELDS: Record<JobName, JobField[]> = {
  extract: [
    {
      key: "filter",
      label: "Title contains",
      placeholder: "Chevening",
      hint: "Blank runs every programme that is not already verified.",
    },
    {
      key: "count",
      label: "Max programmes",
      placeholder: "50",
      hint: "Programmes read per run.",
      numeric: true,
    },
    {
      key: "depth",
      label: "Pages per programme",
      placeholder: "20",
      hint: "More pages finds more detail and costs more time.",
      numeric: true,
    },
  ],
  discover: [
    {
      key: "filter",
      label: "Seed label contains",
      placeholder: "Chevening",
      hint: "Blank runs every seed — expect this to take a while.",
    },
    {
      key: "count",
      label: "Programmes per seed",
      placeholder: "20",
      hint: "Pages classified per seed.",
      numeric: true,
    },
    {
      key: "depth",
      label: "Listing pages per seed",
      placeholder: "8",
      hint: "Covers pagination and sub-indexes.",
      numeric: true,
    },
  ],
};

interface JobState {
  dryRun: boolean;
  datesOnly: boolean;
  escalate: boolean;
  verify: boolean;
  force: boolean;
  fixUrls: boolean;
  gapFill: boolean;
  gapCrawl: boolean;
  staleOnly: boolean;
  useSitemap: boolean;
  filter: string;
  count: string;
  depth: string;
}

const INITIAL: JobState = {
  dryRun: true,
  datesOnly: false,
  escalate: false,
  verify: false,
  force: false,
  fixUrls: true,
  gapFill: true,
  gapCrawl: true,
  staleOnly: false,
  useSitemap: true,
  filter: "",
  count: "",
  depth: "",
};

interface LiveJob {
  id: string;
  kind: JobName;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  cursor: number;
  total: number;
  staged: number;
  failed: number;
  skipped: number;
  error?: string | null;
}

const FINISHED = new Set(["done", "failed", "cancelled"]);

export function PipelineConsole({ job }: { job: JobName }) {
  const [state, setState] = useState<JobState>(INITIAL);
  const [log, setLog] = useState<string[]>([]);
  const [live, setLive] = useState<LiveJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const logRef = useRef<HTMLPreElement>(null);
  /** Set while a run is being driven, so a re-render cannot start a second loop. */
  const driving = useRef(false);
  /** Lets `stop` end the loop without waiting for the tick in flight. */
  const stopped = useRef(false);

  // Follow the tail as it streams, the way a terminal does.
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log]);

  const append = useCallback((lines: string[]) => {
    if (lines.length > 0) setLog((current) => [...current, ...lines]);
  }, []);

  /**
   * Work the job until it finishes.
   *
   * Each pass is one HTTP request that does real crawling and returns its
   * output, so this loop is the run: it is not polling a background worker,
   * it IS what advances the work.
   */
  const drive = useCallback(
    async (jobId: string) => {
      if (driving.current) return;
      driving.current = true;
      stopped.current = false;
      setBusy(true);

      try {
        for (;;) {
          if (stopped.current) break;

          const response = await fetch("/api/admin/pipeline/tick", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId }),
          });

          if (!response.ok) {
            setError((await response.text()) || `Tick failed (${response.status}).`);
            break;
          }

          const result = (await response.json()) as LiveJob & {
            claimed: boolean;
            lines: string[];
          };

          append(result.lines);
          setLive((current) => ({ ...(current ?? { id: jobId, kind: job }), ...result }));

          if (FINISHED.has(result.status)) break;

          // Another worker holds it — most often a second tab. Back off rather
          // than spinning: it is making progress, and this loop would only be
          // asking the same question faster.
          if (!result.claimed) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        driving.current = false;
        setBusy(false);
      }
    },
    [append, job],
  );

  /* -------------------------------------------------- re-attach on mount */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/admin/pipeline");
        if (!response.ok) return;

        const body = (await response.json()) as {
          available: boolean;
          reason?: string;
          live: LiveJob | null;
        };

        if (cancelled) return;

        if (!body.available) {
          setUnavailable(body.reason ?? "The pipeline tables are not available.");
          return;
        }

        // Only re-attach to a run of THIS job kind: the page shows two consoles,
        // and an extract run has no business appearing under discover.
        if (body.live && body.live.kind === job) {
          setLive(body.live);

          const logResponse = await fetch(
            `/api/admin/pipeline/log?job=${body.live.id}&after=-1`,
          );
          if (logResponse.ok && !cancelled) {
            const { lines } = (await logResponse.json()) as { lines: string[] };
            setLog(lines);
          }

          if (!cancelled) void drive(body.live.id);
        }
      } catch {
        // A failed status check is not worth an error banner: the operator has
        // not asked for anything yet, and pressing Run will say so properly.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [job, drive]);

  /* ------------------------------------------------------------- actions */

  const run = useCallback(async () => {
    setError(null);
    setLog([]);
    setLive(null);
    setBusy(true);

    try {
      const response = await fetch("/api/admin/pipeline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          job,
          dryRun: state.dryRun,
          datesOnly: state.datesOnly,
          escalate: state.escalate,
          verify: state.verify,
          force: state.force,
          fixUrls: state.fixUrls,
          gapFill: state.gapFill,
          gapCrawl: state.gapCrawl,
          staleOnly: state.staleOnly,
          useSitemap: state.useSitemap,
          filter: state.filter,
          count: state.count,
          depth: state.depth,
        }),
      });

      if (!response.ok) {
        setError((await response.text()) || `Request failed (${response.status}).`);
        setBusy(false);
        return;
      }

      const body = (await response.json()) as {
        empty?: boolean;
        notes?: string[];
        description?: string;
        job?: LiveJob;
      };

      if (body.empty || !body.job) {
        setLog(body.notes ?? ["Nothing to do."]);
        setBusy(false);
        return;
      }

      setLog([`$ ${body.description ?? job}`, ...(body.notes ?? [])]);
      setLive(body.job);
      await drive(body.job.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [drive, job, state]);

  const stop = useCallback(async () => {
    if (!live) return;
    stopped.current = true;

    await fetch("/api/admin/pipeline/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: live.id }),
    });

    setLive((current) => (current ? { ...current, status: "cancelled" } : current));
    append(["", "■ cancelling — the unit in flight finishes first."]);
  }, [append, live]);

  const set = <K extends keyof JobState>(key: K, value: JobState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

  const running = busy && live !== null && !FINISHED.has(live.status);
  const percent = live && live.total > 0 ? Math.round((live.cursor / live.total) * 100) : 0;

  if (unavailable) {
    return (
      <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        {unavailable}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS[job].map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`${job}-${field.key}`} className="text-xs">
              {field.label}
            </Label>
            <Input
              id={`${job}-${field.key}`}
              value={state[field.key]}
              inputMode={field.numeric ? "numeric" : "text"}
              placeholder={field.placeholder}
              disabled={running}
              onChange={(event) => set(field.key, event.target.value)}
              className="h-8"
            />
            <p className="text-muted-foreground text-[11px] leading-snug">
              {field.hint}
            </p>
          </div>
        ))}
      </div>

      <fieldset
        className="flex flex-wrap items-center gap-x-5 gap-y-2"
        disabled={running}
      >
        <legend className="sr-only">Run options</legend>

        <Toggle
          checked={state.dryRun}
          onChange={(value) => set("dryRun", value)}
          label="Dry run"
          hint="crawl and extract, write nothing"
        />

        {job === "extract" ? (
          <>
            <Toggle
              checked={state.datesOnly}
              onChange={(value) => set("datesOnly", value)}
              label="Dates only"
              hint="skip the profile call"
            />
            <Toggle
              checked={state.escalate}
              onChange={(value) => set("escalate", value)}
              label="Escalate"
              hint="retry empties on the next provider"
            />
            <Toggle
              checked={state.verify}
              onChange={(value) => set("verify", value)}
              label="Cross-verify dates"
              hint="reads other sources — slower"
            />
            <Toggle
              checked={state.force}
              onChange={(value) => set("force", value)}
              label="Force"
              hint="re-read unchanged rows"
            />
            <Toggle
              checked={state.fixUrls}
              onChange={(value) => set("fixUrls", value)}
              label="Repair dead URLs"
              hint="re-point a row when its page has moved"
            />
            <Toggle
              checked={state.gapFill}
              onChange={(value) => set("gapFill", value)}
              label="Second look"
              hint="go back for the fields left empty"
            />
            <Toggle
              checked={state.gapCrawl}
              onChange={(value) => set("gapCrawl", value)}
              label="Second crawl"
              hint="fetch more pages when a whole topic was missed"
            />
            <Toggle
              checked={state.staleOnly}
              onChange={(value) => set("staleOnly", value)}
              label="Stale rows only"
              hint="passed deadlines and readings over 90 days old"
            />
          </>
        ) : (
          <Toggle
            checked={state.useSitemap}
            onChange={(value) => set("useSitemap", value)}
            label="Read sitemaps"
            hint="finds awards no listing links to"
          />
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={run} disabled={running}>
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
          {running ? "Running…" : `Run ${job}`}
        </Button>

        {running && (
          <Button size="sm" variant="outline" onClick={stop}>
            <CircleStop className="size-3.5" />
            Stop
          </Button>
        )}

        {!running && live && FINISHED.has(live.status) && live.cursor < live.total && (
          <Button size="sm" variant="outline" onClick={() => drive(live.id)}>
            <RotateCw className="size-3.5" />
            Resume
          </Button>
        )}

        {!state.dryRun && !running && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Writes to the staging tables. Nothing reaches a live row until you
            apply it.
          </span>
        )}
      </div>

      {live && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span className="font-medium tabular-nums">
              {live.cursor} of {live.total}
              <span className="text-muted-foreground font-normal">
                {" "}
                {job === "extract" ? "programmes" : "seeds"} · {live.status}
              </span>
            </span>
            <span className="text-muted-foreground tabular-nums">
              {live.staged} staged · {live.failed} failed
              {live.skipped > 0 ? ` · ${live.skipped} unchanged` : ""}
            </span>
          </div>

          <div
            className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${job} progress`}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                live.status === "failed" ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <p className="border-destructive/40 text-destructive rounded-md border p-2.5 text-xs">
          {error}
        </p>
      )}

      <pre
        ref={logRef}
        aria-live="polite"
        aria-label={`${job} output`}
        className="bg-muted/60 max-h-96 min-h-32 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
      >
        {log.length > 0 ? (
          log.join("\n")
        ) : (
          <span className="text-muted-foreground flex items-center gap-2">
            <Terminal className="size-3.5" />
            Output appears here as the run progresses.
          </span>
        )}
      </pre>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      {label}
      <span className="text-muted-foreground text-xs">({hint})</span>
    </label>
  );
}
