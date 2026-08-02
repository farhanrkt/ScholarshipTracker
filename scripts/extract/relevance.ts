/**
 * Keyword scoring for "what is this text about?".
 *
 * Deliberately not embeddings. We know exactly what we are hunting for — the
 * words a programme uses to publish a deadline, or a stipend, or a document
 * list — so a keyword score is exact, free, instant, and debuggable. Embeddings
 * would add a provider, a vector store, and a retrieval failure mode to solve a
 * problem we do not have at twenty pages per programme.
 *
 * There are five topic families. `dates` is the original scorer and is
 * unchanged: grounding, discovery, and the cycle extraction all depend on its
 * exact numbers, so it stays byte-for-byte what it was. The other four exist
 * because a date-only scorer is blind to everything a student also needs —
 * /benefits, /required-documents and Chevening's /who-can-apply all scored ZERO
 * under it, which is why those pages were never crawled and why extracted rows
 * were sparse.
 */

const STRONG = [
  "deadline",
  "closing date",
  "closes",
  "close on",
  "opening date",
  "opens on",
  "applications open",
  "applications close",
  "application timeline",
  "key dates",
  "important dates",
  "apply by",
  "submission deadline",
  "how to apply",
  "when to apply",
];

const MEDIUM = [
  "timeline",
  "intake",
  "cycle",
  "round",
  "interview",
  "shortlist",
  "notification",
  "results",
  "announced",
  "application period",
  "application form",
  "eligibility",
];

const MONTHS =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

const YEAR = /\b20\d{2}\b/;
const NUMERIC_DATE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/;

export interface RelevanceScore {
  score: number;
  hasDate: boolean;
}

export function scoreText(input: string): RelevanceScore {
  const text = input.toLowerCase();
  let score = 0;

  for (const term of STRONG) {
    if (text.includes(term)) score += 10;
  }
  for (const term of MEDIUM) {
    if (text.includes(term)) score += 3;
  }

  const monthish = MONTHS.test(text);
  const yearish = YEAR.test(text);
  const numeric = NUMERIC_DATE.test(text);
  const hasDate = (monthish && yearish) || numeric || (monthish && /\b\d{1,2}\b/.test(text));

  if (monthish) score += 4;
  if (yearish) score += 3;
  if (numeric) score += 6;

  // A date next to deadline language is the thing we actually want. Reward the
  // combination far more than either signal alone, or navigation chrome full of
  // month names outranks the paragraph that states the deadline.
  if (hasDate && STRONG.some((term) => text.includes(term))) score += 25;

  return { score, hasDate };
}

/* -------------------------------------------------------------------------- */
/* Topic families                                                             */
/* -------------------------------------------------------------------------- */

export const TOPICS = [
  "dates",
  "eligibility",
  "benefits",
  "documents",
  "process",
] as const;
export type Topic = (typeof TOPICS)[number];

export type TopicScores = Record<Topic, number>;

/**
 * Phrases, not single words, wherever a single word would be ambiguous.
 *
 * "award" appears on every page of a scholarship site and tells you nothing;
 * "value of the award" only appears where the money is described. Keeping the
 * strong lists phrase-shaped is what stops every page scoring for every topic
 * and collapsing the quotas back into one undifferentiated queue.
 */
interface Family {
  strong: string[];
  medium: string[];
}

