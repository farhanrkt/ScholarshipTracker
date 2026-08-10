import { CircleCheck, Copy } from "lucide-react";

import { AdminDenied, checkAdmin } from "@/components/admin/admin-gate";
import { DuplicateCard } from "@/components/admin/duplicate-card";
import { AdminQueueBar } from "@/components/admin/queue-bar";
import { findDuplicates, type DuplicateRow } from "@/lib/duplicates";
import { createClient } from "@/lib/supabase/server";

/**
 * Rows that look like the same programme twice.
 *
 * Discovery dedupes on an exact normalised title, so the catalogue accumulated
 * `Chevening Scholarship` beside `Chevening Scholarships`, and three separate
 * Humphrey rows. A student scrolling the dashboard meets the same award
 * repeatedly and cannot tell which entry is the one to track.
 *
 * The whole comparison happens in memory rather than in SQL: it is pairwise
 * over the catalogue, which is the kind of thing Postgres does badly and a pure
 * function does clearly — and a pure function is testable, which matters more
 * here than speed. At this size it is a single SELECT and a few thousand string
 * comparisons.
 */

export const dynamic = "force-dynamic";

export default async function DuplicatesPage() {
  const check = await checkAdmin();

  if (!check.ok) {
    return (
      <AdminDenied
        check={check}
        what="This page merges scholarship rows that are the same programme twice."
      />
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("scholarships")
    .select(
      "id, title, country, official_portal_url, verification_status, is_profiled, deadline_date, created_at",
    );

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <p className="text-destructive text-sm">{error.message}</p>
      </div>
    );
  }

  const clusters = findDuplicates((data ?? []) as DuplicateRow[]);
  const rows = clusters.reduce((sum, cluster) => sum + cluster.rows.length, 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <AdminQueueBar current="/admin/duplicates" />

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Possible duplicates</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {clusters.length === 0
            ? "Nothing looks duplicated."
            : `${clusters.length} group${clusters.length === 1 ? "" : "s"} covering ${rows} rows.`}
        </p>
      </header>

      {clusters.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
          <CircleCheck className="size-8 opacity-50" />
          <p className="text-foreground font-medium">No duplicates found</p>
          <p className="max-w-sm text-sm">
            Every row has a distinct title, or sits on a site of its own.
          </p>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground flex gap-2 rounded-md border border-dashed p-3 text-xs leading-relaxed">
            <Copy className="mt-0.5 size-3.5 shrink-0" />
            These are <strong>suggestions from a string comparison</strong>, not
            findings. It cannot tell a genuinely separate award from a longer way
            of writing the same name — a “Distinguished” or “SIDS” variant is
            often its own programme with its own eligibility. Open both pages
            before folding one into the other, and leave the group alone if they
            differ.
          </p>

          <div className="flex flex-col gap-4">
            {clusters.map((cluster) => (
              <DuplicateCard key={cluster.rows[0]!.id} cluster={cluster} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
