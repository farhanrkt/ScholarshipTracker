import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/session";

/**
 * Runs before every matched request. This is where the ghost account is minted,
 * so a visitor has a usable UUID before the first Server Component renders.
 *
 * (Next 16 renamed the `middleware` file convention to `proxy`.)
 */
export default async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Every path except static assets and image files -- those never need a
     * session and running auth on them would just burn latency.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
