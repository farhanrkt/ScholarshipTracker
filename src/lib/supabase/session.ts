import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "@/lib/types/database";
import { getSupabaseEnv, hasSupabaseEnv } from "./env";

/**
 * Refreshes the Supabase session on every request and -- if the visitor has no
 * session at all -- silently mints a "ghost account" via anonymous sign-in.
 *
 * Called from `src/proxy.ts`, so the UUID exists before any Server Component
 * renders and `Track this scholarship` works on the very first click with no
 * login wall in between.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Before the project is configured, pass through untouched so the page can
  // render the "Supabase is not configured" boundary instead of a blank 500.
  if (!hasSupabaseEnv()) return response;

  const { url, anonKey } = getSupabaseEnv();

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the token against Supabase; getSession() would trust
  // whatever is in the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isSignInFlow(request)) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) {
      // Browsing still works without a session -- only tracking is unavailable.
      console.error("[scholartrack] anonymous sign-in failed:", error.message);
    }
  }

  return response;
}

/**
 * Paths where minting a ghost account would break the thing the user is doing.
 *
 * Someone arriving on a sign-in link has no session yet — that is the point.
 * Creating an anonymous one first would hand them a brand-new empty account and
 * then verify the emailed token against it, which is exactly the bug this
 * whole flow exists to fix.
 */
function isSignInFlow(request: NextRequest): boolean {
  return request.nextUrl.pathname.startsWith("/auth/");
}
