"use client";

import { useState, useTransition } from "react";
import { CircleCheck, Loader2 } from "lucide-react";

import { sendSignInLink } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInForm() {
  const [pending, startTransition] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      setError(null);
      const result = await sendSignInLink(formData);

      if (!result.success) {
        setError(result.error);
        return;
      }
      setSentTo(result.data?.email ?? null);
    });
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
        <p className="flex items-center gap-2 font-medium">
          <CircleCheck className="size-4 shrink-0" />
          Check your inbox
        </p>
        <p className="leading-relaxed">
          We sent a sign-in link to <strong>{sentTo}</strong>. Open it on this
          device — the link signs in whichever browser opens it.
        </p>
        <button
          type="button"
          onClick={() => setSentTo(null)}
          className="self-start text-xs underline underline-offset-4"
        >
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <form action={handleSubmit} className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email address</Label>
        <Input
          id="email"
          type="email"
          name="email"
          required
          autoFocus
          autoComplete="email"
          placeholder="you@university.edu"
        />
      </div>

      {error && (
        <p className="text-destructive text-xs leading-relaxed">{error}</p>
      )}

      <Button type="submit" disabled={pending}>
        {pending && <Loader2 className="size-4 animate-spin" />}
        Send sign-in link
      </Button>
    </form>
  );
}
