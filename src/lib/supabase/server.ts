import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "@/lib/types/database";
import { getSupabaseEnv } from "./env";

/**
 * Server client for Server Components, Server Actions and Route Handlers.
 * Always create a fresh one per request -- never hoist it to a module constant.
 */
export async function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. The middleware refreshes the
          // session on every request, so it is safe to swallow this.
        }
      },
    },
  });
}

/**
 * The current user id, or null. Every visitor should have one because the
 * middleware signs them in anonymously, but callers must still handle null
 * (e.g. the very first request, or a client with cookies disabled).
 */
export async function getCurrentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}
