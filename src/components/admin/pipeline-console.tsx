"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleStop, Loader2, Play, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { JobName } from "@/lib/pipeline/jobs";

/**
 * Buttons that run the crawlers, and the log they produce.
 *
 * The log is the feature, not decoration. These runs take minutes and spend a
 * rate-limited quota; a spinner that says nothing for four minutes gives an
 * operator no way to tell a slow crawl from a stuck one, and the scripts
 * already print exactly what a person needs — pages fetched per topic, what
 * grounding threw away, and why.
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
      hint: "--limit",
      numeric: true,
    },
    {
      key: "depth",
      label: "Pages per programme",
      placeholder: "16",
      hint: "--pages. More pages finds more detail and costs more time.",
      numeric: true,
    },
  ],
  discover: [
    {
      key: "filter",
      label: "Seed label contains",
      placeholder: "Chevening",
      hint: "Blank runs all 23 seeds — expect this to take a while.",
    },
    {
      key: "count",
      label: "Programmes per seed",
      placeholder: "20",
      hint: "--per-seed",
      numeric: true,
    },
    {
      key: "depth",
      label: "Listing pages per seed",
      placeholder: "8",
      hint: "--max-listing. Covers pagination and sub-indexes.",
      numeric: true,
    },
  ],
};

interface JobState {
  dryRun: boolean;
  datesOnly: boolean;
  escalate: boolean;
  filter: string;
  count: string;
  depth: string;
}

const INITIAL: JobState = {
  dryRun: true,
  datesOnly: false,
  escalate: false,
  filter: "",
  count: "",
  depth: "",
};

export function PipelineConsole({ job }: { job: JobName }) {
  const [state, setState] = useState<JobState>(INITIAL);
  const [log, setLog] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  // Follow the tail as it streams, the way a terminal does.
  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log]);

  // A crawl left running after the operator closes the tab keeps hitting other
  // people's servers. The route handler kills the child when the stream is
  // cancelled; this is what cancels it.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async () => {
    setError(null);
    setLog("");
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/admin/pipeline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          job,
          dryRun: state.dryRun,
          datesOnly: state.datesOnly,
          escalate: state.escalate,
          filter: state.filter,
          count: state.count,
          depth: state.depth,
        }),
      });

      if (!response.ok || !response.body) {
        setError((await response.text()) || `Request failed (${response.status}).`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setLog((current) => current + chunk);
      }
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [job, state]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setLog((current) => `${current}\n■ stopped.\n`);
  }, []);

  const set = <K extends keyof JobState>(key: K, value: JobState[K]) =>
    setState((current) => ({ ...current, [key]: value }));

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

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={state.dryRun}
            disabled={running}
            onCheckedChange={(value) => set("dryRun", value === true)}
          />
          Dry run
          <span className="text-muted-foreground text-xs">
            (crawl and extract, write nothing)
          </span>
        </label>

        {job === "extract" && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={state.datesOnly}
                disabled={running}
                onCheckedChange={(value) => set("datesOnly", value === true)}
              />
              Dates only
              <span className="text-muted-foreground text-xs">
                (skip the profile call)
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={state.escalate}
                disabled={running}
                onCheckedChange={(value) => set("escalate", value === true)}
              />
              Escalate
              <span className="text-muted-foreground text-xs">
                (retry empties on the paid provider)
              </span>
            </label>
          </>
        )}
      </div>

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

        {!state.dryRun && !running && (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Writes to the staging tables. Nothing reaches the live rows until
            you apply it in review.
          </span>
        )}
      </div>

      {error && (
        <p className="border-destructive/40 text-destructive rounded-md border p-2.5 text-xs">
          {error}
        </p>
      )}

      <pre
        ref={logRef}
        className="bg-muted/60 max-h-96 min-h-32 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
      >
        {log || (
          <span className="text-muted-foreground flex items-center gap-2">
            <Terminal className="size-3.5" />
            Output appears here as the run progresses.
          </span>
        )}
      </pre>
    </div>
  );
}
