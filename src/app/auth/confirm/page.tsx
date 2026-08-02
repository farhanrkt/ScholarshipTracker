import { redirect } from "next/navigation";

import { ConfirmFragment } from "@/components/auth/confirm-fragment";

export const dynamic = "force-dynamic";

/**
 * Landing point for every email link: confirming a newly linked address, and
 * signing a returning user back in.
 *
 * Supabase delivers the credential in one of THREE shapes depending on the
 * project's email template and flow type, and a handler that understands only
 * one of them reports the other two as "invalid link" — which is what the
 * previous version of this file did:
 *
 *   ?code=...                 PKCE. Exchange it for a session server-side.
 *   ?token_hash=...&type=...  Custom template using {{ .TokenHash }}.
 *   #access_token=...         Implicit flow. The fragment is never sent to the
 *                             server, so only the browser can act on it.
 *
 * The third is why this is a page rather than a route handler: a redirect would
 * discard the fragment before anything could read it. The first two are handed
 * straight to /auth/callback, because a Server Component cannot persist the
 * session cookies their exchange produces.
 *
 * So the split is not arbitrary — it is one flow per place that can actually
 * complete it, and this page is the only entry point an email ever names.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // Only same-site paths: an open redirect here would let a crafted email
  // bounce a freshly-authenticated visitor somewhere else entirely.
  const requested = first("next") ?? "/my-tracker";
  const next =
    requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/my-tracker";

  // Supabase reports expiry and reuse in the query string.
  const errorDescription = first("error_description") ?? first("error");
  if (errorDescription) {
    return <ConfirmFailed reason={errorDescription} />;
  }

  // Anything in the QUERY STRING is handed to the route handler, which is the
  // only place a cookie write survives. Doing the exchange here looked like it
  // worked and silently discarded the session — see the comment in
  // src/app/auth/callback/route.ts. This page's remaining job is the fragment.
  const code = first("code");
  const tokenHash = first("token_hash");
  const type = first("type");

  if (code || (tokenHash && type)) {
    const forwarded = new URLSearchParams({ next });
    if (code) forwarded.set("code", code);
    if (tokenHash) forwarded.set("token_hash", tokenHash);
    if (type) forwarded.set("type", type);
    redirect(`/auth/callback?${forwarded.toString()}`);
  }

  // Nothing usable in the query string — the credential is probably in the
  // fragment, which only the browser can see.
  return <ConfirmFragment next={next} />;
}

function ConfirmFailed({ reason }: { reason: string }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-3 px-4 py-16">
      <h1 className="text-lg font-semibold tracking-tight">
        That link did not work
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Supabase said: <span className="text-foreground">{reason}</span>
      </p>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Links are single-use and expire. If you clicked an older one, request a
        fresh link and use the most recent email.
      </p>
      <a
        href="/auth/sign-in"
        className="text-sm font-medium underline underline-offset-4"
      >
        Request a new link
      </a>
    </div>
  );
}
