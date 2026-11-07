import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * How the unattended refresh gets a session.
 *
 * WHY THIS IS NOT INSIDE THE CRON ROUTE. Two things need it, and they must not
 * drift: the route that runs the weekly refresh, and the check that says
 * whether that refresh is still running. A watcher that signs in differently
 * from the thing it watches can report "healthy" over a cron that has been
 * failing to authenticate for months — which is the exact shape of the outage
 * this repo already had once, and the reason the check exists at all.
 *
 * The anon key plus a sign-in, exactly as a browser would do it, so every
 * statement runs against the same policies that guard a human admin and the
 * service-role key never reaches the deployed app.
 */

/**
 * `configured` separates the two failures, because they want different fixes
 * and different reactions.
 *
 * "This environment holds no refresh credentials" is a deployment that has not
 * been finished. "It holds them and they did not work" is a live account that
 * has been disabled, renamed or had its password changed — a refresh that is
 * dead right now. The cron route answers both with a 501, but the health check
 * must not: the first is a reason to fall back to another credential, the
 * second is the alert.
 */
export type RefreshSession =
  | { ok: true; client: SupabaseClient; email: string }
  | { ok: false; configured: boolean; reason: string };

export async function signInAsRefreshAccount(): Promise<RefreshSession> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.CRON_SUPABASE_EMAIL;
  const password = process.env.CRON_SUPABASE_PASSWORD;

  if (!url || !key) {
    return {
      ok: false,
      configured: false,
      reason: "Supabase is not configured for this deployment.",
    };
  }
  if (!email || !password) {
    return {
      ok: false,
      configured: false,
      reason:
        "The scheduled refresh needs CRON_SUPABASE_EMAIL and CRON_SUPABASE_PASSWORD — " +
        "a Supabase account on the `admins` allowlist. See docs/deployment.md.",
    };
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    return {
      ok: false,
      configured: true,
      reason: `The refresh account could not sign in: ${error.message}`,
    };
  }

  return { ok: true, client, email };
}
