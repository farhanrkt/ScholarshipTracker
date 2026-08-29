"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dashboard", label: "Discover" },
  { href: "/my-tracker", label: "My tracker" },
] as const;

const ADMIN_LINKS = [
  { href: "/admin/pipeline", label: "Pipeline" },
  { href: "/admin/review", label: "Review" },
  { href: "/admin/candidates", label: "Candidates" },
  { href: "/admin/verify", label: "Verify" },
  { href: "/admin/coverage", label: "Coverage" },
] as const;

export function SiteNav({
  trackedCount,
  isAdmin = false,
}: {
  trackedCount: number;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const links = isAdmin ? [...LINKS, ...ADMIN_LINKS] : LINKS;

  return (
    <nav aria-label="Main" className="flex w-max items-center gap-1 text-sm">
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            /* Where you are is wayfinding, and wayfinding is what an accent is
               FOR. This was `bg-muted` — the same grey as a disabled surface —
               so the current page announced itself with the quietest token in
               the system, and on a header of seven items you had to hunt for
               it. */
            className={cn(
              "focus-visible:ring-ring flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none",
              active
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {link.label}
            {link.href === "/my-tracker" && trackedCount > 0 && (
              <span className="bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold tabular-nums">
                {trackedCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
