"use client";

import { useState, useTransition } from "react";
import { Ghost, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { linkEmailToAccount } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AnonymousBannerClient() {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();

  if (dismissed) return null;

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await linkEmailToAccount(formData);

      if (!result.success) {
        toast.error("Could not link your email", { description: result.error });
        return;
      }

      toast.success("Check your inbox", {
        description: `We sent a confirmation link to ${result.data?.email}. Your saved scholarships stay exactly where they are, and you can sign in with this address on any other device.`,
      });
      setExpanded(false);
    });
  }

  return (
    /* The accent family, not amber.
     *
     * This was `bg-amber-50 / text-amber-950`, which made it the loudest band
     * on every page in the app for a message that is an INVITATION — link an
     * email, keep your tracker — not a warning. It also collided head-on with
     * meaning: amber is the caution colour here, worn by "Cycle has rolled
     * over" and "may be out of date", so the same hue was saying "check this"
     * on a chip and "hello, here is a tip" on a full-width bar six pixels
     * above it.
     *
     * The accent is the right family precisely because the bar asks for an
     * action, and it is quiet enough at this tint to sit under the header
     * without competing with the scholarships underneath. */
    <div className="bg-accent text-accent-foreground border-b">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm sm:px-6">
        <Ghost className="size-4 shrink-0 opacity-70" />

        {/* Two lengths of the same sentence. The full version ran to four lines
            on a phone, pushing the actual scholarships below the fold on the
            page whose entire job is showing them. */}
        <p className="min-w-0">
          <span className="hidden sm:inline">
            You are browsing anonymously. Everything you track is saved to this
            browser only.{" "}
          </span>
          <span className="sm:hidden">Saved to this browser only. </span>
          {!expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="focus-visible:ring-ring rounded font-semibold underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
            >
              Link an email
            </button>
          )}
          {!expanded && (
            <span className="hidden sm:inline">
              {" "}
              to keep your progress permanently.
            </span>
          )}
        </p>

        {expanded && (
          <form action={handleSubmit} className="flex flex-1 items-center gap-2">
            <Input
              type="email"
              name="email"
              required
              autoFocus
              placeholder="you@university.edu"
              aria-label="Email address"
              className="h-8 max-w-64 bg-white dark:bg-black/20"
            />
            <Button type="submit" size="sm" className="h-8" disabled={pending}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              Send link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => setExpanded(false)}
            >
              Cancel
            </Button>
          </form>
        )}

        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="ml-auto rounded p-1 opacity-60 transition-opacity hover:opacity-100"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
