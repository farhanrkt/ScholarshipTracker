import type { FetchedPage } from "./page.ts";
import { toBlocks, type Passage } from "./passages.ts";
import { scoreTopics, type Topic } from "./relevance.ts";
import type { GroundedProfile } from "./ground.ts";
import type {
  CoverageKey,
  EligibilityFlags,
} from "../../src/lib/types/database.ts";

/**
 * The second look: going back for the facts the first read did not come home
 * with.
 *
 * A staged row is routinely half empty — a deadline, three coverage lines, and
 * nulls everywhere else — and the reason is almost never that the funder does
 * not publish the answer. It is one of three things, and all three are ours:
 *
 *   1. THE PASSAGE WAS NEVER SENT. Topic selection works at the scale of a
 *      page's subject matter. "Applicants must be under 35 years of age on 1
 *      September" is one sentence on a long eligibility page, and it competes
 *      for budget against everything else on that page under a single
 *      `eligibility` score that cannot tell the age sentence from the
 *      paragraph about referees.
 *   2. THE MODEL RAN OUT OF ROOM. Twenty-five facts, each carrying its own
 *      verbatim quote, is a large response. Small models drop the tail.
 *   3. THE MODEL WENT PAST IT. One ask covering money, eligibility, documents
 *      and scope gives no field its own attention.
 *
 * So this module asks a second, much narrower question: which slots are still
 * empty, what vocabulary would find each one, and what does the crawl say if we
 * look for exactly that? The retrieval here is field-level rather than
 * page-level — a phrase list per slot, scored against the same blocks the first
 * pass saw — so a single sentence buried in a page that already lost the budget
 * fight can still be found and sent.
 *
 * WHAT THIS IS NOT. It is not a second chance to guess. The reply goes through
 * `groundProfile` exactly like the first one, so anything it returns still has
 * to be quotable off a page we fetched. A field the pages genuinely do not
 * address stays null, and staying null is the correct outcome — "not stated"
 * is an honest answer and an invented stipend is not.
 */

/* -------------------------------------------------------------------------- */
/* The slots a programme row can carry                                        */
/* -------------------------------------------------------------------------- */

const COVERAGE_GAPS = [
  "coverage.tuition",
  "coverage.monthly_stipend",
  "coverage.airfare",
  "coverage.accommodation",
  "coverage.health_insurance",
  "coverage.settling_in_allowance",
  "coverage.research_grant",
  "coverage.visa_fees",
] as const;

const ELIGIBILITY_GAPS = [
  "eligibility.max_age",
  "eligibility.min_gpa_4_scale",
  "eligibility.min_work_experience_years",
  "eligibility.language_test_required",
  "eligibility.accepted_language_tests",
  "eligibility.min_toefl_ibt",
  "eligibility.min_ielts",
  "eligibility.requires_university_admission_first",
  "eligibility.requires_government_nomination",
  "eligibility.requires_research_proposal",
  "eligibility.restricted_to_nationalities",
] as const;

const OTHER_GAPS = [
  "document_checklist",
  "post_study_obligations",
  "language_training_included",
  "fields_of_study",
  "award_duration",
  "number_of_awards",
] as const;

/**
 * Every slot, in the order a reader cares about them.
 *
 * This list is also the denominator of the completeness figure in the run log.
 * `eligibility.notes` is deliberately absent: it is free prose rather than a
 * fact slot, so counting it would make a row look more complete for carrying a
 * sentence of commentary.
 */
export const GAP_FIELDS = [
  ...COVERAGE_GAPS,
  ...ELIGIBILITY_GAPS,
  ...OTHER_GAPS,
] as const;

export type GapField = (typeof GAP_FIELDS)[number];

interface GapSpec {
  /** How the prompt names the fact, in the words a page would use. */
  label: string;
  /** Topic families whose passages tend to carry it. */
  topics: Topic[];
  /**
   * Phrases that appear NEXT TO this fact specifically.
   *
   * Not synonyms for the field name — the words a site actually prints around
   * the answer. "under the age of" finds an age cap; "age" finds every page.
   */
  phrases: string[];
}

