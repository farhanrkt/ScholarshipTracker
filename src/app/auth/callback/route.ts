import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Where an email link's credential is actually exchanged for a session.
 *
 * THIS HAS TO BE A ROUTE HANDLER, and the reason is the bug it fixes. The
 * exchange used to happen in the /auth/confirm Server Component, where
 * `cookies().set()` is a no-op — Next.js only honours cookie writes in Server
 * Functions and Route Handlers, because a Server Component may already be
 * streaming when it tries to write a header. The server client swallows that
 * failure on purpose (session refreshes are re-done by the proxy on the next
 * request, so losing one is harmless).
 *
 * A sign-in exchange is the one case where it is not harmless: the session it
 * mints exists nowhere else. Swallowing that write threw the session away, the
 * page redirected with `?linked=ok` anyway, the proxy saw no user and minted a
 * fresh anonymous ghost — and the app told the user they were signed in while
 * they were not. Exactly the reported symptom, and no error anywhere.
 *
 * Here the write survives, and the handler refuses to claim success until it
 * has re-read the session and found a real, non-anonymous user.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  // Only same-site paths: an open redirect here would let a crafted email
  // bounce a freshly-authenticated visitor somewhere else entirely.
  const requested = searchParams.get("next") ?? "/my-tracker";
  const next =
    requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/my-tracker";

  const failed = (reason: string) =>
    NextResponse.redirect(
      new URL(
        `/auth/sign-in?error=invalid&reason=${encodeURIComponent(reason)}`,
        origin,
      ),
    );

  const supabase = await createClient();

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failed(error.message);
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (error) return failed(error.message);
  } else {
    return failed(
      "That link carried no sign-in token. It may already have been used — request a fresh one and open the newest email.",
    );
  }

  // Do not take the exchange's word for it. If the cookies did not stick, the
  // honest answer is "that did not work", not a green banner.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return failed(
      "The link was accepted but no session was created. Check that cookies are enabled and try the newest email.",
    );
  }

  // An anonymous user here means the ghost account was never upgraded — the
  // link confirmed nothing, and saying "you are signed in" would be a lie.
  if (user.is_anonymous) {
    return failed(
      "That link did not attach your email to this account. Request a fresh one from the dashboard banner.",
    );
  }

  return NextResponse.redirect(
    new URL(`${next}${next.includes("?") ? "&" : "?"}linked=ok`, origin),
  );
}
