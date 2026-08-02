import { currentAccount } from "@/lib/supabase/account";
import { AnonymousBannerClient } from "./anonymous-banner-client";

/**
 * Renders only for ghost accounts. Once the user links an email and confirms
 * it, `is_anonymous` flips to false and the banner disappears on its own.
 */
export async function AnonymousBanner() {
  const { isAnonymous } = await currentAccount();
  if (!isAnonymous) return null;

  return <AnonymousBannerClient />;
}
