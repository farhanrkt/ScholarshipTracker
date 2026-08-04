import { normalise, type FetchedPage } from "./page.ts";
import {
  GROUNDED_FIELDS,
  type CycleExtraction,
  type GroundedField,
  type ProfileExtraction,
} from "./schema.ts";
import type {
  ChecklistDocument,
  CoverageItem,
  CoverageKey,
  EligibilityFlags,
} from "../../src/lib/types/database.ts";

/**
 * Grounding: verify that every claimed value is backed by text that genuinely
 * appears on one of the pages we fetched.
 *
 * This is the control that separates "the model read it" from "the model
 * produced something plausible". It is a string search, not a judgement call —
 * which is exactly why it is trustworthy. A hallucinated deadline comes with a
 * hallucinated quote, and a hallucinated quote is on none of the pages.
 *
 * Failing closed is deliberate: an ungrounded value is dropped, not flagged for
 * someone to notice later.
 *
 * Searching every crawled page (not just the passages we sent) also tells us
 * WHICH page stated each date — that page becomes the row's `source_url`, so a
 * re-checker lands on the timeline page rather than the homepage.
 */

export interface FieldEvidence {
  quote: string | null;
  grounded: boolean;
  confidence: "high" | "medium" | "low";
  /** The page whose text contains this quote. */
  source_url: string | null;
}

