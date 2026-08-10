import {
  COUNTRIES,
  DEGREE_LEVELS,
  type Country,
  type DegreeLevel,
} from "@/lib/types/database";

/* -------------------------------------------------------------------------- */
/* Filter shape                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Boolean filters. Each one maps to exactly one URL param and one predicate in
 * `applyScholarshipFilters`, so adding a facet is a two-line change.
 */
export const TOGGLE_KEYS = [
  "noWorkExperience",
  "noNomination",
  "noLanguageTest",
  "noAdmissionFirst",
  "languageTraining",
  "coversTuition",
  "coversAirfare",
  "coversAccommodation",
  "noBond",
  "upcomingOnly",
  "verifiedOnly",
] as const;
export type ToggleKey = (typeof TOGGLE_KEYS)[number];

export interface ToggleDefinition {
  key: ToggleKey;
  label: string;
  hint: string;
  group: "Eligibility" | "Funding" | "Commitment" | "Data quality";
}

export const TOGGLE_DEFINITIONS: ToggleDefinition[] = [
  {
    key: "noWorkExperience",
    label: "No work experience required",
    // Says what the filter can actually prove. It used to promise "open to
    // applicants straight out of university" about rows nobody had read.
    hint: "Programmes whose pages state no minimum — unread ones are not included",
    group: "Eligibility",
  },
  {
    key: "noNomination",
    label: "No government nomination",
    hint: "You can apply directly, without an embassy endorsement",
    group: "Eligibility",
  },
  {
    key: "noLanguageTest",
    label: "No language test required",
    hint: "No mandatory IELTS / TOEFL / TOPIK / JLPT",
    group: "Eligibility",
  },
  {
    key: "noAdmissionFirst",
    label: "No prior admission needed",
    hint: "Apply before holding a university offer",
    group: "Eligibility",
  },
  {
    key: "coversTuition",
    label: "Full tuition covered",
    hint: "You pay nothing toward course fees",
    group: "Funding",
  },
  {
    key: "coversAirfare",
    label: "Airfare covered",
    hint: "International flights paid by the programme",
    group: "Funding",
  },
  {
    key: "coversAccommodation",
    label: "Accommodation covered",
    hint: "Housing paid separately from the stipend",
    group: "Funding",
  },
  {
    key: "languageTraining",
    label: "Language training included",
    hint: "A funded preparatory language year is part of the award",
    group: "Funding",
  },
  {
    key: "noBond",
    label: "No post-study obligations",
    hint: "No return-home clause or service bond",
    group: "Commitment",
  },
  {
    key: "upcomingOnly",
    label: "Still open",
    hint: "Hide programmes whose deadline has already passed",
    group: "Commitment",
  },
  {
    key: "verifiedOnly",
    label: "Verified dates only",
    hint: "Only rows a human has checked against the official page",
    group: "Data quality",
  },
];

export const SORT_OPTIONS = [
  { value: "deadline", label: "Deadline (soonest first)" },
  { value: "recently_verified", label: "Recently verified" },
  { value: "title", label: "Title (A-Z)" },
] as const;
export type SortOption = (typeof SORT_OPTIONS)[number]["value"];

export interface ScholarshipFilters {
  countries: Country[];
  degrees: DegreeLevel[];
  toggles: Record<ToggleKey, boolean>;
  q: string;
  sort: SortOption;
}

/* -------------------------------------------------------------------------- */
/* URL <-> filters                                                            */
/* -------------------------------------------------------------------------- */

export type RawSearchParams = Record<string, string | string[] | undefined>;

/** URL param name for each facet. Kept short because they end up in shared links. */
export const PARAM = {
  country: "country",
  degree: "degree",
  q: "q",
  sort: "sort",
} as const;

function toList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : value.split(",");
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function parseFilters(params: RawSearchParams): ScholarshipFilters {
  const countries = toList(params[PARAM.country]).filter((value): value is Country =>
    (COUNTRIES as readonly string[]).includes(value),
  );

  const degrees = toList(params[PARAM.degree]).filter(
    (value): value is DegreeLevel =>
      (DEGREE_LEVELS as readonly string[]).includes(value),
  );

  const toggles = Object.fromEntries(
    TOGGLE_KEYS.map((key) => [key, params[key] === "1"]),
  ) as Record<ToggleKey, boolean>;

  const rawSort = params[PARAM.sort];
  const sort: SortOption = SORT_OPTIONS.some((option) => option.value === rawSort)
    ? (rawSort as SortOption)
    : "deadline";

  const rawQuery = params[PARAM.q];

  return {
    countries,
    degrees,
    toggles,
    q: typeof rawQuery === "string" ? rawQuery.trim() : "",
    sort,
  };
}

export function countActiveFilters(filters: ScholarshipFilters): number {
  return (
    filters.countries.length +
    filters.degrees.length +
    Object.values(filters.toggles).filter(Boolean).length +
    (filters.q ? 1 : 0)
  );
}

/** Serialises filters back into a query string for links and router pushes. */
export function serialiseFilters(filters: ScholarshipFilters): string {
  const params = new URLSearchParams();
  if (filters.countries.length) params.set(PARAM.country, filters.countries.join(","));
  if (filters.degrees.length) params.set(PARAM.degree, filters.degrees.join(","));
  if (filters.q) params.set(PARAM.q, filters.q);
  if (filters.sort !== "deadline") params.set(PARAM.sort, filters.sort);
  for (const key of TOGGLE_KEYS) {
    if (filters.toggles[key]) params.set(key, "1");
  }
  return params.toString();
}
