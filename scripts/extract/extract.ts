import { renderPassages, type Passage } from "./passages.ts";
import {
  CycleExtractionSchema,
  ProfileExtractionSchema,
  type CycleExtraction,
  type ProfileExtraction,
} from "./schema.ts";
import type { ExtractionProvider } from "./providers/index.ts";

/**
 * The instruction that does the real work is the quoting rule. Everything else
 * is scaffolding around it: a value the model cannot quote is a value the
 * grounding check will throw away, so the model is told to return null instead
 * of guessing.
 *
 * These prompts are deliberately provider-neutral. They lean on explicit rules
 * rather than subtlety, because they have to work on a small open model as well
 * as a frontier one.
 */
const QUOTING_RULES = `Your output is checked mechanically. Every value you return must be accompanied by an "evidence_quote" copied EXACTLY from the page text, character for character. After you respond, each quote is searched for in the page text. If a quote is not found verbatim, that value is DISCARDED and reported as a failure.

Rules:
- Copy quotes verbatim. Do not paraphrase, reformat, fix spelling, or stitch together text from separate places.
- If the pages do not state something, return null for the value AND null for the quote. A null is correct and costs nothing. A guess is a defect.
- Never infer from a programme's usual practice, from a different year, or from your own knowledge of the programme. Only report what these pages say.
- If the pages contradict each other, return null for that field and explain in notes_for_reviewer. Do not average them or pick the nicer one.

You are given excerpts from several pages of the programme's own site, each headed by its URL. Quote from whichever page states the fact.

You are not being asked to be helpful by filling gaps. You are being asked to be accurate about what these pages state.`;

const CYCLE_SYSTEM = `You extract application-cycle dates for international scholarship programmes from their official web pages.

${QUOTING_RULES}

Dates specifically:
- Put the ISO date (YYYY-MM-DD) in "value", but keep "evidence_quote" exactly as the page words it ("6 October 2026", "Oct 6", "closes 6/10/26").
- If a date has no year and the year is unambiguous from context, use it and say so in notes_for_reviewer. If it is ambiguous, return null.
- If the pages show several cycles, take the one currently open or next to open, and name it in cycle_label.

The timeline is not a summary — it is the whole published schedule. Include EVERY stage the pages name: applications opening, the closing deadline, reference deadlines, sifting, interview windows, results and notification dates, conditional offers, award confirmation, course start. A stage the pages name but do not date still belongs in the array with a null date; that tells a student the stage exists. Order them as they occur.`;

const PROFILE_SYSTEM = `You extract the funding, eligibility, and document requirements of international scholarship programmes from their official web pages.

${QUOTING_RULES}

Coverage:
- One entry per line of support the pages actually discuss. If the pages never mention airfare, do not return an airfare entry at all — an omission means "not stated", which is different from "not covered".
- Only set covered=false when the pages explicitly say the award does NOT pay for something.
- Put the figure in "detail" exactly as published, with its currency and period: "GBP 1,347 per month", "up to JPY 150,000", "one return economy flight". Never convert currencies and never round.

Eligibility:
- A boolean is NOT a default. Return null for any true/false field the pages do not address. false means the pages explicitly say the thing is not needed ("no work experience is required", "you do not need an offer of admission before applying"). Answering false because the pages are silent is the most common way to fail this task: there is no quote for it, so the value is discarded anyway.
- Numbers must be stated on the page. If it says "a good honours degree" with no GPA, min_gpa_4_scale is null.
- min_work_experience_years is 0 only when the pages say no experience is needed; if they are silent, it is null.
- restricted_to_nationalities lists nationalities eligible to apply. Leave it empty when the programme is open to all — a long country list on the page is only a restriction if the page presents it as one.

Documents:
- List every document the pages tell an applicant to prepare or submit, in the order given.
- required=false for anything the pages describe as optional, conditional, or "if applicable".
- Put constraints in "note": how many copies, certified, translated, word or page limits, who must write it.

Scope of the award:
- fields_of_study is a RESTRICTION on the ACADEMIC SUBJECT you may study, and nothing else. Fill it only when the pages say an applicant in the wrong subject is ineligible: "open only to applicants in STEM disciplines", "for students of public policy", "applications outside these faculties will not be considered".
- These are NOT subject restrictions, and must be left out:
  - thematic priorities, focus areas, or "areas of impact" the funder cares about ("climate change and sustainability", "economic growth", "human rights") — an applicant in any subject can work on these;
  - what the funder would "welcome", "encourage", "prefer", or "particularly like to see";
  - a list of example, popular, or eligible COURSES;
  - the departments that happen to host past recipients.
  If in doubt, leave it empty. An empty list means "open to any subject", so a wrong entry here hides the award from students who are in fact eligible — the costliest direction to be wrong in.
- award_duration and number_of_awards are copied as the page words them, with their qualifiers: "up to 3 years", "the normal duration of the programme", "approximately 1,500 annually". Never convert a duration into a number of years and never turn "around 1,500" into 1500.
- If the pages state a figure only for a different award on the same site, that is not this programme's figure. Return null.`;

