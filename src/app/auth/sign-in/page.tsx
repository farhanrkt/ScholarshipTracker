import Link from "next/link";
import { CircleAlert, Mail } from "lucide-react";

import { SignInForm } from "@/components/auth/sign-in-form";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reason?: string }>;
}) {
  const { error, reason } = await searchParams;

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-16">
      <header className="flex flex-col gap-2">
        <span className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg">
          <Mail className="size-4.5" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">
          Sign in to your tracker
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Enter the email you linked and we will send you a sign-in link. No
          password — the link is the whole thing.
        </p>
      </header>

      {error === "invalid" && (
        <div className="flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-100">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="leading-relaxed">
            <p>
              That link did not work. Links are single-use and expire — always
              open the most recent email.
            </p>
            {reason && (
              <p className="mt-1 text-xs opacity-80">{reason}</p>
            )}
          </div>
        </div>
      )}

      <SignInForm />

      <div className="text-muted-foreground border-t pt-4 text-xs leading-relaxed">
        <p className="mb-2">
          <strong className="text-foreground font-medium">
            Never linked an email?
          </strong>{" "}
          Then there is nothing to sign in to yet — your tracker lives in this
          browser only. Open the dashboard and link one from the banner at the
          top.
        </p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          Back to the dashboard
        </Button>
      </div>
    </div>
  );
}
