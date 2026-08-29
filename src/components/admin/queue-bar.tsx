import Link from "next/link";
import {
  BadgeCheck,
  Compass,
  Copy,
  Gauge,
  ScanSearch,
  Terminal,
} from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

/**
 * Where the work is, on every admin page.
 *
 * The four admin pages are one loop — discover finds programmes, review applies
 * what extraction read, verify is the human check — but each page only knew
 * about itself. The counts lived on the pipeline page alone, so the only way to
 * find out whether anything was waiting in review was to go and look, and the
 * verify queue had no entry point at all beyond the nav.
 *
 * Counts are `head: true` requests: Postgres returns the number and no rows.
 */

const STEPS = [
  {
    href: "/admin/pipeline",
    label: "Pipeline",
    icon: Terminal,
    description: "run the crawlers",
  },
  {
    href: "/admin/candidates",
    label: "Candidates",
    icon: Compass,
    description: "programmes with no row yet",
  },
  {
    href: "/admin/review",
    label: "Review",
    icon: ScanSearch,
    description: "proposals waiting to be applied",
  },
  {
    href: "/admin/verify",
    label: "Verify",
    icon: BadgeCheck,
    description: "rows waiting on a human",
  },
  {
    href: "/admin/duplicates",
    label: "Duplicates",
    icon: Copy,
    description: "rows that may be the same programme twice",
  },
  {
    href: "/admin/coverage",
    label: "Coverage",
    icon: Gauge,
    description: "how complete each row is, and why",
  },
] as const;

export async function AdminQueueBar({ current }: { current: string }) {
  const supabase = await createClient();

  const [candidates, extractions, toVerify] = await Promise.all([
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
      .eq("verification_status", "ai_extracted"),
  ]);

  const counts: Record<string, number | null> = {
    "/admin/pipeline": null,
    "/admin/candidates": candidates.count ?? 0,
    "/admin/review": extractions.count ?? 0,
    "/admin/verify": toVerify.count ?? 0,
    // No badge: the useful number here is recoverable BLANKS, which is a sum
    // over a view rather than a row count, and a bar of five badges stops
    // reading as "where the work is" and starts reading as decoration.
    "/admin/coverage": null,
    // No badge: counting duplicates means reading every row and comparing them
    // pairwise, and this bar renders on all five admin pages. The number is not
    // worth that on every navigation — the page itself computes it.
    "/admin/duplicates": null,
  };

  return (
    <nav
      aria-label="Admin queues"
      className="flex flex-wrap gap-2 rounded-xl border p-1.5"
    >
      {STEPS.map((step) => {
        const active = step.href === current;
        const count = counts[step.href];

        return (
          <Link
            key={step.href}
            href={step.href}
            aria-current={active ? "page" : undefined}
            title={step.description}
            className={cn(
              "hover:bg-muted focus-visible:ring-ring flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none",
              active ? "bg-muted font-medium" : "text-muted-foreground",
            )}
          >
            <step.icon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{step.label}</span>
            {count !== null && count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold tabular-nums",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {count}
                <span className="sr-only"> waiting</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
