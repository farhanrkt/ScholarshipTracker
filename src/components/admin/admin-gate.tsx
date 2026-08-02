import Link from "next/link";
import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export interface AdminCheck {
  ok: boolean;
  email: string | null;
  isAnonymous: boolean;
  /** Which of the three preconditions failed, straight from the database. */
  verdict: string | null;
}

export async function checkAdmin(): Promise<AdminCheck> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // RLS returns nothing to non-admins regardless, so this drives the message
    // rather than the protection.
    const { data: isAdmin } = await supabase.rpc("is_admin");

    // "Reviewers only" with no reason is impossible to act on — being denied
    // for an unconfirmed email looks identical to not being on the list.
    let verdict: string | null = null;
    if (!isAdmin) {
      const { data: diagnosis } = await supabase.rpc("why_not_admin");
      verdict = diagnosis?.[0]?.verdict ?? null;
    }

    return {
      ok: Boolean(user && !user.is_anonymous && isAdmin),
      email: user?.email ?? null,
      isAnonymous: user?.is_anonymous ?? true,
      verdict,
    };
  } catch {
    return { ok: false, email: null, isAnonymous: true, verdict: null };
  }
}

export function AdminDenied({ check, what }: { check: AdminCheck; what: string }) {
  const signedIn = Boolean(check.email) && !check.isAnonymous;

  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-4 px-4 py-16">
      <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
        <Lock className="size-4.5" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">Reviewers only</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {what} It is restricted to addresses in the{" "}
        <code className="text-xs">admins</code> table.
      </p>

      {check.verdict ? (
        <p className="bg-muted/60 rounded-md p-3 text-sm leading-relaxed">
          <span className="text-muted-foreground text-xs">
            {check.email ?? "this session"}
          </span>
          <br />
          {check.verdict}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm leading-relaxed">
          {signedIn
            ? `${check.email} is not on that list.`
            : "Sign in with a linked address first."}
        </p>
      )}
      <Button
        size="sm"
        nativeButton={false}
        render={<Link href={signedIn ? "/dashboard" : "/auth/sign-in"} />}
      >
        {signedIn ? "Back to the dashboard" : "Sign in"}
      </Button>
    </div>
  );
}