const FAMILIES: Record<Exclude<Topic, "dates">, Family> = {
  eligibility: {
    strong: [
      "who can apply",
      "who is eligible",
      "eligibility criteria",
      "eligibility requirements",
      "am i eligible",
      "are you eligible",
      "entry requirements",
      "eligible countries",
      "eligible nationalities",
      "eligibility",
    ],
    medium: [
      "criteria",
      "requirements",
      "nationality",
      "citizens of",
      "residents of",
      "work experience",
      "years of experience",
      "language requirement",
      "english language",
      "ielts",
      "toefl",
      "gpa",
      "grade point",
      "age limit",
      "under the age of",
      "must hold",
      "must have",
      "qualification",
      "not eligible",
    ],
  },
  benefits: {
    strong: [
      "what the scholarship covers",
      "what is covered",
      "what's covered",
      "scholarship benefits",
      "benefits of the",
      "value of the award",
      "value of the scholarship",
      "financial support",
      "financial benefits",
      "award covers",
      "scholarship covers",
      "monthly stipend",
      "living allowance",
      "maintenance allowance",
      "monthly allowance",
    ],
    medium: [
      "tuition",
      "tuition fees",
      "stipend",
      "allowance",
      "airfare",
      "flight",
      "travel costs",
      "return airfare",
      "health insurance",
      "medical insurance",
      "accommodation",
      "housing",
      "settling-in",
      "arrival allowance",
      "research grant",
      "thesis grant",
      "visa fee",
      "fully funded",
      "per month",
      "per year",
      "per annum",
      "covers",
      "funded",
    ],
  },
  documents: {
    strong: [
      "required documents",
      "supporting documents",
      "document checklist",
      "documents you need",
      "documents required",
      "what you need to apply",
      "required materials",
      "application documents",
      "application checklist",
      "documents to submit",
    ],
    medium: [
      "transcript",
      "academic record",
      "recommendation",
      "reference letter",
      "letter of reference",
      "personal statement",
      "statement of purpose",
      "motivation letter",
      "curriculum vitae",
      "resume",
      "passport copy",
      "research proposal",
      "study plan",
      "certificate",
      "certified copy",
      "medical certificate",
      "upload",
      "attach",
      "submit the following",
    ],
  },
  process: {
    strong: [
      "how to apply",
      "application process",
      "how do i apply",
      "application guide",
      "applicant guide",
      "how to submit",
      "step by step",
      "application steps",
      "selection process",
      "application procedure",
      "guidance for applicants",
    ],
    medium: [
      "guidance",
      "guidelines",
      "instructions",
      "online application",
      "application portal",
      "application system",
      "register",
      "submit",
      "stages",
      "interview",
      "shortlist",
      "selection",
      "faq",
      "frequently asked",
      "nomination",
    ],
  },
};

function scoreFamily(text: string, family: Family): number {
  let score = 0;
  for (const term of family.strong) {
    if (text.includes(term)) score += 10;
  }
  for (const term of family.medium) {
    if (text.includes(term)) score += 3;
  }
  return score;
}

/** Scores one piece of text against every topic family. */
export function scoreTopics(input: string): TopicScores {
  const text = input.toLowerCase();

  return {
    dates: scoreText(input).score,
    eligibility: scoreFamily(text, FAMILIES.eligibility),
    benefits: scoreFamily(text, FAMILIES.benefits),
    documents: scoreFamily(text, FAMILIES.documents),
    process: scoreFamily(text, FAMILIES.process),
  };
}

/**
 * Scores a candidate link against every topic, weighting the path at twice the
 * anchor text — "Read more" is a common anchor and a useless signal, while the
 * path is chosen by whoever built the site to say what the page contains.
 */
export function scoreLinkTopics(label: string, url: string): TopicScores {
  const path = decodeURIComponent(new URL(url).pathname).replace(/[-_/]/g, " ");
  const fromLabel = scoreTopics(label);
  const fromPath = scoreTopics(path);

  return Object.fromEntries(
    TOPICS.map((topic) => [topic, fromLabel[topic] + fromPath[topic] * 2]),
  ) as TopicScores;
}

/** The topic a piece of text is most about, and how strongly. Ties go to `dates`. */
export function bestTopic(scores: TopicScores): { topic: Topic; score: number } {
  let best: Topic = "dates";
  for (const topic of TOPICS) {
    if (scores[topic] > scores[best]) best = topic;
  }
  return { topic: best, score: scores[best] };
}