const SPECS: Record<GapField, GapSpec> = {
  /* ------------------------------------------------------------ coverage */

  "coverage.tuition": {
    label: "whether tuition fees are paid, and how much",
    topics: ["benefits"],
    phrases: [
      "tuition", "tuition fee", "tuition fees", "course fees", "fees are paid",
      "fee waiver", "waives", "university fees", "full fees", "programme fees",
      "academic fees", "enrolment fee", "registration fee",
    ],
  },
  "coverage.monthly_stipend": {
    label: "the living stipend or maintenance allowance, and its amount",
    topics: ["benefits"],
    phrases: [
      "monthly stipend", "monthly allowance", "living allowance", "stipend of",
      "maintenance allowance", "living costs", "cost of living", "subsistence",
      "per month", "monthly payment", "living expenses", "personal allowance",
    ],
  },
  "coverage.airfare": {
    label: "flights or travel to and from the host country",
    topics: ["benefits"],
    phrases: [
      "airfare", "air ticket", "return flight", "return airfare", "travel costs",
      "flight to", "economy class", "travel allowance", "transportation to",
      "return travel", "journey to", "air travel",
    ],
  },
  "coverage.accommodation": {
    label: "housing or accommodation",
    topics: ["benefits"],
    phrases: [
      "accommodation", "housing", "dormitory", "hall of residence", "lodging",
      "rent", "housing allowance", "accommodation allowance", "residence",
    ],
  },
  "coverage.health_insurance": {
    label: "health, medical or travel insurance",
    topics: ["benefits"],
    phrases: [
      "health insurance", "medical insurance", "healthcare", "medical cover",
      "travel insurance", "health cover", "medical expenses", "insurance is",
      "national health", "health surcharge",
    ],
  },
  "coverage.settling_in_allowance": {
    label: "a one-off arrival, settling-in or establishment allowance",
    topics: ["benefits"],
    phrases: [
      "settling-in", "settling in allowance", "arrival allowance", "one-off",
      "establishment allowance", "initial allowance", "relocation",
      "on arrival", "warm clothing", "excess baggage",
    ],
  },
  "coverage.research_grant": {
    label: "a research, thesis, fieldwork or study-materials grant",
    topics: ["benefits"],
    phrases: [
      "research grant", "thesis grant", "research allowance", "fieldwork",
      "study materials", "book allowance", "conference", "research costs",
      "laboratory", "dissertation costs",
    ],
  },
  "coverage.visa_fees": {
    label: "visa, immigration or residence-permit fees",
    topics: ["benefits"],
    phrases: [
      "visa fee", "visa costs", "visa application", "immigration health",
      "residence permit", "entry clearance", "visa is paid", "student visa",
    ],
  },

  /* --------------------------------------------------------- eligibility */

  "eligibility.max_age": {
    label: "an upper age limit for applicants",
    topics: ["eligibility"],
    phrases: [
      "age limit", "under the age of", "years of age", "no older than",
      "aged", "maximum age", "born on or after", "not exceed the age",
      "younger than", "age of 35", "age requirement",
    ],
  },
  "eligibility.min_gpa_4_scale": {
    label: "a minimum GPA or grade requirement",
    topics: ["eligibility"],
    phrases: [
      "gpa", "grade point average", "minimum grade", "cgpa", "class of degree",
      "upper second", "first class", "2:1", "percentage of marks",
      "academic average", "minimum score of",
    ],
  },
  "eligibility.min_work_experience_years": {
    label: "required years of work or professional experience",
    topics: ["eligibility"],
    phrases: [
      "work experience", "professional experience", "years of experience",
      "years of work", "working experience", "employment history",
      "no work experience", "hours of work experience", "career experience",
    ],
  },
  "eligibility.language_test_required": {
    label: "whether an English (or host-language) test is required",
    topics: ["eligibility", "documents"],
    phrases: [
      "english language requirement", "language requirement", "proof of english",
      "english proficiency", "language proficiency", "language test",
      "meet our english", "waive the english", "exempt from the english",
    ],
  },
  "eligibility.accepted_language_tests": {
    label: "which language tests are accepted",
    topics: ["eligibility", "documents"],
    phrases: [
      "ielts", "toefl", "pte", "duolingo", "cambridge english", "c1 advanced",
      "trinity ise", "accepted tests", "jlpt", "topik", "hsk",
    ],
  },
  "eligibility.min_toefl_ibt": {
    label: "the minimum TOEFL iBT score",
    topics: ["eligibility"],
    phrases: ["toefl", "ibt", "toefl ibt", "internet-based", "toefl score"],
  },
  "eligibility.min_ielts": {
    label: "the minimum IELTS score",
    topics: ["eligibility"],
    phrases: [
      "ielts", "overall band", "band score", "ielts score", "no band below",
      "each component",
    ],
  },
  "eligibility.requires_university_admission_first": {
    label: "whether an offer of admission is needed before applying",
    topics: ["eligibility", "process"],
    phrases: [
      "offer of admission", "unconditional offer", "conditional offer",
      "already been admitted", "must be admitted", "admission first",
      "letter of acceptance", "letter of admission", "secure a place",
      "apply separately to the university", "before applying for the scholarship",
    ],
  },
  "eligibility.requires_government_nomination": {
    label: "whether a government, embassy or university must nominate you",
    topics: ["eligibility", "process"],
    phrases: [
      "nomination", "nominated by", "embassy", "nominating", "endorsement",
      "through your government", "national selection", "designated authority",
      "recommending institution", "sending institution",
    ],
  },
  "eligibility.requires_research_proposal": {
    label: "whether a research proposal or study plan is required",
    topics: ["eligibility", "documents"],
    phrases: [
      "research proposal", "study plan", "research plan", "field of study form",
      "outline of your research", "proposed research", "research statement",
    ],
  },
  "eligibility.restricted_to_nationalities": {
    label: "which nationalities may apply",
    topics: ["eligibility"],
    phrases: [
      "eligible countries", "eligible nationalities", "citizens of",
      "nationals of", "list of countries", "country or territory",
      "open to applicants from", "must be a citizen", "passport holders",
      "developing countries", "commonwealth",
    ],
  },

  /* --------------------------------------------------------------- other */

  document_checklist: {
    label: "the documents an applicant must submit",
    topics: ["documents", "process"],
    phrases: [
      "supporting documents", "required documents", "you will need",
      "upload", "attach", "certified copy", "transcript", "reference letter",
      "letter of recommendation", "personal statement", "curriculum vitae",
      "passport", "photograph", "checklist", "submit the following",
      "documents to be submitted",
    ],
  },
  post_study_obligations: {
    label: "any obligation to return home, serve a bond, or work for the funder",
    topics: ["eligibility", "process"],
    phrases: [
      "return to your home country", "return home", "bond", "obliged to return",
      "two years", "home country for", "commitment to return", "undertaking",
      "may not remain", "residency requirement", "serve", "give back",
    ],
  },
  language_training_included: {
    label: "whether language tuition is included before or during study",
    topics: ["benefits", "process"],
    phrases: [
      "language course", "language training", "language tuition",
      "preparatory course", "pre-sessional", "intensive language",
      "language school", "foundation year", "japanese language",
      "korean language", "chinese language",
    ],
  },
  fields_of_study: {
    label: "any restriction on the academic subject you may study",
    topics: ["eligibility"],
    phrases: [
      "field of study", "fields of study", "subject areas", "disciplines",
      "eligible subjects", "restricted to", "only available for",
      "must be studying", "courses in", "faculties", "not eligible for courses",
      "excluded subjects", "stem",
    ],
  },
  award_duration: {
    label: "how long the funding lasts",
    topics: ["benefits", "eligibility"],
    phrases: [
      "duration", "length of the award", "for the duration", "up to",
      "academic year", "normal duration", "years of study", "months",
      "period of the award", "renewable", "extended",
    ],
  },
  number_of_awards: {
    label: "how many awards are offered",
    topics: ["benefits", "process"],
    phrases: [
      "awards are available", "scholarships are available", "number of awards",
      "each year", "annually", "we offer", "will be awarded", "recipients",
      "places are available", "successful applicants", "around",
    ],
  },
};

