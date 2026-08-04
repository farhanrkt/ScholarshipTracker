import { CircleAlert, Link2, ShieldCheck } from "lucide-react";

import { readFieldSource } from "@/lib/field-sources";
import { AUTHORITY_LABELS, type FieldSources } from "@/lib/types/database";
import { cn } from "@/lib/utils";

/**
 * Where a value came from, said out loud on the card.
 *
 * The point of recording provenance is lost if it only ever lives in a column.
 * A deadline read off a university's page rather than the funder's own site is
 * usable information and is NOT the same claim, and the person it matters to is
 * the student deciding whether to trust it — not the reviewer.
 *
 * Three states, and the silent one is deliberate:
 *
 *   nothing rendered  the funder's own site said it and nobody contradicted it.
 *                     Adding a badge here would put a label on every card and
 *                     train people to ignore all of them.
 *   second-hand       the value rests on something other than the funder.
 *   disagreement      sources differ. This is the loudest, because it is the
 *                     only state where the number on screen might be wrong and
 *                     we know it.
 */

export function SourceNote({
  sources,
  field,
  className,
}: {
  sources: FieldSources | null | undefined;
  field: string;
  className?: string;
}) {
  const entry = readFieldSource(sources, field);
  if (!entry) return null;

  const conflicts = entry.conflicts ?? [];
  const agreed = entry.corroborated_by ?? [];

  if (conflicts.length > 0) {
    return (
      <span
        className={cn(
          "mt-1 flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] leading-snug text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100",
          className,
        )}
        title={conflicts
          .map((conflict) => `${conflict.url} says "${conflict.value}"`)
          .join("\n")}
      >
        <CircleAlert className="mt-px size-3 shrink-0" />
        <span>
          Sources disagree — {conflicts.length} other{" "}
          {conflicts.length === 1 ? "source gives" : "sources give"} a different
          answer. Shown here is {AUTHORITY_LABELS[entry.authority]}. Check the
          portal.
        </span>
      </span>
    );
  }

  if (entry.authority !== "funder") {
    return (
      <span
        className={cn(
          "text-muted-foreground mt-1 flex items-start gap-1.5 text-[11px] leading-snug",
          className,
        )}
        title={entry.source_url ?? undefined}
      >
        <Link2 className="mt-px size-3 shrink-0" />
        <span>From {AUTHORITY_LABELS[entry.authority]}, not the funder&apos;s own pages.</span>
      </span>
    );
  }

  if (agreed.length > 0) {
    return (
      <span
        className={cn(
          "mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-emerald-700 dark:text-emerald-400",
          className,
        )}
        title={agreed.map((source) => source.url).join("\n")}
      >
        <ShieldCheck className="mt-px size-3 shrink-0" />
        <span>
          Confirmed by {agreed.length} other{" "}
          {agreed.length === 1 ? "source" : "sources"}.
        </span>
      </span>
    );
  }

  return null;
}
