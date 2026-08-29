import { Check, CircleHelp, Minus, X } from "lucide-react";

import { NOT_STATED_LABEL, UNKNOWN_LABEL } from "@/lib/format";
import {
  COVERAGE_KEYS,
  COVERAGE_LABELS,
  type CoverageItem,
  type CoverageMatrix,
} from "@/lib/types/database";
import { cn } from "@/lib/utils";

/**
 * Renders `coverage_matrix` as a grid rather than prose. A key that is absent
 * from the JSONB is not "not covered" — the distinction matters when you are
 * budgeting a year abroad.
 *
 * THREE STATES OF ABSENCE, not one. This grid used to print "Not stated by the
 * programme" for every missing key, which was a claim about the funder made on
 * the strength of a key nothing had written. On a row promoted from discovery
 * and never crawled, all eight lines said it — eight confident statements about
 * eight pages nobody had opened. `not_stated` (migration 016) is the list of
 * fields a reading actually reached and found silent, so the two are now told
 * apart: silence the pipeline verified, and silence that is just our own.
 *
 * That distinction is also why the guard below is stricter than it looks. A
 * malformed entry — `tuition: true` instead of `{ covered: true }` — has an
 * undefined `.covered`, which would render as a confident "Not covered": a
 * claim about someone's funding that nothing on the page supports. Anything
 * that is not a well-formed entry falls back to "not stated", because not
 * knowing is the only honest reading of a value we cannot parse.
 */
function readEntry(value: unknown): { covered: boolean; detail: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<CoverageItem>;
  if (typeof item.covered !== "boolean") return null;
  return {
    covered: item.covered,
    detail: typeof item.detail === "string" && item.detail.trim() ? item.detail : null,
  };
}

export function CoverageGrid({
  matrix,
  notStated,
}: {
  matrix: CoverageMatrix | null | undefined;
  /** `scholarships.not_stated`. Absent on rows read before migration 016. */
  notStated?: string[] | null;
}) {
  const silent = new Set(Array.isArray(notStated) ? notStated : []);

  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
      {COVERAGE_KEYS.map((key) => {
        const item = readEntry(
          matrix && typeof matrix === "object" ? matrix[key] : undefined,
        );
        const state =
          item !== null
            ? item.covered
              ? "yes"
              : "no"
            : silent.has(`coverage.${key}`)
              ? "silent"
              : "unknown";

        return (
          <div key={key} className="bg-card flex items-start gap-2.5 p-3">
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                state === "yes" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
                state === "no" && "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400",
                state === "silent" && "bg-muted text-muted-foreground",
                state === "unknown" && "bg-muted/60 text-muted-foreground/70",
              )}
            >
              {state === "yes" && <Check className="size-3" strokeWidth={3} />}
              {state === "no" && <X className="size-3" strokeWidth={3} />}
              {state === "silent" && <Minus className="size-3" strokeWidth={3} />}
              {/* A different mark for a different claim: a dash is the
                  programme declining to say, a question mark is us not having
                  asked. Rendering both as a dash is what made the two
                  indistinguishable in the first place. */}
              {state === "unknown" && <CircleHelp className="size-3" strokeWidth={3} />}
            </span>

            <div className="min-w-0">
              <dt
                className={cn(
                  "text-sm leading-tight font-medium",
                  (state === "silent" || state === "unknown") &&
                    "text-muted-foreground",
                )}
              >
                {COVERAGE_LABELS[key]}
              </dt>
              <dd className="text-muted-foreground mt-0.5 text-xs leading-snug">
                {item?.detail ??
                  (state === "silent"
                    ? NOT_STATED_LABEL
                    : state === "unknown"
                      ? UNKNOWN_LABEL
                      : state === "no"
                        ? "Not covered"
                        : "Covered")}
              </dd>
            </div>
          </div>
        );
      })}
    </dl>
  );
}