/**
 * The second look, for facts the first read did not come home with.
 *
 * The whole prompt is a narrowing. The model is told exactly which slots are
 * empty, given passages retrieved for those slots specifically, and told that
 * everything else is already answered — so its output budget and its attention
 * both go to the handful of things still missing instead of being spread over
 * twenty-five.
 *
 * The pressure this creates is obvious and is addressed head-on in the last
 * paragraph: an instruction to go and find things is an invitation to invent
 * them. The quoting rules still apply, grounding still runs, and "the pages do
 * not say" is stated to be a winning answer rather than a failed one — because
 * on the next run the alternative is a fabricated stipend on a student's
 * budget.
 */
const GAP_SYSTEM = `${PROFILE_SYSTEM}

THIS IS A SECOND PASS. A first read of this programme's pages has already been done, and most of what it found is settled. You are being asked about the specific facts it did NOT find, and about nothing else.

- The excerpts below were retrieved for these missing facts specifically. Some of them the first read never saw; some it saw and passed over.
- Answer ONLY the fields listed in the request. Every other field must be null, and every other list empty — those are already settled, and any value you give them is discarded unread. This includes the booleans: null, never false. Returning false for a field you were not asked about is the single most common way to waste this call.
- Look carefully at wording that states a fact indirectly. "Applicants must have been born on or after 1 January 1991" is an age limit. "Awards are tenable for the normal duration of the course" is a duration. "You must have secured an unconditional offer" means admission is required first.

If, having looked, the pages do not state one of these facts, return null for it. That is a complete and correct answer to this request, and it is the answer we expect for several of them. This pass exists to find facts that were missed, not to produce a value for every field: a null we can trust is worth more than a plausible number, and every value you return will be checked against the page text before it is kept.`;

export interface ExtractionResult<T> {
  extraction: T;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Small models sometimes wrap JSON in prose or a code fence. */
function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`Response was not JSON: ${trimmed.slice(0, 200)}`);
    }
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

/**
 * Repairs the shapes a provider without schema enforcement gets wrong.
 *
 * Groq's `llama-3.3-70b-versatile` rejects `json_schema` mode and falls back to
 * plain `json_object`, so nothing constrains its output. Zod then rejects the
 * WHOLE response over one malformed corner — and a complete, correct,
 * fully-quoted profile was being thrown away because of it. Escalation was
 * configured, paid for in wall-clock, and could not land.
 *
 * Exactly two repairs, both of which throw information away rather than inventing
 * any:
 *
 *   CONFIDENCE, when it is missing or not one of the three values. It is a
 *   self-assessment recorded on the evidence for a reviewer to read, and
 *   nothing in this pipeline gates on it. Unknown becomes "low".
 *
 *   COVERAGE ENTRIES WITH A NULL `covered`. The schema asks for the item to be
 *   OMITTED when the pages are silent; a model without schema enforcement says
 *   the same thing by returning null instead. Either way it is not a claim, so
 *   it is dropped — which is what omitting it would have done.
 *
 * Everything else malformed still fails loudly, because everything else
 * malformed is a value we would otherwise have to trust.
 */
function repairConfidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(repairConfidence);
  if (typeof value !== "object" || value === null) return value;

  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, child]) =>
      key === "confidence" && !CONFIDENCE_VALUES.has(child as string)
        ? [key, "low"]
        : [key, repairConfidence(child)],
  );

  return Object.fromEntries(entries);
}

/**
 * The shape of "I did not answer this", per claim kind.
 *
 * A provider running without schema enforcement omits fields rather than
 * returning their null form, and zod then rejects the entire response. An
 * omitted field is not an unknown value — for this schema it is precisely a
 * null claim with no quote, which is what these fill in. Nothing is invented:
 * a filled slot carries no value and no evidence, so grounding has nothing to
 * keep and the field stays empty exactly as if the model had said so.
 */
const NULL_CLAIM = { value: null, evidence_quote: null };
const NULL_TEXT_CLAIM = { value: null, evidence_quote: null, confidence: "low" };
const NULL_LIST_CLAIM = { values: [], evidence_quote: null };

/**
 * `page_is_about_requested_programme` defaults to FALSE on purpose.
 *
 * It is the guard that stops a redirect or a cookie wall being read as the
 * programme. A model that did not answer it has not vouched for the page, and
 * the whole point of failing closed is that silence is not assent.
 */
const CYCLE_SKELETON: Record<string, unknown> = {
  page_subject: "",
  page_is_about_requested_programme: false,
  cycle_label: NULL_TEXT_CLAIM,
  opens_date: NULL_TEXT_CLAIM,
  deadline_date: NULL_TEXT_CLAIM,
  timeline: [],
  notes_for_reviewer: "",
};

const ELIGIBILITY_SKELETON: Record<string, unknown> = {
  max_age: NULL_CLAIM,
  min_gpa_4_scale: NULL_CLAIM,
  min_work_experience_years: NULL_CLAIM,
  language_test_required: NULL_CLAIM,
  accepted_language_tests: NULL_LIST_CLAIM,
  min_toefl_ibt: NULL_CLAIM,
  min_ielts: NULL_CLAIM,
  requires_university_admission_first: NULL_CLAIM,
  requires_government_nomination: NULL_CLAIM,
  requires_research_proposal: NULL_CLAIM,
  restricted_to_nationalities: NULL_LIST_CLAIM,
  notes: null,
};

