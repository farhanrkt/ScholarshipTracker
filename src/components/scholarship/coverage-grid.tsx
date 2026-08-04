import { Check, Minus, X } from "lucide-react";

import {
  COVERAGE_KEYS,
  COVERAGE_LABELS,
  type CoverageItem,
  type CoverageMatrix,
} from "@/lib/types/database";
import { cn } from "@/lib/utils";

/**
 * Renders `coverage_matrix` as a grid rather than prose. A key that is absent
 * from the JSONB reads as "not stated", which is a different claim from
 * "not covered" — the distinction matters when you are budgeting.
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
}: {
  matrix: CoverageMatrix | null | undefined;
}) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2">
      {COVERAGE_KEYS.map((key) => {
        const item = readEntry(
          matrix && typeof matrix === "object" ? matrix[key] : undefined,
        );
        const state = item === null ? "unknown" : item.covered ? "yes" : "no";

        return (
          <div key={key} className="bg-card flex items-start gap-2.5 p-3">
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                state === "yes" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
                state === "no" && "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-400",
                state === "unknown" && "bg-muted text-muted-foreground",
              )}
            >
              {state === "yes" && <Check className="size-3" strokeWidth={3} />}
              {state === "no" && <X className="size-3" strokeWidth={3} />}
              {state === "unknown" && <Minus className="size-3" strokeWidth={3} />}
            </span>

            <div className="min-w-0">
              <dt
                className={cn(
                  "text-sm leading-tight font-medium",
                  state === "unknown" && "text-muted-foreground",
                )}
              >
                {COVERAGE_LABELS[key]}
              </dt>
              <dd className="text-muted-foreground mt-0.5 text-xs leading-snug">
                {item?.detail ??
                  (state === "unknown"
                    ? "Not stated by the programme"
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
