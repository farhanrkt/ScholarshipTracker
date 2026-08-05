import { CircleCheck, Compass } from "lucide-react";

import { AdminDenied, checkAdmin } from "@/components/admin/admin-gate";
import { CandidateCard } from "@/components/admin/candidate-card";
import { AdminQueueBar } from "@/components/admin/queue-bar";
import { createClient } from "@/lib/supabase/server";
import type { ScholarshipCandidate } from "@/lib/types/database";

export const dynamic = "force-dynamic";

export default async function CandidatesPage() {
  const check = await checkAdmin();

  if (!check.ok) {
    return (
      <AdminDenied
        check={check}
        what="This page creates new scholarship rows from discovered pages."
      />
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("scholarship_candidates")
    .select("*")
    .eq("status", "pending")
    .order("confidence", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <p className="text-destructive text-sm">{error.message}</p>
      </div>
    );
  }

  const pending = (data ?? []) as ScholarshipCandidate[];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <AdminQueueBar current="/admin/candidates" />

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Discovered candidates
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {pending.length === 0
            ? "Nothing pending."
            : `${pending.length} programme${pending.length === 1 ? "" : "s"} found that we have no row for.`}
        </p>
      </header>

      {pending.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
          <CircleCheck className="size-8 opacity-50" />
          <p className="text-foreground font-medium">Queue is empty</p>
          <p className="max-w-sm text-sm">
            Run <code className="text-xs">npm run discover</code> to crawl the
            seed index pages in{" "}
            <code className="text-xs">scripts/discover/seeds.ts</code>.
          </p>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground flex gap-2 rounded-md border border-dashed p-3 text-xs leading-relaxed">
            <Compass className="mt-0.5 size-3.5 shrink-0" />
            Promoting creates a <strong>dateless, unverified</strong> row.
            Discovery only establishes that a programme exists — no date here
            has been checked, because discovery is not allowed to write any.
            Run <code>npm run extract</code> afterwards to fill them in with
            quotes attached.
          </p>

          <div className="flex flex-col gap-4">
            {pending.map((candidate) => (
              <CandidateCard key={candidate.id} candidate={candidate} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
