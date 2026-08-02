import { createClient } from "./server";

/**
 * Who the current visitor actually is, as the session sees it.
 *
 * Three components were each answering this question with their own try/catch
 * around `getUser()` and their own idea of what counts as signed in. That is
 * fine until one of them disagrees with another — which is precisely the bug
 * that shipped: /my-tracker decided from a query parameter that the visitor was
 * signed in, while the header, reading the session, offered them a sign-in
 * button on the same screen.
 *
 * "Signed in" means a real user that is not the anonymous ghost. Nothing else.
 */
export interface Account {
  userId: string | null;
  email: string | null;
  isAnonymous: boolean;
  signedIn: boolean;
}

const SIGNED_OUT: Account = {
  userId: null,
  email: null,
  isAnonymous: true,
  signedIn: false,
};

export async function currentAccount(): Promise<Account> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return SIGNED_OUT;

    const isAnonymous = user.is_anonymous ?? false;
    return {
      userId: user.id,
      email: user.email ?? null,
      isAnonymous,
      // An anonymous account with an email attached is mid-upgrade, not signed
      // in: Supabase keeps is_anonymous true until the link is confirmed.
      signedIn: !isAnonymous && Boolean(user.email),
    };
  } catch {
    // Supabase unreachable or unconfigured. Browsing works; claiming a session
    // does not.
    return SIGNED_OUT;
  }
}
