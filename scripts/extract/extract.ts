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
    extraction: CycleExtractionSchema.parse(parseJson(result.text)),
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
    extraction: ProfileExtractionSchema.parse(parseJson(result.text)),
    provider: provider.name,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
