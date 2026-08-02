import { z } from "zod";

import type { CoverageKey } from "../../src/lib/types/database.ts";

/**
 * The extraction contract.
 *
 * Every extracted value is paired with `evidence_quote`: text copied verbatim
 * out of the page. That pairing is the whole design. After the model responds,
 * the pipeline checks each quote actually appears in the fetched page text and
 * discards any value whose quote does not — so a fabricated date is caught
 * mechanically rather than by reading the output and hoping.
 *
 * The model is told: if you cannot quote it, return null.
 *
 * TWO SCHEMAS, TWO CALLS. Cycle dates and the programme profile are extracted
 * separately. Not for tidiness — for output budget: one response carrying
 * dates, a timeline, eight coverage lines, eleven eligibility claims and a
 * document list, each with its own verbatim quote, does not fit in the token
 * ceiling of the free-tier providers this runs on, and a truncated response
 * loses the dates too. Split, a failed profile call still leaves the deadline.
 */

const CONFIDENCE = z.enum(["high", "medium", "low"]);

const DateClaim = z.object({
  value: z
    .string()
    .nullable()
    .describe("ISO date (YYYY-MM-DD), or null if the page does not state it"),
  evidence_quote: z
    .string()
    .nullable()
    .describe(
      "Text copied EXACTLY from the page that states this date. Null if value is null.",
    ),
  confidence: CONFIDENCE,
});

const TextClaim = z.object({
  value: z.string().nullable(),
  evidence_quote: z.string().nullable(),
  confidence: CONFIDENCE,
});

const TimelineStageClaim = z.object({
  key: z
    .string()
    .describe("Stable slug, e.g. 'opens', 'closes', 'interviews', 'results'"),
  label: z.string().describe("Human-readable stage name as the page words it"),
  date: z
    .string()
    .nullable()
    .describe("ISO date, or null when the stage is named but undated"),
  note: z.string().nullable(),
  evidence_quote: z
    .string()
    .nullable()
    .describe("Verbatim page text for this stage. Null only if date is null."),
});

/* -------------------------------------------------------------------------- */
/* Call 1: the application cycle                                              */
/* -------------------------------------------------------------------------- */

export const CycleExtractionSchema = z.object({
  /**
   * A cheap sanity check on the fetch. If this does not describe the programme
   * we asked about, we landed on a redirect, a cookie wall, or a 404 page — and
   * everything else in the response is about the wrong thing.
   */
  page_subject: z
    .string()
    .describe(
      "One sentence: which scholarship programme is this page actually about?",
    ),

  page_is_about_requested_programme: z
    .boolean()
    .describe(
      "False if the page does not appear to be about the programme named in the request.",
    ),

  cycle_label: TextClaim.describe(
    "Which intake these dates belong to, e.g. '2027/28 intake'",
  ),
  opens_date: DateClaim.describe("The date applications open"),
  deadline_date: DateClaim.describe("The date applications close"),

  timeline: z
    .array(TimelineStageClaim)
    .describe(
      "EVERY published stage of the cycle, in order — not just opening and closing. Include named stages with no date. Empty array only if the page publishes no timeline at all.",
    ),

  notes_for_reviewer: z
    .string()
    .describe(
      "Anything ambiguous, contradictory, or worth a human eye. Empty string if nothing.",
    ),
});

export type CycleExtraction = z.infer<typeof CycleExtractionSchema>;

/** Fields the cycle grounding check verifies. */
export const GROUNDED_FIELDS = [
  "cycle_label",
  "opens_date",
  "deadline_date",
] as const;
export type GroundedField = (typeof GROUNDED_FIELDS)[number];

/* -------------------------------------------------------------------------- */
/* Call 2: the programme profile                                              */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `CoverageKey` in src/lib/types/database.ts, deliberately by hand.
 *
 * A runtime import across the scripts/src boundary makes Node re-parse the
 * module on every CLI invocation and print a warning for it. The `satisfies`
 * and the exhaustiveness check below make the duplication safe: adding a key on
 * either side without the other is a typecheck error, not a silent divergence.
 */
