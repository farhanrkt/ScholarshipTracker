"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PARAM,
  SORT_OPTIONS,
  TOGGLE_DEFINITIONS,
  TOGGLE_KEYS,
  type SortOption,
  type ToggleDefinition,
} from "@/lib/filters";
import { displayCountry } from "@/lib/format";
import { DEGREE_LEVELS } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const TOGGLE_GROUPS = [
  "Eligibility",
  "Funding",
  "Commitment",
  "Data quality",
] as const;

interface FilterPanelProps {
  countries: string[];
  resultCount: number;
}

export function FilterPanel({ countries, resultCount }: FilterPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [search, setSearch] = useState(searchParams.get(PARAM.q) ?? "");

  const commit = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      });
    },
    [pathname, router, searchParams],
  );

  // Debounce the title search so every keystroke does not hit Postgres.
  useEffect(() => {
    const current = searchParams.get(PARAM.q) ?? "";
    if (search === current) return;

    const timer = setTimeout(() => {
      commit((params) => {
        if (search.trim()) params.set(PARAM.q, search.trim());
        else params.delete(PARAM.q);
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [search, searchParams, commit]);

  const selectedCountries = useMemo(
    () => new Set((searchParams.get(PARAM.country) ?? "").split(",").filter(Boolean)),
    [searchParams],
  );
  const selectedDegrees = useMemo(
    () => new Set((searchParams.get(PARAM.degree) ?? "").split(",").filter(Boolean)),
    [searchParams],
  );

  const activeCount =
    selectedCountries.size +
    selectedDegrees.size +
    TOGGLE_KEYS.filter((key) => searchParams.get(key) === "1").length +
    (searchParams.get(PARAM.q) ? 1 : 0);

  function toggleListValue(param: string, value: string, selected: Set<string>) {
    commit((params) => {
      const next = new Set(selected);
      if (next.has(value)) next.delete(value);
      else next.add(value);

      if (next.size) params.set(param, [...next].join(","));
      else params.delete(param);
    });
  }

  function setToggle(key: string, checked: boolean) {
    commit((params) => {
      if (checked) params.set(key, "1");
      else params.delete(key);
    });
  }

  function clearAll() {
    setSearch("");
    startTransition(() => router.replace(pathname, { scroll: false }));
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-2">
        <SlidersHorizontal className="size-4" />
        <h2 className="text-sm font-semibold tracking-tight">Filters</h2>
        {activeCount > 0 && (
          <Badge variant="secondary" className="tabular-nums">
            {activeCount}
          </Badge>
        )}
        {pending && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2 text-xs"
            onClick={clearAll}
          >
            <X className="size-3" />
            Clear
          </Button>
        )}
      </header>

      {/* Search --------------------------------------------------------- */}
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name…"
          aria-label="Search scholarships by title"
          className="pl-8"
        />
      </div>

      {/* Country -------------------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Country
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {countries.map((country) => {
            const active = selectedCountries.has(country);
            return (
              <button
                key={country}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  toggleListValue(PARAM.country, country, selectedCountries)
                }
                className={cn(
                  // A visible focus ring, because these are the only controls
                  // on the page that had none: a keyboard user tabbing the
                  // country row had to guess where they were.
                  "focus-visible:ring-ring rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none",
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "hover:bg-muted",
                )}
              >
                {displayCountry(country)}
              </button>
            );
          })}
        </div>
      </section>

      <Separator />

      {/* Degree level --------------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Degree level
        </h3>
        <div className="flex flex-col gap-2.5">
          {DEGREE_LEVELS.map((level) => (
            <div key={level} className="flex items-center gap-2.5">
              <Checkbox
                id={`degree-${level}`}
                checked={selectedDegrees.has(level)}
                onCheckedChange={() =>
                  toggleListValue(PARAM.degree, level, selectedDegrees)
                }
              />
              <Label htmlFor={`degree-${level}`} className="text-sm font-normal">
                {level}
              </Label>
            </div>
          ))}
        </div>
      </section>

      {/* Structured JSONB facets ---------------------------------------- */}
      {TOGGLE_GROUPS.map((group) => {
        const definitions = TOGGLE_DEFINITIONS.filter(
          (definition: ToggleDefinition) => definition.group === group,
        );

        return (
          <section key={group} className="flex flex-col gap-2.5">
            <Separator className="mb-1" />
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {group}
            </h3>
            <div className="flex flex-col gap-3">
              {definitions.map((definition) => (
                <div key={definition.key} className="flex items-start gap-2.5">
                  <Checkbox
                    id={definition.key}
                    className="mt-0.5"
                    checked={searchParams.get(definition.key) === "1"}
                    onCheckedChange={(checked) =>
                      setToggle(definition.key, checked === true)
                    }
                  />
                  <div className="grid gap-0.5 leading-tight">
                    <Label
                      htmlFor={definition.key}
                      className="text-sm leading-tight font-normal"
                    >
                      {definition.label}
                    </Label>
                    <span className="text-muted-foreground text-xs">
                      {definition.hint}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <Separator />

      {/* Sort ----------------------------------------------------------- */}
      <section className="flex flex-col gap-2.5">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Sort by
        </h3>
        <Select
          value={searchParams.get(PARAM.sort) ?? "deadline"}
          onValueChange={(value) =>
            commit((params) => {
              if (!value || value === "deadline") params.delete(PARAM.sort);
              else params.set(PARAM.sort, value);
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue>
              {(value: SortOption | null) =>
                SORT_OPTIONS.find((option) => option.value === value)?.label ??
                "Sort by"
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <p className="text-muted-foreground text-xs tabular-nums">
        {resultCount} {resultCount === 1 ? "scholarship" : "scholarships"} match
      </p>
    </div>
  );
}
