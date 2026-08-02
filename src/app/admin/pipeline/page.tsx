import Link from "next/link";
import { Compass, ExternalLink, ScanSearch, ShieldQuestion } from "lucide-react";

import { AdminDenied, checkAdmin } from "@/components/admin/admin-gate";
import { PipelineConsole } from "@/components/admin/pipeline-console";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Operator console for the two crawlers.
 *
 * Deliberately one page with both jobs on it, because they are two halves of
 * one loop: discovery finds programmes and stages candidates, extraction fills
 * those candidates in. Splitting them across two pages would hide that, and
 * the counts below are what tell you which half to run next.
 */
export default async function PipelinePage() {
  const check = await checkAdmin();

  if (!check.ok) {
    return (
      <AdminDenied
        check={check}
        what="This page runs the discovery and extraction crawlers."
      />
    );
  }

  const supabase = await createClient();

  const [candidates, extractions, unverified] = await Promise.all([
    supabase
      .from("scholarship_candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("scholarship_extractions")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("scholarships")
      .select("id", { count: "exact", head: true })
      .neq("verification_status", "verified"),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          Run the crawlers and watch them work. Everything either job produces
          lands in a staging table — nothing reaches a live scholarship row
          until you apply it in review.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Candidates waiting"
          value={candidates.count ?? 0}
          href="/admin/candidates"
        />
        <Stat
          label="Extractions waiting"
          value={extractions.count ?? 0}
          href="/admin/review"
        />
        <Stat label="Rows not yet verified" value={unverified.count ?? 0} />
      </div>

      <section className="flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="bg-muted mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg">
            <ScanSearch className="size-4" />
          </span>
          <div>
            <h2 className="font-semibold tracking-tight">Extraction</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Crawls each unverified programme&rsquo;s own site and reads its
              cycle dates, then what the award covers, who may apply and what
              they must submit. Two model calls per programme, both
              quote-checked.
            </p>
          </div>
        </div>
        <PipelineConsole job="extract" />
      </section>

      <section className="flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="bg-muted mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg">
            <Compass className="size-4" />
          </span>
          <div>
            <h2 className="font-semibold tracking-tight">Discovery</h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Expands the seed list — following pagination and sub-indexes —
              and classifies what it finds. Never writes dates: a promoted
              candidate is a dateless skeleton that extraction fills in.
            </p>
          </div>
        </div>
        <PipelineConsole job="discover" />
      </section>

      <p className="text-muted-foreground flex gap-2 rounded-md border border-dashed p-3 text-xs leading-relaxed">
        <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" />
        These buttons spawn the same scripts as{" "}
        <code className="text-[11px]">npm run extract</code> and{" "}
        <code className="text-[11px]">npm run discover</code>, on the machine
        serving this page. That works in local development, where the repo and
        your <code className="text-[11px]">.env.local</code> are on disk. A
        deployed serverless instance has neither, so the runner refuses there
        instead of failing mid-crawl — run the scripts from a terminal in that
        case.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href?: string;
}) {
  const body = (
    <>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        {label}
        {href && <ExternalLink className="size-3" />}
      </span>
    </>
  );

  const className =
    "flex flex-col gap-0.5 rounded-lg border p-3" +
    (href ? " hover:bg-muted/50 transition-colors" : "");

  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