export function specFor(field: GapField): GapSpec {
  return SPECS[field];
}

/* -------------------------------------------------------------------------- */
/* Which slots are still empty                                                */
/* -------------------------------------------------------------------------- */

/**
 * The slots a grounded profile did not fill.
 *
 * A null profile — the whole call failed or nothing survived grounding — means
 * every slot is a gap, which is exactly the case a second look is worth most.
 */
export function profileGaps(
  profile: GroundedProfile["proposed"] | null,
): GapField[] {
  if (!profile) return [...GAP_FIELDS];

  const gaps: GapField[] = [];

  for (const field of COVERAGE_GAPS) {
    const key = field.slice("coverage.".length) as CoverageKey;
    if (!profile.coverage_matrix[key]) gaps.push(field);
  }

  for (const field of ELIGIBILITY_GAPS) {
    const key = field.slice("eligibility.".length) as keyof EligibilityFlags;
    const value = profile.eligibility_flags[key];
    // An empty array is not an answer: `accepted_language_tests: []` says the
    // pages named no tests, which is what "we did not find it" also looks like.
    const filled = Array.isArray(value)
      ? value.length > 0
      : value !== undefined && value !== null;
    if (!filled) gaps.push(field);
  }

  if (profile.document_checklist.length === 0) gaps.push("document_checklist");
  if (profile.post_study_obligations === null) gaps.push("post_study_obligations");
  if (profile.language_training_included === null) {
    gaps.push("language_training_included");
  }
  // fields_of_study is the one slot where empty is a real answer — it means
  // "open to any subject". It is still asked about, because "open to any
  // subject" and "nobody looked" are what we are trying to tell apart.
  if (profile.fields_of_study.length === 0) gaps.push("fields_of_study");
  if (profile.award_duration === null) gaps.push("award_duration");
  if (profile.number_of_awards === null) gaps.push("number_of_awards");

  return gaps;
}

