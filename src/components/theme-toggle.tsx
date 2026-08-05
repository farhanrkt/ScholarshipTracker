"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Light, dark, or whatever the operating system says.
 *
 * WHY THIS EXISTS. Every component in this app already carried `dark:` variants
 * and `globals.css` defined a complete dark palette — but nothing ever put the
 * `.dark` class on the document, so none of it could ever render. The styling
 * was written, shipped, and unreachable. This is the switch it was waiting for.
 *
 * Three states rather than two, because "system" is the honest default: a
 * student reading this at midnight on a phone that is already in dark mode
 * should not have to ask twice.
 */

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

/**
 * True once the client has taken over.
 *
 * `useSyncExternalStore` rather than a `useState` + `useEffect` pair: the two
 * differ only in that this one tells React directly that the server and the
 * client render different things, instead of setting state during an effect to
 * force a second pass. The subscribe function never fires — the value is
 * constant after hydration — so nothing re-renders beyond that first swap.
 */
const subscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useHydrated();

  // The server cannot know the resolved theme, so rendering the active state
  // before hydration guarantees a mismatch. A placeholder of the same size
  // keeps the header from shifting when the real control arrives.
  if (!mounted) {
    return <div className="h-8 w-[5.5rem]" aria-hidden />;
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="bg-muted/60 flex items-center gap-0.5 rounded-lg p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = (theme ?? "system") === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            onClick={() => setTheme(option.value)}
            className={cn(
              "focus-visible:ring-ring rounded-md p-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <option.icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
