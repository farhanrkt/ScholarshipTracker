"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { displayCountry } from "@/lib/format";
import {
  GAP_CAUSE_LABELS,
  RECOVERABLE_GAP_CAUSES,
  type GapCause,
  type ScholarshipCompleteness,
} from "@/lib/types/database";
import { cn } from "@/lib/utils";

/**
 * One row of `scholarship_completeness` (migration 016).
 *
 * Aliased rather than redeclared: a second hand-written copy of a view's shape
 * is a copy that drifts, and this one would drift silently — every field is a
 * number, so a mismatch reads as a wrong figure rather than a type error.
 */
export type CompletenessRow = ScholarshipCompleteness;

/**
 * Rendered defensively for the same reason every other consumer here is: this
 * is a view over JSONB Postgres does not police, and `gap_causes` is absent on
 * every row read before migration 016. A missing diagnosis is "we do not know
 * why these are blank", which is a different and more honest thing to show than
 * an empty list implying there is nothing to fix.
 */
function readCauses(
  value: CompletenessRow["gap_causes"],
): Array<[string, GapCause]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, GapCause] => typeof entry[1] === "string")
    .sort(([fieldA, causeA], [fieldB, causeB]) => {
      // Recoverable first — this list is a worklist, not an inventory.
      const rankA = RECOVERABLE_GAP_CAUSES.includes(causeA) ? 0 : 1;
      const rankB = RECOVERABLE_GAP_CAUSES.includes(causeB) ? 0 : 1;
      return rankA - rankB || fieldA.localeCompare(fieldB);
    });
}

export function CoverageRow({ row }: { row: CompletenessRow }) {
  const [open, setOpen] = useState(false);

  const causes = readCauses(row.gap_causes);
  const total = row.total || 25;
  const percent = total > 0 ? Math.round((row.filled / total) * 100) : 0;

  return (
    <div className="bg-card rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="hover:bg-muted/40 flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors"
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{row.title}</span>
            <Badge variant="outline" className="text-xs">
              {displayCountry(row.country)}
            </Badge>
            {row.recoverable > 0 ? (
              <Badge variant="secondary" className="text-xs">
                {row.recoverable} recoverable
              </Badge>
            ) : (
              causes.length > 0 && (
                <Badge variant="outline" className="text-muted-foreground text-xs">
                  nothing left to recover
                </Badge>
              )
            )}
          </div>

          <div className="mt-2 flex items-center gap-2">
            <Progress value={percent} className="h-1.5 max-w-48" />
            <span className="text-muted-foreground text-xs tabular-nums">
              {row.filled}/{total} filled
              {row.not_stated_count > 0 &&
                ` · ${row.not_stated_count} not published`}
            </span>
          </div>
        </div>

        <ChevronDown
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t p-3">
          {causes.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No diagnosis recorded. This row was last read before the pipeline
              started reporting why a field is empty — re-run extraction over it
              to find out.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {causes.map(([field, cause]) => (
                <li
                  key={field}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-2 text-xs"
                >
                  <span className="font-mono">{field}</span>
                  <span
                    className={cn(
                      "text-right",
                      RECOVERABLE_GAP_CAUSES.includes(cause)
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-muted-foreground",
                    )}
                  >
                    {GAP_CAUSE_LABELS[cause] ?? cause}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <a
            href={row.official_portal_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground mt-3 inline-flex items-center gap-1 text-xs underline underline-offset-2"
          >
            Open the programme page
            <ExternalLink className="size-3" />
          </a>
        </div>
      )}
    </div>
  );
}
