"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { displayCountry } from "@/lib/format";
import { PARAM, TOGGLE_DEFINITIONS, type ToggleKey } from "@/lib/filters";

/**
 * What is currently filtering the list, and one click to undo any of it.
 *
 * The panel that SETS these lives in a rail that is hidden below `lg` and in a
 * sheet that has to be opened — so on a phone the only evidence that eight
 * filters were applied was that the list looked short. Someone who forgets a
 * toggle is on concludes the database is empty, which is the worst possible
 * misreading of an empty result.
 *
 * Chips also make the state shareable in the ordinary way: what you see is what
 * the URL says, and removing one is a normal link-shaped action rather than a
 * trip back into a panel.
 */

interface Chip {
  key: string;
  label: string;
  /** The search params with this filter removed. */
  next: URLSearchParams;
}

export function ActiveFilters({ resultCount }: { resultCount: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const chips: Chip[] = [];

  const without = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    return params;
  };

  const query = searchParams.get(PARAM.q);
  if (query) {
    chips.push({
      key: "q",
      label: `“${query}”`,
      next: without((params) => params.delete(PARAM.q)),
    });
  }

  // Countries and degrees are comma-joined in one param, so removing ONE means
  // rewriting the list rather than deleting the key.
  for (const [param, format] of [
    [PARAM.country, displayCountry],
    [PARAM.degree, (value: string) => value],
  ] as const) {
    const raw = searchParams.get(param);
    if (!raw) continue;

    const values = raw.split(",").filter(Boolean);
    for (const value of values) {
      chips.push({
        key: `${param}:${value}`,
        label: format(value),
        next: without((params) => {
          const rest = values.filter((other) => other !== value);
          if (rest.length > 0) params.set(param, rest.join(","));
          else params.delete(param);
        }),
      });
    }
  }

  for (const definition of TOGGLE_DEFINITIONS) {
    if (searchParams.get(definition.key as ToggleKey) !== "1") continue;
    chips.push({
      key: definition.key,
      label: definition.label,
      next: without((params) => params.delete(definition.key)),
    });
  }

  const go = (params: URLSearchParams) => {
    const query = params.toString();
    router.push(query ? `/dashboard?${query}` : "/dashboard", { scroll: false });
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <p
        // Announced, because filtering happens without a page transition and a
        // screen-reader user otherwise gets no confirmation that anything did.
        aria-live="polite"
        className="text-muted-foreground text-sm tabular-nums"
      >
        <span className="text-foreground font-medium">{resultCount}</span>{" "}
        {resultCount === 1 ? "programme" : "programmes"}
      </p>

      {chips.length > 0 && (
        <>
          {/* Only a separator when the two sit on one line — the chips wrap on a
              phone, and a lone dot at the end of the count reads as a typo. */}
          <span aria-hidden className="text-muted-foreground/50 hidden sm:inline">
            ·
          </span>

          <ul className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <li key={chip.key}>
                <button
                  type="button"
                  onClick={() => go(chip.next)}
                  className="bg-muted hover:bg-muted/70 focus-visible:ring-ring flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  {chip.label}
                  <X className="size-3 opacity-60" aria-hidden />
                  <span className="sr-only">Remove this filter</span>
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => go(new URLSearchParams())}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded px-1 text-xs underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            Clear all
          </button>
        </>
      )}
    </div>
  );
}