const PROFILE_SKELETON: Record<string, unknown> = {
  page_subject: "",
  page_is_about_requested_programme: false,
  coverage: [],
  eligibility: ELIGIBILITY_SKELETON,
  documents: [],
  post_study_obligations: NULL_TEXT_CLAIM,
  language_training_included: NULL_CLAIM,
  fields_of_study: NULL_LIST_CLAIM,
  award_duration: NULL_TEXT_CLAIM,
  number_of_awards: NULL_TEXT_CLAIM,
  notes_for_reviewer: "",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Model output over the skeleton: anything it answered wins. */
function fill(
  skeleton: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const answered = asRecord(value) ?? {};
  const merged: Record<string, unknown> = { ...skeleton };

  for (const [key, provided] of Object.entries(answered)) {
    if (provided !== undefined && provided !== null) merged[key] = provided;
  }

  return merged;
}

export function repairCycle(value: unknown): unknown {
  return fill(CYCLE_SKELETON, repairConfidence(value));
}

export function repairProfile(value: unknown): unknown {
  const filled = fill(PROFILE_SKELETON, repairConfidence(value));

  filled.eligibility = fill(ELIGIBILITY_SKELETON, filled.eligibility);

  // A coverage entry whose `covered` is null is not a claim. The schema asks
  // for the item to be OMITTED when the pages are silent; an unconstrained
  // model says the same thing by returning null, and dropping it is what
  // omitting it would have done.
  if (Array.isArray(filled.coverage)) {
    filled.coverage = filled.coverage.filter(
      (item) => typeof asRecord(item)?.covered === "boolean",
    );
  }

  return filled;
}

function corpusFor(passages: Passage[]): { corpus: string; pageCount: number } {
  return {
    corpus: renderPassages(passages),
    pageCount: new Set(passages.map((passage) => passage.url)).size,
  };
}

export async function extractCycle(
  provider: ExtractionProvider,
  scholarshipTitle: string,
  country: string,
  passages: Passage[],
): Promise<ExtractionResult<CycleExtraction>> {
  const { corpus, pageCount } = corpusFor(passages);

  const result = await provider.complete({
    system: CYCLE_SYSTEM,
    user: `Programme: ${scholarshipTitle}\nCountry: ${country}\n\nBelow are the date-relevant excerpts from ${pageCount} page(s) of this programme's official site. Extract the application cycle dates and the full published timeline.\n\n--- BEGIN EXCERPTS ---\n${corpus}\n--- END EXCERPTS ---`,
    schemaName: "scholarship_cycle_extraction",
    schema: CycleExtractionSchema,
    // What the JSON actually needs. Providers that must reserve more (thinking
    // models) raise it themselves; providers billed per minute must not.
    maxTokens: 3_000,
  });

  return {
    // Validate rather than trust: structured output constrains the shape, but
    // this is the boundary where a malformed response should fail loudly.
    extraction: CycleExtractionSchema.parse(repairCycle(parseJson(result.text))),
    provider: provider.name,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

export async function extractProfile(
  provider: ExtractionProvider,
  scholarshipTitle: string,
  country: string,
  passages: Passage[],
): Promise<ExtractionResult<ProfileExtraction>> {
  const { corpus, pageCount } = corpusFor(passages);

  const result = await provider.complete({
    system: PROFILE_SYSTEM,
    user: `Programme: ${scholarshipTitle}\nCountry: ${country}\n\nBelow are the eligibility, funding, and application excerpts from ${pageCount} page(s) of this programme's official site. Extract what the award covers, who may apply, and what they must submit.\n\n--- BEGIN EXCERPTS ---\n${corpus}\n--- END EXCERPTS ---`,
    schemaName: "scholarship_profile_extraction",
    schema: ProfileExtractionSchema,
    // Three lists, each item carrying its own quote: this response is several
    // times the size of the cycle one.
    maxTokens: 6_000,
  });

  return {
    extraction: ProfileExtractionSchema.parse(repairProfile(parseJson(result.text))),
    provider: provider.name,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

/**
 * Re-reads the crawl for a named list of missing facts.
 *
 * Same schema as the full profile call on purpose. A narrower schema would need
 * its own parsing, its own grounding, and its own way of being wrong; reusing
 * this one means the reply goes through `groundProfile` unchanged and the
 * caller merges it fill-only. The narrowing lives in the prompt and in which
 * passages were retrieved, which is where it belongs.
 */
export async function extractProfileGaps(
  provider: ExtractionProvider,
  scholarshipTitle: string,
  country: string,
  passages: Passage[],
  wanted: string,
): Promise<ExtractionResult<ProfileExtraction>> {
  const { corpus, pageCount } = corpusFor(passages);

  const result = await provider.complete({
    system: GAP_SYSTEM,
    user: `Programme: ${scholarshipTitle}\nCountry: ${country}\n\nThe first read of this programme's pages did not find the following. Look for each one in the excerpts below:\n\n${wanted}\n\nThese excerpts were pulled from ${pageCount} page(s) of the programme's official site for these facts specifically.\n\n--- BEGIN EXCERPTS ---\n${corpus}\n--- END EXCERPTS ---`,
    schemaName: "scholarship_profile_extraction",
    schema: ProfileExtractionSchema,
    // Smaller than the full profile call: most of this response is nulls for
    // fields the first pass already settled.
    maxTokens: 4_000,
  });

  return {
    extraction: ProfileExtractionSchema.parse(repairProfile(parseJson(result.text))),
    provider: provider.name,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
