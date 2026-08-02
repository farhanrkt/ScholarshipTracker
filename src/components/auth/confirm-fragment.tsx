"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";

/**
 * Handles Supabase's implicit-flow links, where the tokens arrive in the URL
 * fragment (`#access_token=...`).
 *
 * Fragments are never sent to the server, so this cannot be a Server Component
 * or a Route Handler — a server-side redirect would discard the credential and
 * the user would be told the link was invalid when it was fine.
 *
 * Every outcome ends in a navigation, success or failure, so this component
 * holds no state and renders one thing. That keeps the failure copy in a single
 * place (the sign-in page) instead of duplicated here.
 */
export function ConfirmFragment({ next }: { next: string }) {
  useEffect(() => {
    const fail = (reason: string) => {
      window.location.replace(
        `/auth/sign-in?error=invalid&reason=${encodeURIComponent(reason)}`,
      );
    };

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));

    const hashError = hash.get("error_description") ?? hash.get("error");
    if (hashError) {
      fail(hashError);
      return;
    }

    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");

    if (!access_token || !refresh_token) {
      fail(
        "The link carried no sign-in token. It may already have been used — request a fresh one and open the newest email.",
      );
      return;
    }

    createClient()
      .auth.setSession({ access_token, refresh_token })
      .then(({ error }) => {
        if (error) {
          fail(error.message);
          return;
        }
        // Strip the fragment so a refresh cannot replay it, then do a full
        // navigation so the proxy and Server Components see the new cookies.
        window.history.replaceState(null, "", window.location.pathname);
        window.location.assign(
          `${next}${next.includes("?") ? "&" : "?"}linked=ok`,
        );
      })
      .catch((cause: unknown) => {
        fail(cause instanceof Error ? cause.message : String(cause));
      });
  }, [next]);

  return (
    <div className="text-muted-foreground mx-auto flex max-w-sm items-center gap-2 px-4 py-16 text-sm">
      <Loader2 className="size-4 animate-spin" />
      Signing you in…
    </div>
  );
}
