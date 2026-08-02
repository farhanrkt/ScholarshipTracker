"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/lib/types/actions";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function siteOrigin(): Promise<string> {
  const headerList = await headers();
  const origin = headerList.get("origin");
  if (origin) return origin;

  // Server Actions do not always carry an Origin header; reconstruct it.
  const host = headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "";
}

/**
 * Upgrades a ghost account into a permanent one.
 *
 * `updateUser({ email })` on an anonymous user sends a confirmation link; the
 * UUID is preserved, so every tracked scholarship and checklist tick survives
 * the upgrade untouched.
 */
export async function linkEmailToAccount(
  formData: FormData,
): Promise<ActionResult<{ email: string }>> {
  try {
    const email = String(formData.get("email") ?? "").trim().toLowerCase();

    if (!EMAIL_PATTERN.test(email)) {
      return fail("Please enter a valid email address.");
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return fail("No active session. Please reload the page.");
    if (!user.is_anonymous) return fail("This account is already linked to an email.");

    const origin = await siteOrigin();

    const { error } = await supabase.auth.updateUser(
      { email },
      { emailRedirectTo: origin ? `${origin}/auth/confirm` : undefined },
    );

    if (error) return fail(error.message);

    return ok({ email });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not link your email.");
  }
}

/**
 * Signs a returning user back in on a new device.
 *
 * Without this the "link an email to save your progress permanently" promise is
 * empty: linking makes the account durable, but nothing could ever reach it
 * again from a different browser — every visit just minted a fresh ghost.
 *
 * `shouldCreateUser: false` matters. If someone mistypes their address we must
 * NOT quietly create a second empty account for it; they should be told no such
 * account exists so they can try the right one.
 */
export async function sendSignInLink(
  formData: FormData,
): Promise<ActionResult<{ email: string }>> {
  try {
    const email = String(formData.get("email") ?? "").trim().toLowerCase();

    if (!EMAIL_PATTERN.test(email)) {
      return fail("Please enter a valid email address.");
    }

    const supabase = await createClient();
    const origin = await siteOrigin();

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: origin ? `${origin}/auth/confirm?next=/my-tracker` : undefined,
      },
    });

    if (error) {
      // Supabase reports an unknown address as a signup-disabled error.
      if (/signups? not allowed|user not found/i.test(error.message)) {
        return fail(
          "No account is linked to that address. If you have not linked one yet, do it from the banner on the dashboard — your tracker lives in this browser until you do.",
        );
      }
      return fail(error.message);
    }

    return ok({ email });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not send the link.");
  }
}

/**
 * Ends the session and starts a fresh ghost account on the next request.
 *
 * Signing out of a linked account is safe — the data is reachable again through
 * a sign-in link. Signing out of an anonymous one is not, so the UI only offers
 * this once an email is attached.
 */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/dashboard");
}
