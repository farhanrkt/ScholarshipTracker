import Link from "next/link";
import { BadgeCheck, CircleCheck } from "lucide-react";

import { AdminDenied, checkAdmin } from "@/components/admin/admin-gate";
import { AdminQueueBar } from "@/components/admin/queue-bar";
import {
  VerifyCard,
  type VerifiableScholarship,
} from "@/components/admin/verify-card";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import type { FieldEvidence } from "@/lib/types/extraction";

export const dynamic = "force-dynamic";

/**
 * The human half of the trust model, which until now had no interface at all.
 *
 * Everything upstream of this page is a machine's opinion: discovery says a
 * programme exists, extraction says the page states these dates and quotes the
 * page to prove it, and both land the row at `ai_extracted`. Nothing in the
 * pipeline is allowed to write `verified` — by design, since the whole point of
 * the status is that a person looked. So somebody had to, and the only way to
 * do it was an UPDATE typed into the SQL editor. Predictably, exactly one row
 * ever got verified.
 *
 * The queue is ordered the way the work should be done: rows a model has
 * already read come first, because those cost one glance at the portal to
 * confirm, and rows nobody has read at all come after.
 */

const TABS = [
  { key: "ai_extracted", label: "AI-extracted" },
  { key: "unverified", label: "Never checked" },
  { key: "verified", label: "Verified" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function isTab(value: unknown): value is TabKey {
  return TABS.some((tab) => tab.key === value);
}

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const check = await checkAdmin();

  if (!check.ok) {
    return (
      <AdminDenied
        check={check}
        what="This page records that a human has confirmed a scholarship against its official page."
      />
    );
  }

  const params = await searchParams;
  const requested = Array.isArray(params.status) ? params.status[0] : params.status;
  const active: TabKey = isTab(requested) ? requested : "ai_extracted";

  const supabase = await createClient();

  const [{ data, error }, { data: counts }] = await Promise.all([
    supabase
      .from("scholarships")
      .select(
        "id, title, country, official_portal_url, source_url, cycle_label, opens_date, deadline_date, verification_status, last_verified_at, is_profiled",
      )
      .eq("verification_status", active)
      // Soonest deadline first within the tab: a programme closing in three
      // weeks is worth confirming before one closing in eight months.
      .order("deadline_date", { ascending: true, nullsFirst: false })
      .order("title", { ascending: true })
      .limit(100),
    supabase.from("scholarships").select("verification_status"),
  ]);

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <p className="text-destructive text-sm">{error.message}</p>
      </div>
    );
  }

  const rows = data ?? [];

  /**
   * The quotes behind these dates, pulled from the extraction that wrote them.
   *
   * Fetched as one query for the whole page rather than per row, and reduced to
   * the newest per scholarship. Without the quote a reviewer is being asked to
   * confirm a date with no idea what the machine actually read, which is not
   * verification — it is rubber-stamping.
   */
  const evidenceByScholarship = new Map<
    string,
    { evidence: Record<string, FieldEvidence>; model: string }
  >();

  if (rows.length > 0) {
    const { data: applied } = await supabase
      .from("scholarship_extractions")
      .select("scholarship_id, evidence, model, created_at")
      .eq("status", "applied")
      .in(
        "scholarship_id",
        rows.map((row) => row.id),
      )
      .order("created_at", { ascending: false });

    for (const row of applied ?? []) {
      if (evidenceByScholarship.has(row.scholarship_id)) continue;
      evidenceByScholarship.set(row.scholarship_id, {
        evidence: (row.evidence ?? {}) as Record<string, FieldEvidence>,
        model: row.model,
      });
    }
  }

  const tally = (counts ?? []).reduce<Record<string, number>>((acc, row) => {
    acc[row.verification_status] = (acc[row.verification_status] ?? 0) + 1;
    return acc;
  }, {});

  const scholarships: VerifiableScholarship[] = rows.map((row) => {
    const extraction = evidenceByScholarship.get(row.id);
    return {
      ...row,
      evidence: extraction?.evidence ?? {},
      extractedBy: extraction?.model ?? null,
    } as VerifiableScholarship;
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <AdminQueueBar current="/admin/verify" />

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Verification</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Open the portal, read the dates, and record what you found. This is
          the only place <strong>verified</strong> comes from — no crawler is
          allowed to write it.
        </p>
      </header>

      <nav className="flex flex-wrap gap-1 text-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/admin/verify?status=${tab.key}`}
            aria-current={tab.key === active ? "page" : undefined}
            className={cn(
              "hover:bg-muted flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors",
              tab.key === active
                ? "bg-muted font-medium"
                : "text-muted-foreground",
            )}
          >
            {tab.label}
            <span className="text-muted-foreground text-xs tabular-nums">
              {tally[tab.key] ?? 0}
            </span>
          </Link>
        ))}
      </nav>

      {scholarships.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-16 text-center">
          <CircleCheck className="size-8 opacity-50" />
          <p className="text-foreground font-medium">Nothing in this queue</p>
          <p className="max-w-sm text-sm">
            {active === "ai_extracted"
              ? "No rows are waiting on a human. Apply some proposals in review, or run npm run extract to make more."
              : active === "unverified"
                ? "Every row has been read by something. The AI-extracted tab is where the human work is."
                : "Nothing has been verified yet. Start with the AI-extracted tab — those rows already have quotes to check against."}
          </p>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground flex gap-2 rounded-md border border-dashed p-3 text-xs leading-relaxed">
            <BadgeCheck className="mt-0.5 size-3.5 shrink-0" />
            Marking a row verified stamps it with today&rsquo;s date and tells
            every student who sees it that a person checked. It goes stale on
            its own after 90 days, and the moment its deadline passes — neither
            of those needs undoing by hand.
          </p>

          <div className="flex flex-col gap-4">
            {scholarships.map((scholarship) => (
              <VerifyCard key={scholarship.id} scholarship={scholarship} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
