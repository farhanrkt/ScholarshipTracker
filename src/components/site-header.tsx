import Link from "next/link";
import { GraduationCap } from "lucide-react";

import { AccountMenu } from "@/components/account-menu";
import { SiteNav } from "@/components/site-nav";
import { ThemeToggle } from "@/components/theme-toggle";
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
      {/* Skip link: the nav is the first thing in the tab order on every page,
          and an admin has five items in it. Without this, reaching the content
          by keyboard means tabbing past all of them, on every navigation. */}
      <a
        href="#main"
        className="bg-background focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:px-3 focus:py-1.5 focus:text-sm focus:ring-2 focus:outline-none"
      >
        Skip to content
      </a>

      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link
          href="/dashboard"
          className="focus-visible:ring-ring flex shrink-0 items-center gap-2 rounded-md font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
            <GraduationCap className="size-4" />
          </span>
          {/* The wordmark is the first thing to go when space is tight — the
              icon still identifies the app, and the nav is what people need. */}
          <span className="hidden tracking-tight sm:inline">ScholarTrack</span>
        </Link>

        {/* Scrolls rather than wraps. With the admin links present the nav is
            wider than a phone, and wrapping broke the header into two rows and
            pushed the account control off the right edge entirely. */}
        <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SiteNav trackedCount={trackedCount} isAdmin={await isAdmin()} />
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
