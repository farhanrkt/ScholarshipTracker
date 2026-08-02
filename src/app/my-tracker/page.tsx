import Link from "next/link";
import { BookmarkPlus, CircleCheck, CircleAlert } from "lucide-react";

import { AnonymousBanner } from "@/components/anonymous-banner";
import { TrackerCard } from "@/components/tracker/tracker-card";
import { Button } from "@/components/ui/button";
import { fetchUserTargets } from "@/lib/data/targets";
import { describeWindow, summariseChecklist } from "@/lib/format";
import { currentAccount } from "@/lib/supabase/account";

export const dynamic = "force-dynamic";

export default async function MyTrackerPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string }>;
}) {
  const [targets, params, account] = await Promise.all([
    fetchUserTargets(),
    searchParams,
    currentAccount(),
  ]);

  // `?linked=ok` is a claim made by a URL, and a URL is not evidence. Ask the
  // session instead: a real, non-anonymous user is what "signed in" means.
  const signedIn = account.signedIn;
  const signedInAs = account.email;

  const totalRequired = targets.reduce((sum, target) => {
    const stats = summariseChecklist(
      target.scholarship.document_checklist,
      target.checklist_progress ?? {},
    );
    return sum + stats.requiredTotal;
  }, 0);

  const readyRequired = targets.reduce((sum, target) => {
    const stats = summariseChecklist(
      target.scholarship.document_checklist,
      target.checklist_progress ?? {},
    );
    return sum + stats.requiredCompleted;
  }, 0);

  // Only rows with a real, still-open closing date can claim a "next deadline".
  const nextDeadline = targets
    .map((target) => describeWindow(target.scholarship))
    .filter((window) => window.daysUntilClose !== null && window.daysUntilClose >= 0)
    .sort((a, b) => (a.daysUntilClose ?? 0) - (b.daysUntilClose ?? 0))[0];

  return (
    <>
      <AnonymousBanner />

      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        {params.linked === "ok" && signedIn && (
          <p className="mb-4 flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
            <CircleCheck className="size-4 shrink-0" />
            You are signed in{signedInAs ? ` as ${signedInAs}` : ""}. This
            tracker is saved to your account, so it follows you to any device —
            sign in there with the same address.
          </p>
        )}

        {/* A URL that CLAIMS success while the session says otherwise. Someone
            re-opened an old link, or the cookies did not stick. Saying nothing
            would leave them believing the banner they saw a moment ago. */}
        {params.linked === "ok" && !signedIn && (
          <p className="mb-4 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            <CircleAlert className="size-4 shrink-0" />
            You are <strong>not</strong> signed in — this browser is still using
            a temporary account. Request a fresh link and open the newest email.{" "}
            <Link href="/auth/sign-in" className="underline underline-offset-4">
              Sign in
            </Link>
          </p>
        )}
        {params.linked === "invalid" && (
          <p className="mb-4 flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-100">
            <CircleAlert className="size-4 shrink-0" />
            That confirmation link is invalid or has expired. Request a new one
            from the banner above.
          </p>
        )}

        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">My tracker</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {targets.length === 0
              ? "Nothing tracked yet."
              : `${targets.length} ${targets.length === 1 ? "application" : "applications"} · ${readyRequired}/${totalRequired} required documents ready${
                  nextDeadline ? ` · next deadline ${nextDeadline.relative}` : ""
                }`}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            Dates shown are only as good as their last check — open a card to see
            whether it has been verified.
          </p>
        </header>

        {targets.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-20 text-center">
            <BookmarkPlus className="size-8 opacity-50" />
            <div>
              <p className="text-foreground font-medium">
                Your tracker is empty
              </p>
              <p className="mt-1 max-w-sm text-sm">
                Track a scholarship and its document checklist appears here,
                ready to tick off.
              </p>
            </div>
            <Button
              size="sm"
              nativeButton={false}
              render={<Link href="/dashboard" />}
            >
              Browse scholarships
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {targets.map((target) => (
              <TrackerCard key={target.id} target={target} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