export interface GroundedExtraction {
  proposed: {
    cycle_label: string | null;
    opens_date: string | null;
    deadline_date: string | null;
    timeline: Array<{
      key: string;
      label: string;
      date: string | null;
      note: string | null;
    }>;
  };
  evidence: Record<string, FieldEvidence>;
  ungroundedFields: string[];
  /**
   * Values that were KEPT but need a human eye — currently conditional
   * deadlines, where the page qualifies the date and the schema cannot.
   * Distinct from `ungroundedFields`, which were discarded.
   */
  caveats: string[];
  /** Page that actually stated the dates. Becomes the row's source_url. */
  bestSourceUrl: string;
  /**
   * A date was published to the month but not the day, and survives as an
   * undated timeline stage. Tracked explicitly because `isEmpty` would
   * otherwise read that stage as "no dates found" and bin the extraction —
   * which is the outcome the rescue exists to prevent.
   */
  hasMonthOnlyDate: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Does the quote actually evidence a full calendar date?
 *
 * Grounding proves the quote is on the page. It does NOT prove the quote
 * supports the value derived from it — and the gap between those is where real
 * damage happens:
 *
 *   page:  "Applications will open again in September 2026"
 *   value: 2026-09-01
 *
 * The quote grounds perfectly. The day is invented. A student reads "opens 1
 * September" and plans around a date nobody published.
 *
 * So a date is only kept when its day, month and year are each traceable to the
 * quote. Anything less is a month, not a date, and we do not have a month field.
 */
function datePrecision(iso: string, quote: string): {
  ok: boolean;
  missing: string[];
} {
  const [year, month, day] = iso.split("-");
  const haystack = quote.toLowerCase();
  const missing: string[] = [];

  if (!year || !haystack.includes(year)) missing.push("year");

  const monthIndex = Number(month) - 1;
  const monthName = MONTH_NAMES[monthIndex] ?? "";
  const monthMatched =
    (monthName && haystack.includes(monthName.slice(0, 3))) ||
    // Numeric forms: 6/10/26, 2026-10-06, 06.10.2026
    new RegExp(`\\b0?${Number(month)}\\b`).test(haystack);
  if (!monthMatched) missing.push("month");

  const dayNumber = Number(day);
  // Standalone, or with an ordinal suffix ("8th", "1st"), or zero-padded.
  const dayMatched = new RegExp(
    `\\b0?${dayNumber}(st|nd|rd|th)?\\b`,
  ).test(haystack);
  if (!dayMatched) missing.push("day");

  return { ok: missing.length === 0, missing };
}

/**
 * Language that means "it depends" — a real deadline the page qualifies rather
 * than a single date.
 *
 * Gates Cambridge publishes "either Tuesday 8th December 2026 or Wednesday 6th
 * January 2027 (see Course Directory)". Both dates are genuine, the quote
 * grounds, and picking one silently drops the condition that decides which
 * applies. The schema cannot express this, so the reviewer must see it.
 */
const CONDITIONAL = /\b(either|depend(s|ent|ing)? on|whichever|varies|see the course|course directory|check with|differs by)\b/i;

interface NormalisedPage {
  url: string;
  text: string;
}

/**
 * Returns the URL of the first page containing the quote, or null.
 *
 * Very short quotes ("2026") match by accident on almost any page, so they do
 * not count as evidence at all.
 */
function locateQuote(pages: NormalisedPage[], quote: string | null): string | null {
  if (!quote) return null;

  const needle = normalise(quote);
  if (needle.length < 8) return null;

  return pages.find((page) => page.text.includes(needle))?.url ?? null;
}

export function groundExtraction(
  extraction: CycleExtraction,
  pages: FetchedPage[],
  entryUrl: string,
): GroundedExtraction {
  // Normalise once: this runs against every quote and every timeline stage.
  const corpus: NormalisedPage[] = pages.map((page) => ({
    url: page.url,
    text: normalise(page.text),
  }));

  const evidence: Record<string, FieldEvidence> = {};
  const ungroundedFields: string[] = [];
  const caveats: string[] = [];

  const keep: Record<GroundedField, string | null> = {
    cycle_label: null,
    opens_date: null,
    deadline_date: null,
  };
  const sourceFor: Partial<Record<GroundedField, string>> = {};

  /**
   * Dates the page states to the MONTH but not the day.
   *
   * "Applications will open again in September 2026" is a real, quoted,
   * grounded fact, and the precision rule below correctly refuses to turn it
   * into 2026-09-01 — a day nobody published. But refusing the day is not a
   * reason to discard the month: "opens in September" is most of what a student
   * planning a year ahead actually needs, and dropping it silently was leaving
   * the row emptier than the page.
   *
   * So it becomes an undated timeline stage carrying the page's own wording.
   * The schema already models exactly this — a named stage with a null date —
   * so nothing has to be invented and no column has to change.
   */
  const monthOnly: GroundedExtraction["proposed"]["timeline"] = [];

  const STAGE_FOR: Record<GroundedField, { key: string; label: string } | null> = {
    cycle_label: null,
    opens_date: { key: "opens", label: "Applications open" },
    deadline_date: { key: "closes", label: "Applications close" },
  };

  for (const field of GROUNDED_FIELDS) {
    const claim = extraction[field];
    const sourceUrl = locateQuote(corpus, claim.evidence_quote);

    evidence[field] = {
      quote: claim.evidence_quote,
      grounded: sourceUrl !== null,
      confidence: claim.confidence,
      source_url: sourceUrl,
    };

    if (claim.value === null) continue;

    // A date that is not a real ISO date is dropped regardless of its quote.
    if (field !== "cycle_label" && !ISO_DATE.test(claim.value)) {
      ungroundedFields.push(`${field} (malformed date "${claim.value}")`);
      continue;
    }

    if (!sourceUrl) {
      ungroundedFields.push(
        `${field} (claimed "${claim.value}", quote not found on any fetched page)`,
      );
      continue;
    }

    // The quote is real — but does it actually say this date?
    if (field !== "cycle_label") {
      const precision = datePrecision(claim.value, claim.evidence_quote ?? "");
      if (!precision.ok) {
        ungroundedFields.push(
          `${field} (claimed "${claim.value}", but the quote does not state the ${precision.missing.join(" or ")} — "${claim.evidence_quote}")`,
        );

        // Only the day is missing: the month and year ARE on the page, so keep
        // them as an undated stage rather than losing the fact entirely.
        const stage = STAGE_FOR[field];
        if (stage && precision.missing.length === 1 && precision.missing[0] === "day") {
          monthOnly.push({
            ...stage,
            date: null,
            note: `The page gives the month but not the day: "${claim.evidence_quote}"`,
          });
        }
        continue;
      }
      if (CONDITIONAL.test(claim.evidence_quote ?? "")) {
        caveats.push(
          `${field} is conditional on the page — it may not be a single date: "${claim.evidence_quote}"`,
        );
      }
    }

    keep[field] = claim.value;
    sourceFor[field] = sourceUrl;
  }

  // Timeline stages are graded individually: a dated stage needs a grounded
  // quote to keep its date, but an undated stage is still worth showing.
  let firstStageSource: string | undefined;

  const timeline = extraction.timeline.map((stage, index) => {
    const sourceUrl = locateQuote(corpus, stage.evidence_quote);
    const validDate = stage.date !== null && ISO_DATE.test(stage.date);

    evidence[`timeline.${stage.key}`] = {
      quote: stage.evidence_quote,
      grounded: sourceUrl !== null,
      confidence: "high",
      source_url: sourceUrl,
    };

    if (stage.date !== null && !(sourceUrl && validDate)) {
      ungroundedFields.push(
        `timeline[${index}].${stage.key} (claimed "${stage.date}", unsupported)`,
      );
      return { key: stage.key, label: stage.label, date: null, note: stage.note };
    }

    // Same precision rule as the top-level dates: an undated stage is fine, an
    // invented day is not.
    if (stage.date !== null) {
      const precision = datePrecision(stage.date, stage.evidence_quote ?? "");
      if (!precision.ok) {
        ungroundedFields.push(
          `timeline[${index}].${stage.key} (claimed "${stage.date}", quote lacks the ${precision.missing.join(" or ")})`,
        );
        // The stage survives without its date. When the page did give a month,
        // say so in the note — "interviews in March" is worth knowing, and the
        // alternative reads as though nothing was published at all.
        const dayOnly =
          precision.missing.length === 1 && precision.missing[0] === "day";
        return {
          key: stage.key,
          label: stage.label,
          date: null,
          note: dayOnly
            ? `${stage.note ? `${stage.note} · ` : ""}The page gives the month but not the day: "${stage.evidence_quote}"`
            : stage.note,
        };
      }
      if (CONDITIONAL.test(stage.evidence_quote ?? "")) {
        caveats.push(
          `timeline "${stage.label}" is conditional: "${stage.evidence_quote}"`,
        );
      }
    }

    if (sourceUrl && stage.date) firstStageSource ??= sourceUrl;

    return {
      key: stage.key,
      label: stage.label,
      date: stage.date,
      note: stage.note,
    };
  });

  // Rescued month-only dates go in only where the model did not already publish
  // a stage of the same name — its own timeline entry is the better record.
  const named = new Set(timeline.map((stage) => stage.key));
  for (const stage of monthOnly) {
    if (named.has(stage.key)) continue;
    named.add(stage.key);
    timeline.push(stage);
  }

  return {
    proposed: {
      cycle_label: keep.cycle_label,
      opens_date: keep.opens_date,
      deadline_date: keep.deadline_date,
      timeline,
    },
    evidence,
    ungroundedFields,
    caveats,
    // Prefer the page that stated the closing date — that is the page a human
    // re-verifying this row needs to open.
    bestSourceUrl:
      sourceFor.deadline_date ??
      sourceFor.opens_date ??
      firstStageSource ??
      sourceFor.cycle_label ??
      entryUrl,
    hasMonthOnlyDate: monthOnly.length > 0,
  };
}

/**
 * True when the cycle extraction produced nothing worth a reviewer's time.
 *
 * A timeline of purely undated stages counts as nothing — a list of stage names
 * with no dates tells a reviewer only that the programme has stages. A rescued
 * month-only date is different: it is a quoted fact about WHEN, just not to the
 * day, and it is exactly what this row was missing.
 */
export function isEmpty(grounded: GroundedExtraction): boolean {
  const { opens_date, deadline_date, timeline } = grounded.proposed;
  if (grounded.hasMonthOnlyDate) return false;
  return (
    opens_date === null &&
    deadline_date === null &&
    timeline.every((stage) => stage.date === null)
  );
}

/* -------------------------------------------------------------------------- */
/* Programme profile                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The same contract as the dates, applied to money and requirements.
 *
 * The failure mode here is quieter than a wrong deadline but not much kinder: a
 * plausible-looking stipend figure nobody published sends a student to a
 * country on a budget that does not exist. So a coverage line, an eligibility
 * threshold, and a checklist item each live or die by a quote found on the
 * page — and for anything numeric, by whether the quote contains that number.
 */

export interface GroundedProfile {
  proposed: {
    coverage_matrix: Partial<Record<CoverageKey, CoverageItem>>;
    eligibility_flags: Partial<EligibilityFlags>;
    document_checklist: ChecklistDocument[];
    post_study_obligations: string | null;
    language_training_included: boolean | null;
    fields_of_study: string[];
    award_duration: string | null;
    number_of_awards: string | null;
  };
  evidence: Record<string, FieldEvidence>;
  ungroundedFields: string[];
  caveats: string[];
}

/**
 * Words that are numbers.
 *
 * Eligibility pages overwhelmingly spell small numbers out — "a minimum of five
 * years of full-time professional experience", "under the age of thirty-five".
 * A digits-only check called those unsupported and threw away correctly
 * extracted, properly quoted values: the quote was real, the number was real,
 * and the comparison was the only thing that failed.
 */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Every number the text states, in digits or in words.
 *
 * "1,347" -> 1347. "five" -> 5. "twenty-five" -> 25 (and also 20 and 5, since
 * the parts are legitimate readings too and this list is only ever searched,
 * never summed).
 */
function numbersIn(text: string): number[] {
  const found = (text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [])
    .map((token) => Number(token.replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));

  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const [index, word] of words.entries()) {
    const value = NUMBER_WORDS[word];
    if (value === undefined) continue;

    found.push(value);

    // "twenty-five" and "twenty five" both arrive here as two tokens.
    const next = NUMBER_WORDS[words[index + 1] ?? ""];
    if (value >= 20 && value % 10 === 0 && next !== undefined && next < 10) {
      found.push(value + next);
    }
  }

