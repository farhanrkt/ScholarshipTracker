import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/types/database";
import { getSupabaseEnv } from "./env";

/** Browser-side client. Only needed for auth flows that must run in the tab. */
export function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  return createBrowserClient<Database>(url, anonKey);
}
