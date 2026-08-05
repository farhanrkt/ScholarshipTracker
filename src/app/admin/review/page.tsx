import Link from "next/link";
import { CircleCheck, ShieldQuestion } from "lucide-react";

import { AdminDenied, checkAdmin } from "@/components/admin/admin-gate";
import { ExtractionCard } from "@/components/admin/extraction-card";
import { AdminQueueBar } from "@/components/admin/queue-bar";
import { createClient } from "@/lib/supabase/server";
import type { PendingExtraction } from "@/lib/types/extraction";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const check = await checkAdmin();

  if (!check.ok) {
    return (
      <AdminDenied
        check={check}
        what="This page applies AI-extracted dates to live scholarship rows."
      />
    );
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("scholarship_extractions")
    .select(
      "id, source_url, fetched_at, model, proposed, evidence, ungrounded_fields, caveats, page_subject, model_notes, scholarship:scholarships(id, title, country, cycle_label, opens_date, deadline_date, verification_status)",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <p className="text-destructive text-sm">{error.message}</p>
      </div>
    );
  }

  const pending = (data ?? []).filter(
    (row) => row.scholarship !== null,
  ) as unknown as PendingExtraction[];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <AdminQueueBar current="/admin/review" />

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          Extraction review
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {pending.length === 0
            ? "Nothing pending."
            : `${pending.length} proposal${pending.length === 1 ? "" : "s"} waiting. Read the quote before you apply — that is the whole point of it being there.`}
        </p>
      </header>

      {pending.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
          <CircleCheck className="size-8 opacity-50" />
          <p className="text-foreground font-medium">Queue is empty</p>
          <p className="max-w-sm text-sm">
            Run <code className="text-xs">npm run extract</code> to crawl the
            unverified programmes and stage new proposals.
          </p>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground flex gap-2 rounded-md border border-dashed p-3 text-xs leading-relaxed">
            <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" />
            Applying lands the row at <strong>ai_extracted</strong>, not
            verified. Every value here already survived the grounding check —
            its quote was found verbatim on the page — but no person has opened
            the portal. Do that in{" "}
            <Link href="/admin/verify" className="underline underline-offset-2">
              Verify
            </Link>
            , which is the only place <strong>verified</strong> comes from.
          </p>

          <div className="flex flex-col gap-4">
            {pending.map((extraction) => (
              <ExtractionCard key={extraction.id} extraction={extraction} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