  return found;
}

/**
 * Does the quote actually contain this number?
 *
 * Compared numerically, not as text, so "3.0" in the page supports a claimed
 * 3 and "1,347" supports 1347. A claim whose number is absent from its own
 * quote is the profile equivalent of an invented day-of-month.
 */
function numberSupported(value: number, quote: string): boolean {
  return numbersIn(quote).some((found) => found === value);
}

/** Every figure in a free-text detail must appear in the quote backing it. */
function detailSupported(detail: string, quote: string): boolean {
  const available = numbersIn(quote);
  return numbersIn(detail).every((needed) =>
    available.some((found) => found === needed),
  );
}

/**
 * Is this named thing in the quote, allowing for the acronym convention?
 *
 * A page writes "Test of English as a Foreign Language (TOEFL)" and the model
 * returns either the full name or the acronym; a quote containing one does not
 * literally contain the other. Requiring an exact substring discarded a value
 * whose evidence was sitting right there.
 *
 * Both readings are checked against the quote, so this loosens the comparison
 * without loosening the requirement: the quote must still be verbatim page
 * text, and the name must still appear in it in one of the two forms the page
 * itself offered.
 */
function nameSupported(value: string, normalisedQuote: string): boolean {
  const candidates = [value];

  const parenthesised = /\(([^)]+)\)/.exec(value)?.[1];
  if (parenthesised) {
    candidates.push(parenthesised);
    candidates.push(value.replace(/\s*\([^)]*\)\s*/, " "));
  }

  return candidates.some((candidate) => {
    const needle = normalise(candidate);
    return needle.length >= 2 && normalisedQuote.includes(needle);
  });
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 48) || "document"
  );
}

