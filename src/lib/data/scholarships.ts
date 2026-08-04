import { createClient } from "@/lib/supabase/server";
import type { ScholarshipFilters, ToggleKey } from "@/lib/filters";
import type { Scholarship } from "@/lib/types/database";

/**
 * JSONB predicates, expressed as PostgREST filters.
 *
 * `->>` (not `->`) is deliberate on every path: it returns SQL NULL both when
 * the key is absent and when its value is JSON `null`, which is exactly the
 * "not required / not stated" semantics the UI promises. `->` would return the
 * jsonb literal `null`, which is not SQL NULL and would break `is.null`.
 */
const TOGGLE_PREDICATES: Record<
  ToggleKey,
  { path: string; operator: "is" | "eq" | "gte"; value: string | null } | null
> = {
  noWorkExperience: {
    path: "eligibility_flags->>min_work_experience_years",
    operator: "is",
    value: null,
  },
  noNomination: {
    path: "eligibility_flags->>requires_government_nomination",
    operator: "eq",
    value: "false",
  },
  noLanguageTest: {
    path: "eligibility_flags->>language_test_required",
    operator: "eq",
    value: "false",
  },
  noAdmissionFirst: {
    path: "eligibility_flags->>requires_university_admission_first",
    operator: "eq",
    value: "false",
  },
  coversTuition: {
    path: "coverage_matrix->tuition->>covered",
    operator: "eq",
    value: "true",
  },
  coversAirfare: {
    path: "coverage_matrix->airfare->>covered",
    operator: "eq",
    value: "true",
  },
  coversAccommodation: {
    path: "coverage_matrix->accommodation->>covered",
    operator: "eq",
    value: "true",
  },
  // Handled inline: "no bond" needs evidence, not just a null. See below.
  noBond: null,
  verifiedOnly: {
    path: "verification_status",
    operator: "eq",
    value: "verified",
  },
  // Handled as plain columns below.
  languageTraining: null,
  upcomingOnly: null,
};

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function fetchScholarships(
  filters: ScholarshipFilters,
): Promise<Scholarship[]> {
  const supabase = await createClient();

  let query = supabase.from("scholarships").select("*");

  if (filters.countries.length > 0) {
    query = query.in("country", filters.countries);
  }

  // TEXT[] overlap: match rows offering *any* of the selected degree levels.
  if (filters.degrees.length > 0) {
    query = query.overlaps("degree_levels", filters.degrees);
  }

  if (filters.q) {
    query = query.ilike("title", `%${filters.q}%`);
  }

  if (filters.toggles.languageTraining) {
    query = query.eq("language_training_included", true);
  }

  // "Still open" keeps rows with no published deadline: an unknown date is not
  // grounds to rule a programme out, only grounds to go and check it.
  if (filters.toggles.upcomingOnly) {
    query = query.or(`deadline_date.gte.${todayIso()},deadline_date.is.null`);
  }

  // "No bond" is the one filter where an unknown must NOT pass. A null
  // `post_study_obligations` means "no obligation recorded", which on an
  // unread row means nothing at all — and a multi-year service commitment is
  // the worst thing to discover after accepting an award. So the row must also
  // have been profiled: something read its pages and did not find one.
  if (filters.toggles.noBond) {
    query = query.is("post_study_obligations", null).eq("is_profiled", true);
  }

  for (const [key, predicate] of Object.entries(TOGGLE_PREDICATES)) {
    if (!predicate) continue;
    if (!filters.toggles[key as ToggleKey]) continue;
    query = query.filter(predicate.path, predicate.operator, predicate.value);
  }

  switch (filters.sort) {
    case "recently_verified":
      query = query.order("last_verified_at", { ascending: false });
      break;
    case "title":
      query = query.order("title", { ascending: true });
      break;
    default:
      // Rows with no published date sort last rather than masquerading as urgent.
      query = query.order("deadline_date", {
        ascending: true,
        nullsFirst: false,
      });
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to load scholarships: ${error.message}`);
  }

  return data ?? [];
}

export async function fetchScholarshipCountries(): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("scholarships").select("country");

  if (error || !data) return [];

  return [...new Set(data.map((row) => row.country))].sort();
}
