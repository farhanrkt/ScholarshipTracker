import Link from "next/link";
import { GraduationCap } from "lucide-react";

import { AccountMenu } from "@/components/account-menu";
import { SiteNav } from "@/components/site-nav";
import { createClient } from "@/lib/supabase/server";

/**
 * Admin links are hidden from everyone else — not as protection (RLS and the
 * page gate are that), but because a nav item you are always denied is noise.
 */
async function isAdmin(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc("is_admin");
    return Boolean(data);
  } catch {
    return false;
  }
}

async function getTrackedCount(): Promise<number> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return 0;

    const { count } = await supabase
      .from("user_targets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function SiteHeader() {
  const trackedCount = await getTrackedCount();

  return (
    <header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
            <GraduationCap className="size-4" />
          </span>
          <span className="tracking-tight">ScholarTrack</span>
        </Link>

        <SiteNav trackedCount={trackedCount} isAdmin={await isAdmin()} />
        <AccountMenu />
      </div>
    </header>
  );
}
