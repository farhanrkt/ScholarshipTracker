import { SearchX } from "lucide-react";

import { AnonymousBanner } from "@/components/anonymous-banner";
import { ActiveFilters } from "@/components/filters/active-filters";
import { FilterRail, FilterSheet } from "@/components/filters/filter-sidebar";
import { ScholarshipCard } from "@/components/scholarship/scholarship-card";
import {
  fetchScholarshipCountries,
  fetchScholarships,
} from "@/lib/data/scholarships";
import { fetchTrackedScholarshipIds } from "@/lib/data/targets";
import {
  countActiveFilters,
  parseFilters,
  type RawSearchParams,
} from "@/lib/filters";
import { COUNTRIES } from "@/lib/types/database";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const filters = parseFilters(await searchParams);

  const [scholarships, trackedIds, knownCountries] = await Promise.all([
    fetchScholarships(filters),
    fetchTrackedScholarshipIds(),
    fetchScholarshipCountries(),
  ]);

  const activeCount = countActiveFilters(filters);
  const countries = knownCountries.length ? knownCountries : [...COUNTRIES];

  return (
    <>
      <AnonymousBanner />

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Fully-funded scholarships
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Structured data, not brochure copy. Filter on what actually
              disqualifies you.
            </p>
          </div>

          <FilterSheet
            countries={countries}
            resultCount={scholarships.length}
            activeCount={activeCount}
          />
        </header>

        <div className="flex gap-8">
          <FilterRail countries={countries} resultCount={scholarships.length} />

          <div className="min-w-0 flex-1">
            <ActiveFilters resultCount={scholarships.length} />

            {scholarships.length === 0 ? (
              <EmptyState hasFilters={activeCount > 0} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {scholarships.map((scholarship) => (
                  <ScholarshipCard
                    key={scholarship.id}
                    scholarship={scholarship}
                    tracked={trackedIds.has(scholarship.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-20 text-center">
      <SearchX className="size-8 opacity-50" />
      <p className="text-foreground font-medium">No scholarships match</p>
      <p className="max-w-sm text-sm">
        {hasFilters
          ? "Your filters are stricter than the data. Try dropping the eligibility toggles first — they are the most exclusive."
          : "The scholarships table is empty. Run supabase/seed.sql against your project to load the starter dataset."}
      </p>
    </div>
  );
}
