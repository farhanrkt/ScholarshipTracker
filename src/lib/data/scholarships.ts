import { createClient } from "@/lib/supabase/server";
import type { ScholarshipFilters, ToggleKey } from "@/lib/filters";
import { COUNTRIES, type Country, type Scholarship } from "@/lib/types/database";

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
  // Handled inline: "no work experience" needs evidence, not just a null.
  // See below.
  noWorkExperience: null,
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

  /**
   * "No work experience required" — the second filter where an unknown must not
   * pass, and the one where it was passing.
   *
   * The predicate used to be `min_work_experience_years IS NULL`, which is the
   * absence of an answer, not an answer. It returned 23 rows nobody had read —
   * offered to a student as "open to applicants straight out of university" on
   * no evidence at all — while EXCLUDING A*STAR, the one row whose pages
   * actually say no experience is needed, because a stated 0 is not null.
   * Wrong in both directions at once.
   *
   * THE `->` / `->>` DISTINCTION IS THE WHOLE FIX, and it is the one this
   * file's header describes. `->>` yields SQL NULL both when the key is absent
   * and when its value is JSON null, so it cannot tell "nobody asked" from
   * "asked, and the pages do not say". `->` yields SQL NULL only when the key
   * is ABSENT, so the first clause below means precisely "this question was
   * answered". The second then keeps the answers that are "no requirement":
   * an explicit 0, or an explicit null meaning the pages state no minimum.
   *
   * A funder states its requirements; it does not state its non-requirements.
   * So silence on a page that WAS read is a fair reading of "none required" —
   * and silence on a page nobody opened is nothing at all.
   */
  if (filters.toggles.noWorkExperience) {
    query = query
      .not("eligibility_flags->min_work_experience_years", "is", null)
      .or(
        "eligibility_flags->>min_work_experience_years.is.null," +
          "eligibility_flags->>min_work_experience_years.eq.0",
      );
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

/**
 * The country facets to offer, which must be facets that can actually filter.
 *
 * This used to return every DISTINCT stored value, and `country` is free text in
 * Postgres while `parseFilters` accepts only the `COUNTRIES` union. A row filed
 * under `"Unknown"` therefore produced a chip that rendered, highlighted when
 * clicked, put a parameter in the URL — and filtered nothing, because the
 * parser dropped it on the way back in. Intersecting with the union here is
 * what keeps the two ends of that round trip agreeing.
 */
export async function fetchScholarshipCountries(): Promise<Country[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("scholarships").select("country");

  if (error || !data) return [];

  const stored = new Set(data.map((row) => row.country));
  return COUNTRIES.filter((country) => stored.has(country));
}
