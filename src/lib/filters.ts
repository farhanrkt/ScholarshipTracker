// Relative, with the extension, rather than the usual `@/` alias — and that is
// the whole reason this file could not be tested before. `COUNTRIES` and
// `DEGREE_LEVELS` are VALUES, so Node has to resolve the specifier at runtime,
// and `tsconfig` path aliases mean nothing to it. Every other tested module in
// `src/lib` gets away with `@/` only because its imports are types, which type
// stripping erases before Node ever sees them. See the same note in
// `format.test.ts`.
import {
  COUNTRIES,
  DEGREE_LEVELS,
  type Country,
  type DegreeLevel,
} from "./types/database.ts";

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
  /**
   * On until the visitor turns it off.
   *
   * Exactly one toggle has this, and the reason is in the data rather than in
   * taste. Sixteen of the nineteen published deadlines have already passed, so
   * a list sorted by deadline opens on four closed American programmes and a
   * student has to scroll through the past to reach anything they can still
   * apply for. The first screen was answering a question nobody asked.
   *
   * A default is not a secret, and this one is deliberately noisy: the filter
   * sits in the rail already checked, and `ActiveFilters` draws it as a chip
   * whose X turns it off. The closed rows are always one click away and always
   * visibly withheld.
   */
  defaultOn?: boolean;
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
    defaultOn: true,
  },
  {
    key: "verifiedOnly",
    label: "Verified dates only",
    hint: "Only rows a human has checked against the official page",
    group: "Data quality",
  },
];

/** What each toggle is when the URL does not mention it. */
export const TOGGLE_DEFAULTS = Object.fromEntries(
  TOGGLE_DEFINITIONS.map((definition) => [definition.key, definition.defaultOn === true]),
) as Record<ToggleKey, boolean>;

/**
 * Reading one toggle out of a URL.
 *
 * Three-valued on purpose: "1" is on, "0" is off, and ABSENT is the default —
 * which for every toggle but one is off, and for "Still open" must not be.
 *
 * Written once because it was written four times: the server parse, the
 * checkbox in the rail, the rail's own badge count and the chips above the
 * results each tested `=== "1"` separately. Four copies of that is how a
 * checkbox ends up disagreeing with the list underneath it.
 */
export function readToggle(
  raw: string | string[] | null | undefined,
  key: ToggleKey,
): boolean {
  const value = typeof raw === "string" ? raw : undefined;
  if (value === "1") return true;
  if (value === "0") return false;
  return TOGGLE_DEFAULTS[key];
}

/**
 * Writing one back, leaving the URL as short as it can be.
 *
 * A value that equals the default is deleted rather than spelled out, so the
 * default view is `/dashboard` with no query string at all and a shared link
 * carries only what the sender actually chose.
 */
export function writeToggle(
  params: URLSearchParams,
  key: ToggleKey,
  on: boolean,
): void {
  if (on === TOGGLE_DEFAULTS[key]) params.delete(key);
  else params.set(key, on ? "1" : "0");
}

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
    TOGGLE_KEYS.map((key) => [key, readToggle(params[key], key)]),
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

/**
 * How much the visitor has changed, for the badge on the Filters button.
 *
 * Deviations from the default, not switches that happen to be on: a fresh
 * dashboard carries "Still open" and must still read as unfiltered, or the
 * badge cries wolf on every first visit and stops meaning anything.
 */
export function countActiveFilters(filters: ScholarshipFilters): number {
  return (
    filters.countries.length +
    filters.degrees.length +
    TOGGLE_KEYS.filter((key) => filters.toggles[key] !== TOGGLE_DEFAULTS[key]).length +
    (filters.q ? 1 : 0)
  );
}

/**
 * Is anything narrowing the list at all, defaults included?
 *
 * A different question from `countActiveFilters`, and the empty state needs
 * this one: "no results" means "there is no data" or "a filter removed it
 * all", and a default-on filter empties a list exactly as thoroughly as a
 * chosen one. Telling someone the table is empty when it holds forty-three
 * rows is the worst available answer.
 */
export function isFiltered(filters: ScholarshipFilters): boolean {
  return (
    filters.countries.length > 0 ||
    filters.degrees.length > 0 ||
    filters.q !== "" ||
    Object.values(filters.toggles).some(Boolean)
  );
}

/** Serialises filters back into a query string for links and router pushes. */
export function serialiseFilters(filters: ScholarshipFilters): string {
  const params = new URLSearchParams();
  if (filters.countries.length) params.set(PARAM.country, filters.countries.join(","));
  if (filters.degrees.length) params.set(PARAM.degree, filters.degrees.join(","));
  if (filters.q) params.set(PARAM.q, filters.q);
  if (filters.sort !== "deadline") params.set(PARAM.sort, filters.sort);
  for (const key of TOGGLE_KEYS) writeToggle(params, key, filters.toggles[key]);
  return params.toString();
}