export function groundProfile(
  profile: ProfileExtraction,
  pages: FetchedPage[],
): GroundedProfile {
  const corpus: NormalisedPage[] = pages.map((page) => ({
    url: page.url,
    text: normalise(page.text),
  }));

  const evidence: Record<string, FieldEvidence> = {};
  const ungroundedFields: string[] = [];
  const caveats: string[] = [];

  const record = (
    field: string,
    quote: string | null,
    sourceUrl: string | null,
  ) => {
    evidence[field] = {
      quote,
      grounded: sourceUrl !== null,
      confidence: "high",
      source_url: sourceUrl,
    };
  };

  /* ------------------------------------------------------------ coverage */

  const coverage: Partial<Record<CoverageKey, CoverageItem>> = {};

  for (const claim of Array.isArray(profile.coverage) ? profile.coverage : []) {
    const field = `coverage.${claim.key}`;
    const sourceUrl = locateQuote(corpus, claim.evidence_quote);
    record(field, claim.evidence_quote, sourceUrl);

    if (!sourceUrl) {
      ungroundedFields.push(
        `${field} (claimed ${claim.covered ? "covered" : "not covered"}, quote not found on any fetched page)`,
      );
      continue;
    }

    // The line itself is grounded; its figure is judged separately, because a
    // real "covers a monthly stipend" quote does not license an invented
    // amount next to it.
    let detail = claim.detail;
    if (detail && !detailSupported(detail, claim.evidence_quote ?? "")) {
      ungroundedFields.push(
        `${field} detail (claimed "${detail}", but the quote does not contain that figure — "${claim.evidence_quote}")`,
      );
      detail = null;
    }

    coverage[claim.key] = { covered: claim.covered, detail };
  }

  /* --------------------------------------------------------- eligibility */

  const flags: Partial<EligibilityFlags> = {};
  const eligibility = profile.eligibility;

  const numeric: Array<[keyof EligibilityFlags, { value: number | null; evidence_quote: string | null }]> = [
    ["max_age", eligibility.max_age],
    ["min_gpa_4_scale", eligibility.min_gpa_4_scale],
    ["min_work_experience_years", eligibility.min_work_experience_years],
    ["min_toefl_ibt", eligibility.min_toefl_ibt],
    ["min_ielts", eligibility.min_ielts],
  ];

  for (const [key, claim] of numeric) {
    const field = `eligibility.${key}`;
    const sourceUrl = locateQuote(corpus, claim.evidence_quote);
    record(field, claim.evidence_quote, sourceUrl);

    if (typeof claim.value !== "number") continue;
    if (!sourceUrl) {
      ungroundedFields.push(
        `${field} (claimed ${claim.value}, quote not found on any fetched page)`,
      );
      continue;
    }
    // Zero is the one numeric claim a page states in words — "no work
    // experience is required" — so it cannot be held to the digit check.
    if (claim.value !== 0 && !numberSupported(claim.value, claim.evidence_quote ?? "")) {
      ungroundedFields.push(
        `${field} (claimed ${claim.value}, but the quote does not state that number — "${claim.evidence_quote}")`,
      );
      continue;
    }

    Object.assign(flags, { [key]: claim.value });
  }

  const booleans: Array<[keyof EligibilityFlags, { value: boolean | null; evidence_quote: string | null }]> = [
    ["language_test_required", eligibility.language_test_required],
    ["requires_university_admission_first", eligibility.requires_university_admission_first],
    ["requires_government_nomination", eligibility.requires_government_nomination],
    ["requires_research_proposal", eligibility.requires_research_proposal],
  ];

  for (const [key, claim] of booleans) {
    const field = `eligibility.${key}`;
    const sourceUrl = locateQuote(corpus, claim.evidence_quote);
    record(field, claim.evidence_quote, sourceUrl);

    if (typeof claim.value !== "boolean") continue;
    if (!sourceUrl) {
      ungroundedFields.push(
        `${field} (claimed ${claim.value}, quote not found on any fetched page)`,
      );
      continue;
    }

    Object.assign(flags, { [key]: claim.value });
  }

  // List values are kept item by item: a quote naming IELTS and TOEFL grounds
  // those two and not a third the model added.
  const lists: Array<[keyof EligibilityFlags, { values: string[]; evidence_quote: string | null }]> = [
    ["accepted_language_tests", eligibility.accepted_language_tests],
    ["restricted_to_nationalities", eligibility.restricted_to_nationalities],
  ];

  for (const [key, claim] of lists) {
    const field = `eligibility.${key}`;
    const sourceUrl = locateQuote(corpus, claim.evidence_quote);
    record(field, claim.evidence_quote, sourceUrl);

    const values = Array.isArray(claim.values) ? claim.values : [];
    if (values.length === 0) continue;
    if (!sourceUrl) {
      ungroundedFields.push(
        `${field} (claimed ${values.length} value(s), quote not found on any fetched page)`,
      );
      continue;
    }

    const quote = normalise(claim.evidence_quote ?? "");
    const supported = values.filter((value) => nameSupported(value, quote));
    const dropped = values.filter((value) => !supported.includes(value));

    if (dropped.length > 0) {
      ungroundedFields.push(
        `${field} (dropped ${dropped.map((value) => `"${value}"`).join(", ")} — not in the quote)`,
      );
    }
    if (supported.length > 0) Object.assign(flags, { [key]: supported });
  }

  if (typeof eligibility.notes === "string" && eligibility.notes.trim()) {
    flags.notes = eligibility.notes.trim();
  }

  /* ------------------------------------------------------------ documents */

  const documents: ChecklistDocument[] = [];
  const usedKeys = new Set<string>();

  for (const [index, claim] of (
    Array.isArray(profile.documents) ? profile.documents : []
  ).entries()) {
    const label = typeof claim.label === "string" ? claim.label.trim() : "";
    if (!label) continue;

    const field = `documents[${index}]`;
    const sourceUrl = locateQuote(corpus, claim.evidence_quote);
    record(`${field}.${slugify(label)}`, claim.evidence_quote, sourceUrl);

    if (!sourceUrl) {
      ungroundedFields.push(
        `${field} (claimed "${label}", quote not found on any fetched page)`,
      );
      continue;
    }

    // Keys become the ids in `checklist_progress`, so a collision would make
    // two documents tick as one.
    let key = slugify(claim.key || label);
    while (usedKeys.has(key)) key = `${key}_${documents.length}`;
    usedKeys.add(key);

    documents.push({
      key,
      label,
      required: claim.required !== false,
      notes: claim.note?.trim() || null,
    });
  }

  /* ---------------------------------------------------------------- rest */

  const obligations = profile.post_study_obligations;
  const obligationsSource = locateQuote(corpus, obligations.evidence_quote);
  record("post_study_obligations", obligations.evidence_quote, obligationsSource);

  let postStudy: string | null = null;
  if (typeof obligations.value === "string" && obligations.value.trim()) {
    if (obligationsSource) {
      postStudy = obligations.value.trim();
    } else {
      ungroundedFields.push(
        `post_study_obligations (claimed "${obligations.value}", quote not found on any fetched page)`,
      );
    }
  }

  const training = profile.language_training_included;
  const trainingSource = locateQuote(corpus, training.evidence_quote);
  record("language_training_included", training.evidence_quote, trainingSource);

  let languageTraining: boolean | null = null;
  if (typeof training.value === "boolean") {
    if (trainingSource) {
      languageTraining = training.value;
    } else {
      ungroundedFields.push(
        `language_training_included (claimed ${training.value}, quote not found on any fetched page)`,
      );
    }
  }

  /* ------------------------------------------------- scope of the award */

  /**
   * Duration and award count are quoted prose carrying a figure, so they are
   * held to the same rule as a stipend amount: the quote must be on a page, and
   * every number in the value must be in the quote. "Up to 3 years" backed by a
   * quote that says two is exactly the kind of near-miss that reads as
   * authoritative and is wrong.
   */
  const scopeText = (
    field: string,
    claim: { value: string | null; evidence_quote: string | null },
  ): string | null => {
    const sourceUrl = locateQuote(corpus, claim.evidence_quote);
    record(field, claim.evidence_quote, sourceUrl);

    const value = typeof claim.value === "string" ? claim.value.trim() : "";
    if (!value) return null;

    if (!sourceUrl) {
      ungroundedFields.push(
        `${field} (claimed "${value}", quote not found on any fetched page)`,
      );
      return null;
    }
    if (!detailSupported(value, claim.evidence_quote ?? "")) {
      ungroundedFields.push(
        `${field} (claimed "${value}", but the quote does not contain that figure — "${claim.evidence_quote}")`,
      );
      return null;
    }
    return value;
  };

  const awardDuration = scopeText("award_duration", profile.award_duration);
  const numberOfAwards = scopeText("number_of_awards", profile.number_of_awards);

  const fieldsClaim = profile.fields_of_study;
  const fieldsSource = locateQuote(corpus, fieldsClaim.evidence_quote);
  record("fields_of_study", fieldsClaim.evidence_quote, fieldsSource);

  let fieldsOfStudy: string[] = [];
  const claimedFields = Array.isArray(fieldsClaim.values) ? fieldsClaim.values : [];
  if (claimedFields.length > 0) {
    if (!fieldsSource) {
      ungroundedFields.push(
        `fields_of_study (claimed ${claimedFields.length} value(s), quote not found on any fetched page)`,
      );
    } else {
      const quote = normalise(fieldsClaim.evidence_quote ?? "");
      fieldsOfStudy = claimedFields.filter((value) => nameSupported(value, quote));
      const dropped = claimedFields.filter((value) => !fieldsOfStudy.includes(value));
      if (dropped.length > 0) {
        ungroundedFields.push(
          `fields_of_study (dropped ${dropped.map((value) => `"${value}"`).join(", ")} — not in the quote)`,
        );
      }
    }
  }

  // Conditional language means the same thing here as it does for a deadline:
  // the value is real, and something on the page decides when it applies.
  for (const [field, quote] of Object.entries(evidence)) {
    if (quote.grounded && quote.quote && CONDITIONAL.test(quote.quote)) {
      caveats.push(`${field} is conditional on the page: "${quote.quote}"`);
    }
  }

  return {
    proposed: {
      coverage_matrix: coverage,
      eligibility_flags: flags,
      document_checklist: documents,
      post_study_obligations: postStudy,
      language_training_included: languageTraining,
      fields_of_study: fieldsOfStudy,
      award_duration: awardDuration,
      number_of_awards: numberOfAwards,
    },
    evidence,
    ungroundedFields,
    caveats,
  };
}

/** True when nothing in the profile survived grounding. */
export function isEmptyProfile(profile: GroundedProfile): boolean {
  const {
    coverage_matrix,
    eligibility_flags,
    document_checklist,
    fields_of_study,
  } = profile.proposed;
  return (
    Object.keys(coverage_matrix).length === 0 &&
    Object.keys(eligibility_flags).length === 0 &&
    document_checklist.length === 0 &&
    fields_of_study.length === 0 &&
    profile.proposed.post_study_obligations === null &&
    profile.proposed.language_training_included === null &&
    profile.proposed.award_duration === null &&
    profile.proposed.number_of_awards === null
  );
}
