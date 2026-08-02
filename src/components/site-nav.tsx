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
    <nav className="flex items-center gap-1 text-sm">
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "hover:bg-muted flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors",
              active ? "bg-muted font-medium" : "text-muted-foreground",
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