/** Slots filled, out of the total — the completeness figure in the run log. */
export function profileCompleteness(
  profile: GroundedProfile["proposed"] | null,
): { filled: number; total: number } {
  const total = GAP_FIELDS.length;
  return { filled: total - profileGaps(profile).length, total };
}

/* -------------------------------------------------------------------------- */
/* Retrieval for a specific list of gaps                                      */
/* -------------------------------------------------------------------------- */

/**
 * A block is worth sending if it uses the vocabulary of a gap we still have.
 *
 * Phrases score much higher than topic signal because they are the point: this
 * pass exists to find the one sentence a page-level score could not isolate.
 * The topic score is a tie-break, not a qualifier — a block with no phrase hit
 * at all is not returned however on-topic it looks, or the second call simply
 * receives the first call's context again and answers the same way.
 */
function scoreBlock(text: string, gaps: GapField[]): number {
  const haystack = text.toLowerCase();
  let phraseHits = 0;
  const topics = new Set<Topic>();

  for (const gap of gaps) {
    const spec = SPECS[gap];
    let hit = false;
    for (const phrase of spec.phrases) {
      if (haystack.includes(phrase)) {
        phraseHits++;
        hit = true;
      }
    }
    if (hit) for (const topic of spec.topics) topics.add(topic);
  }

  if (phraseHits === 0) return 0;

  const scores = scoreTopics(text);
  const topical = [...topics].reduce((sum, topic) => sum + scores[topic], 0);

  return phraseHits * 10 + Math.min(topical, 30);
}

export interface GapPassageOptions {
  budgetChars: number;
  /** Text the first profile call already saw, so new material can be preferred. */
  alreadySent?: Passage[];
}

/**
 * Passages that speak to the gaps, densest first.
 *
 * Text the first call already read is not excluded — sometimes the answer was
 * in front of the model and it went past it, and re-sending three sentences
 * with a question attached is a very different prompt from re-sending forty
 * with a general one. It is DISCOUNTED, so genuinely new material wins any
 * close contest for the budget.
 */
export function selectGapPassages(
  pages: FetchedPage[],
  gaps: GapField[],
  options: GapPassageOptions,
): Passage[] {
  if (gaps.length === 0 || options.budgetChars <= 0) return [];

  const seen = new Set(
    (options.alreadySent ?? []).map((passage) => passage.text),
  );

  const scored: Array<Passage & { rank: number }> = [];

  for (const page of pages) {
    toBlocks(page.text).forEach((text, index) => {
      const score = scoreBlock(text, gaps);
      if (score <= 0) return;

      scored.push({
        url: page.url,
        text,
        score,
        // The gap pass does not route by topic; the label is carried only so
        // these passages are the same shape as the ones `renderPassages` and
        // the extraction call already handle.
        topic: "eligibility",
        index,
        rank: seen.has(text) ? score * 0.6 : score,
      });
    });
  }

  const kept: Array<Passage & { rank: number }> = [];
  let used = 0;

  for (const passage of scored.sort((a, b) => b.rank - a.rank)) {
    if (used + passage.text.length > options.budgetChars) continue;
    kept.push(passage);
    used += passage.text.length;
  }

  return kept
    .sort((a, b) => (a.url === b.url ? a.index - b.index : a.url.localeCompare(b.url)))
    .map(({ rank: _rank, ...passage }) => passage);
}

