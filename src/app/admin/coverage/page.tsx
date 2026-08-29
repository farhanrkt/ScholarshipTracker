import Link from "next/link";
import { CircleCheck, Gauge } from "lucide-react";

import { AdminDenied, checkAdmin } from "@/components/admin/admin-gate";
import { AdminQueueBar } from "@/components/admin/queue-bar";
import { CoverageRow, type CompletenessRow } from "@/components/admin/coverage-row";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The backlog, ordered by what is actually fixable.
 *
 * WHY THIS PAGE EXISTS. "Improve coverage" was an unfalsifiable goal. The only
 * completeness figure anywhere was a line in a run log — `12/25 field(s)
 * filled` — which scrolled past, applied to one programme, and said nothing
 * about the thirteen blanks it was reporting. So there was no way to answer the
 * two questions that decide what to do next: which rows are worst, and is a
 * given row worth re-running or already finished?
 *
 * Those are different questions and the second is the important one. A row with
 * six of twenty-five filled whose every blank is `not-published` is DONE — the
 * funder does not publish the rest, and no amount of crawling will change that.
 * A row with eighteen filled and four `never-crawled` has recoverable work in
 * it. Sorting by emptiness alone puts the finished row at the top and sends an
 * operator to re-run the one case that cannot improve.
 *
 * So the sort is on `recoverable` — blanks the last reading blamed on the
 * pipeline rather than on the funder — which is exactly the number that should
 * fall between runs, and the only honest definition of progress here.
 */
export default async function CoveragePage() {
  const check = await checkAdmin();

  if (!check.ok) {
    return (
      <AdminDenied
        check={check}
        what="This page reports how complete each scholarship row is, and why."
      />
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("scholarship_completeness")
    .select("*")
    .order("recoverable", { ascending: false })
    .order("filled", { ascending: true })
    .limit(200);

  const rows: CompletenessRow[] = data ?? [];

  const totals = rows.reduce(
    (sum, row) => ({
      filled: sum.filled + (row.filled ?? 0),
      total: sum.total + (row.total ?? 0),
      recoverable: sum.recoverable + (row.recoverable ?? 0),
      notStated: sum.notStated + (row.not_stated_count ?? 0),
    }),
    { filled: 0, total: 0, recoverable: 0, notStated: 0 },
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <AdminQueueBar current="/admin/coverage" />

      <header className="mt-6 mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Gauge className="size-5" />
          Coverage
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          How much of each row is filled, and — for the rest — whether the
          pipeline could have filled it. Sorted by what is recoverable, because
          a row whose blanks are all &ldquo;not published&rdquo; is finished
          however empty it looks.
        </p>
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          Could not read the completeness view ({error.message}). Apply{" "}
          <code className="font-mono text-xs">
            supabase/migrations/016_not_stated_and_gap_causes.sql
          </code>
          , then run the pipeline once so a reading records its diagnosis.
        </p>
      )}

      {rows.length > 0 && (
        <dl className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          <Stat label="Rows" value={String(rows.length)} />
          <Stat
            label="Fields filled"
            value={
              totals.total > 0
                ? `${Math.round((totals.filled / totals.total) * 100)}%`
                : "—"
            }
            hint={`${totals.filled} of ${totals.total}`}
          />
          <Stat
            label="Recoverable blanks"
            value={String(totals.recoverable)}
            hint="the pipeline could have found these"
          />
          <Stat
            label="Not published"
            value={String(totals.notStated)}
            hint="read, and the funder is silent"
          />
        </dl>
      )}

      {rows.length === 0 && !error ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
          <CircleCheck className="size-8 opacity-50" />
          <p className="text-foreground font-medium">Nothing to report yet</p>
          <p className="max-w-sm text-sm">
            Run the pipeline from{" "}
            <Link href="/admin/pipeline" className="underline underline-offset-4">
              the console
            </Link>{" "}
            — each reading records why every field it left empty is empty.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <CoverageRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="bg-card p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-muted-foreground text-xs">{hint}</dd>}
    </div>
  );
}

export const metadata = {
  title: "Coverage — ScholarTrack admin",
};