const COVERAGE_KEYS = [
  "tuition",
  "monthly_stipend",
  "airfare",
  "accommodation",
  "health_insurance",
  "settling_in_allowance",
  "research_grant",
  "visa_fees",
] as const satisfies readonly CoverageKey[];

type MissingCoverageKey = Exclude<CoverageKey, (typeof COVERAGE_KEYS)[number]>;
// If this line errors, src gained a coverage key that this list is missing.
const _coverageIsExhaustive: MissingCoverageKey[] = [];
void _coverageIsExhaustive;

const CoverageClaim = z.object({
  key: z.enum(COVERAGE_KEYS).describe("Which line of support this is"),
  covered: z
    .boolean()
    .describe(
      "True if the programme pays it, false ONLY if the page says it does not. Omit the item entirely when the page is silent.",
    ),
  detail: z
    .string()
    .nullable()
    .describe(
      "The amount or qualifier as the page words it, e.g. 'JPY 143,000 per month'. Null if the page gives no figure.",
    ),
  evidence_quote: z
    .string()
    .nullable()
    .describe("Verbatim page text stating this. Never null — omit the item instead."),
});

const NumberClaim = z.object({
  value: z.number().nullable(),
  evidence_quote: z.string().nullable(),
});

const BooleanClaim = z.object({
  value: z.boolean().nullable(),
  evidence_quote: z.string().nullable(),
});

const StringsClaim = z.object({
  values: z.array(z.string()),
  evidence_quote: z.string().nullable(),
});

const DocumentClaim = z.object({
  key: z
    .string()
    .describe("Stable lowercase slug, e.g. 'transcripts', 'reference_letters'"),
  label: z.string().describe("Name of the document as the page words it"),
  required: z
    .boolean()
    .describe("True if mandatory, false if optional or conditional"),
  note: z
    .string()
    .nullable()
    .describe("Constraints the page states: how many, certified, translated, page limits"),
  evidence_quote: z.string().nullable().describe("Verbatim page text listing it"),
});

export const ProfileExtractionSchema = z.object({
  page_subject: z
    .string()
    .describe("One sentence: which programme are these pages about?"),
  page_is_about_requested_programme: z.boolean(),

  coverage: z
    .array(CoverageClaim)
    .describe(
      "What the award pays for. One entry per line of support the pages actually mention. Do not list a key the pages are silent about.",
    ),

  eligibility: z.object({
    max_age: NumberClaim.describe("Maximum age in years, null if no cap is stated"),
    min_gpa_4_scale: NumberClaim.describe(
      "Minimum GPA converted to a 4.0 scale. Null unless the page states a minimum.",
    ),
    min_work_experience_years: NumberClaim.describe(
      "Minimum years of work experience. 0 if explicitly none, null if unstated.",
    ),
    language_test_required: BooleanClaim,
    accepted_language_tests: StringsClaim.describe(
      "e.g. ['IELTS', 'TOEFL iBT']. Empty array if the pages do not say.",
    ),
    min_toefl_ibt: NumberClaim,
    min_ielts: NumberClaim,
    requires_university_admission_first: BooleanClaim.describe(
      "Must the applicant already hold an offer of admission?",
    ),
    requires_government_nomination: BooleanClaim.describe(
      "Must a government, embassy, or university nominate the applicant?",
    ),
    requires_research_proposal: BooleanClaim,
    restricted_to_nationalities: StringsClaim.describe(
      "Nationalities eligible to apply. Empty array when open to all.",
    ),
    notes: z
      .string()
      .nullable()
      .describe("Eligibility nuances that do not fit the fields above"),
  }),

  documents: z
    .array(DocumentClaim)
    .describe(
      "Every document an applicant must or may submit, in the order the pages list them. Empty array if no checklist is published.",
    ),

  post_study_obligations: TextClaim.describe(
    "Any requirement to return home, work for the funder, or serve a bond after study",
  ),
  language_training_included: BooleanClaim.describe(
    "Does the award include a language course before or during study?",
  ),

  notes_for_reviewer: z
    .string()
    .describe("Anything ambiguous or contradictory. Empty string if nothing."),
});

export type ProfileExtraction = z.infer<typeof ProfileExtractionSchema>;