/** The gap list as the prompt asks for it: one line per fact, in page words. */
export function describeGaps(gaps: GapField[]): string {
  return gaps.map((gap) => `- ${gap}: ${SPECS[gap].label}`).join("\n");
}

/* -------------------------------------------------------------------------- */
/* Merging the second look into the first                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fill-only merge: the first reading wins every contest.
 *
 * Not because it is better, but because it read a wider context. The second
 * call is deliberately given a narrow, phrase-selected slice of the crawl —
 * good for finding a sentence, worse for judging which of two stipend figures
 * belongs to this award — so it is allowed to fill holes and never to overwrite.
 * That also keeps the pass monotonic: running it can add information and can
 * never take any away.
 */
export function mergeProfiles(
  base: GroundedProfile | null,
  extra: GroundedProfile,
): GroundedProfile {
  if (!base) return extra;

  const evidence: GroundedProfile["evidence"] = { ...extra.evidence };
  for (const [field, entry] of Object.entries(base.evidence)) {
    const incoming = evidence[field];
    // A base entry that failed grounding must not shadow one that succeeded —
    // that would hide the very quote the second look went and found.
    if (incoming?.grounded && !entry.grounded) continue;
    evidence[field] = entry;
  }

  const eligibility_flags = {
    ...extra.proposed.eligibility_flags,
    ...base.proposed.eligibility_flags,
  };

  const merged = {
    coverage_matrix: { ...extra.proposed.coverage_matrix, ...base.proposed.coverage_matrix },
    eligibility_flags,
    document_checklist:
      base.proposed.document_checklist.length > 0
        ? base.proposed.document_checklist
        : extra.proposed.document_checklist,
    post_study_obligations:
      base.proposed.post_study_obligations ?? extra.proposed.post_study_obligations,
    language_training_included:
      base.proposed.language_training_included ?? extra.proposed.language_training_included,
    fields_of_study:
      base.proposed.fields_of_study.length > 0
        ? base.proposed.fields_of_study
        : extra.proposed.fields_of_study,
    award_duration: base.proposed.award_duration ?? extra.proposed.award_duration,
    number_of_awards: base.proposed.number_of_awards ?? extra.proposed.number_of_awards,
  };

  /**
   * A field is only still "not stated" if the merged reading did not fill it.
   *
   * Both passes can report silence about the same field, and the second pass
   * routinely fills something the first called unstated — which is the whole
   * point of running it. Recomputing against the merge is what stops a stale
   * marker from the first pass telling a student a programme does not state
   * something the row now carries a grounded value for.
   */
  const filled = new Set(
    Object.keys(merged.coverage_matrix)
      .map((key) => `coverage.${key}`)
      .concat(Object.keys(merged.eligibility_flags).map((key) => `eligibility.${key}`))
      .concat(merged.document_checklist.length > 0 ? ["document_checklist"] : [])
      .concat(merged.post_study_obligations !== null ? ["post_study_obligations"] : [])
      .concat(
        merged.language_training_included !== null ? ["language_training_included"] : [],
      )
      .concat(merged.fields_of_study.length > 0 ? ["fields_of_study"] : [])
      .concat(merged.award_duration !== null ? ["award_duration"] : [])
      .concat(merged.number_of_awards !== null ? ["number_of_awards"] : []),
  );

  return {
    // Either pass hearing "the pages do not say" is enough to record it — but
    // never for a question the other pass went on to answer.
    eligibilitySilent: [
      ...new Set([...base.eligibilitySilent, ...extra.eligibilitySilent]),
    ].filter((key) => !(key in eligibility_flags)),
    silentFields: [
      ...new Set([...base.silentFields, ...extra.silentFields]),
    ]
      .filter((key) => !filled.has(key))
      .sort(),
    proposed: merged,
    evidence,
    ungroundedFields: [...base.ungroundedFields, ...extra.ungroundedFields],
    caveats: [...base.caveats, ...extra.caveats],
  };
}
