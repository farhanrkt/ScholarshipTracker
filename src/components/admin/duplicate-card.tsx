"use client";

import { useMemo, useState, useTransition } from "react";
import { ExternalLink, GitMerge, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { mergeScholarships } from "@/app/actions/review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DuplicateCluster, DuplicateRow } from "@/lib/duplicates";
import { cn } from "@/lib/utils";

/**
 * One group of rows that might be one programme.
 *
 * The interaction is deliberately not "merge all". Merging ends in a DELETE,
 * and the detector is a string comparison that cannot tell
 * `Distinguished Humphrey Fellowship Program` from a longer way of writing
 * `Humphrey Fellowship Program` — one of those is a different award. So a
 * reviewer picks the row to keep and then folds the others in ONE AT A TIME,
 * each with its own button and its own reason on screen.
 */

const CONFIDENCE_STYLES = {
  certain:
    "border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-200",
  likely:
    "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-200",
  possible: "border-dashed text-muted-foreground",
} as const;

const STATUS_LABELS: Record<string, string> = {
  verified: "verified by a human",
  ai_extracted: "read by the pipeline",
  unverified: "nothing has read it",
};

export function DuplicateCard({ cluster }: { cluster: DuplicateCluster }) {
  const [pending, startTransition] = useTransition();
  const [keepId, setKeepId] = useState(cluster.suggestedKeep.id);
  const [merged, setMerged] = useState<string[]>([]);

  const keep = cluster.rows.find((row) => row.id === keepId) ?? cluster.suggestedKeep;
  const others = cluster.rows.filter(
    (row) => row.id !== keepId && !merged.includes(row.id),
  );

  /** Why THIS row was paired with the one being kept. */
  const reasonAgainstKeep = useMemo(() => {
    const map = new Map<string, string>();
    for (const pair of cluster.pairs) {
      if (pair.a.id === keepId) map.set(pair.b.id, `${pair.confidence} — ${pair.reason}`);
      if (pair.b.id === keepId) map.set(pair.a.id, `${pair.confidence} — ${pair.reason}`);
    }
    return map;
  }, [cluster.pairs, keepId]);

  function handleMerge(row: DuplicateRow) {
    startTransition(async () => {
      const result = await mergeScholarships(keepId, row.id);
      if (!result.success) {
        toast.error("Could not merge", { description: result.error });
        return;
      }
      setMerged((done) => [...done, row.id]);
      toast.success(`Merged into ${keep.title}`, {
        description: "Trackers, sources and extraction history moved across.",
      });
    });
  }

  if (others.length === 0) {
    return (
      <article className="text-muted-foreground bg-muted/40 flex items-center gap-2 rounded-xl border border-dashed p-4 text-sm">
        <GitMerge className="size-4 shrink-0" />
        <span>
          Merged into <strong className="text-foreground">{keep.title}</strong>.
        </span>
      </article>
    );
  }

  return (
    <article className="flex flex-col gap-4 rounded-xl border p-4">
      <header className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={CONFIDENCE_STYLES[cluster.confidence]}>
          {cluster.confidence}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {cluster.rows.length} rows on this site
        </span>
      </header>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-muted-foreground mb-2 text-xs">
          Keep which row? Everything the others carry moves into it.
        </legend>

        {cluster.rows.map((row) => {
          const isKept = row.id === keepId;
          const isMerged = merged.includes(row.id);

          return (
            <label
              key={row.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors",
                isKept && "border-foreground/30 bg-muted/60",
                isMerged && "opacity-40",
              )}
            >
              <input
                type="radio"
                name={`keep-${cluster.rows[0]!.id}`}
                checked={isKept}
                disabled={isMerged || pending}
                onChange={() => setKeepId(row.id)}
                className="mt-1 shrink-0"
              />

              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium">
                  {row.title}
                  {isMerged && " — merged"}
                </span>

                <span className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                  <span>{STATUS_LABELS[row.verification_status] ?? row.verification_status}</span>
                  <span>{row.deadline_date ?? "no deadline"}</span>
                  {row.is_profiled && <span>profiled</span>}
                </span>

                {!isKept && reasonAgainstKeep.has(row.id) && (
                  <span className="text-muted-foreground text-xs italic">
                    {reasonAgainstKeep.get(row.id)}
                  </span>
                )}
                {!isKept && !reasonAgainstKeep.has(row.id) && (
                  <span className="text-muted-foreground text-xs italic">
                    linked through another row in this group, not directly
                  </span>
                )}

                <a
                  href={row.official_portal_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs break-all underline-offset-2 hover:underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {row.official_portal_url}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-2">
        {others.map((row) => (
          <Button
            key={row.id}
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => handleMerge(row)}
            className="justify-start"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            <span className="truncate">
              Fold “{row.title}” into “{keep.title}”
            </span>
          </Button>
        ))}
      </div>

      <p className="text-muted-foreground text-xs leading-relaxed">
        This deletes the folded row. Anyone tracking it keeps their place — their
        saved programme, status and ticked documents move to the row you keep.
      </p>
    </article>
  );
}
