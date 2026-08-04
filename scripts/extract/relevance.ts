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
  // "how to apply" deliberately absent: it is process vocabulary, and having it
  // here too made every /how-to-apply page tie between the two families and
  // fall to `dates` on the tie-break — spending a date-page reservation on a
  // page of instructions. "when to apply" is the phrase that actually precedes
  // a deadline.
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
      "what you get",
      "what is included",
      "what's included",
      "scholarship benefits",
      "benefits of the",
      "value of the award",
      "value of the scholarship",
      "financial support",
      "financial benefits",
      "financial aid",
      "fees and funding",
      "funding details",
      "award details",
      "award covers",
      "scholarship covers",
      "monthly stipend",
      "living allowance",
      "maintenance allowance",
      "monthly allowance",
      // Real page names that scored ZERO under the first vocabulary and cost us
      // the entire coverage section for those programmes.
      "fellowship components",
      "programme components",
      "program components",
      "scholarship package",
      "entitlements",
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
      "components",
      "package",
      "provides",
      "includes",
      "waiver",
      "exemption",
      "subsistence",
      "book allowance",
      "cost of living",
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
      "supporting materials",
      "required attachments",
      "what to prepare",
      "application materials",
      "submission requirements",
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

/* -------------------------------------------------------------------------- */
/* Navigation vocabulary                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The bare words a site puts in a NAV ITEM, as opposed to in a sentence.
 *
 * The families above are deliberately phrase-shaped, and for passage text that
 * is right: "benefits" appears in prose on every page of a funder's site and
 * discriminates nothing. But a link is not prose. A menu entry reads `Benefits`
 * pointing at `/benefits/` — three words in total, none of which is a phrase —
 * and under the phrase lists alone it scored ZERO and was dropped before it was
 * ever fetched. Measured against `minLinkScore: 6`:
 *
 *     Benefits          0   Apply             0   Funding   0
 *     Fees and costs    0   What we offer     0   Scholarship value  0
 *
 * That is the direct mechanism behind rows with a deadline and no coverage
 * matrix: the prompt asked for the money, the schema had a field for it, and
 * the crawler never fetched the page that stated it.
 *
 * WHY THIS IS A SEPARATE LIST AND NOT MORE `medium` TERMS. These words are only
 * safe on a link, where the whole string is a page name chosen by whoever built
 * the site. Adding them to the families would apply them to passage selection
 * too, where they would match a stray "benefits" in a paragraph about something
 * else, blur every topic into every other, and collapse the passage quotas back
 * into one undifferentiated pool — the exact failure the phrase lists exist to
 * prevent. Grounding also selects passages through `scoreTopics`, so keeping
 * that function untouched keeps the extraction contract untouched.
 */
const NAV_TERMS: Record<Topic, string[]> = {
  dates: [
    "deadline",
    "key dates",
    "important dates",
    "timeline",
    "timetable",
    "calendar",
    "when to apply",
    "closing date",
    "opening date",
  ],
  eligibility: [
    "eligibility",
    "eligible",
    "who can apply",
    "who should apply",
    "requirements",
    "criteria",
    "qualification",
  ],
  benefits: [
    "benefit",
    "funding",
    "what we offer",
    "what you get",
    "what is covered",
    "fees",
    "costs",
    "financial",
    "stipend",
    "allowance",
    "value",
    "coverage",
    "entitlement",
    "package",
  ],
  documents: [
    "document",
    "checklist",
    "materials",
    "attachments",
    "what to prepare",
    "supporting",
  ],
  process: [
    "how to apply",
    "how do i apply",
    "apply",
    "applying",
    "application",
    "guideline",
    "guidance",
    "procedure",
    "steps",
    "selection",
  ],
};

/** Nav-vocabulary score for one piece of link text. */
function scoreNav(text: string): TopicScores {
  return Object.fromEntries(
    TOPICS.map((topic) => [
      topic,
      NAV_TERMS[topic].reduce(
        (sum, term) => (text.includes(term) ? sum + 10 : sum),
        0,
      ),
    ]),
  ) as TopicScores;
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
/**
 * Scores a candidate link against every topic.
 *
 * Three signals, weighted by how reliably each names the PAGE:
 *
 *  - the **last path segment** (x3) is the page's own name, chosen by whoever
 *    built the site to say what is on this page and nothing else;
 *  - the **ancestor segments** (x1) name the section it sits in, which is
 *    weaker evidence and sometimes actively misleading — Humphrey publishes its
 *    funding at `/how-to-apply/fellowship-components`, and weighting the whole
 *    path uniformly let the `how-to-apply` ancestor outvote the leaf and route
 *    a benefits page to `process`;
 *  - the **anchor text** (x1), which is often "Read more" and rarely worse than
 *    neutral.
 */
export function scoreLinkTopics(label: string, url: string): TopicScores {
  const segments = decodeURIComponent(new URL(url).pathname)
    .split("/")
    .filter(Boolean);

  const spaced = (value: string) => value.replace(/[-_]+/g, " ").toLowerCase();
  const leaf = spaced(segments.at(-1) ?? "");
  const ancestors = spaced(segments.slice(0, -1).join(" "));

  const fromLabel = scoreTopics(label);
  const fromLeaf = scoreTopics(leaf);
  const fromAncestors = scoreTopics(ancestors);

  // Nav vocabulary applies to links ONLY — see NAV_TERMS.
  const navLabel = scoreNav(label.toLowerCase());
  const navLeaf = scoreNav(leaf);
  const navAncestors = scoreNav(ancestors);

  return Object.fromEntries(
    TOPICS.map((topic) => [
      topic,
      fromLabel[topic] +
        navLabel[topic] +
        (fromLeaf[topic] + navLeaf[topic]) * 3 +
        fromAncestors[topic] +
        navAncestors[topic],
    ]),
  ) as TopicScores;
}

/**
 * Does this text use the language of a PUBLISHED DEADLINE, as opposed to
 * merely containing a month and a year?
 *
 * `scoreText` deliberately rewards month and year tokens, because that is how
 * a deadline looks. The side effect is that everything dated looks like a
 * deadline: a news post at `/news/2026-cohort-announced` scores 18 — over the
 * crawl threshold — on nothing but "2026" and a month name, and because ties
 * in `bestTopic` fall to `dates`, it is then charged against the reserved date
 * allocation. On Chevening that spent 2 of 5 date slots on a fellowship-hosting
 * page and an "areas of impact" page.
 *
 * A reservation exists to guarantee the deadline gets found. Spending it on
 * something merely dated defeats the reservation, so the crawler requires this
 * before charging a page to the `dates` quota.
 */
export function hasDeadlineLanguage(input: string): boolean {
  const text = input.toLowerCase();
  // STRONG is the deadline vocabulary of PROSE. The nav list matters just as
  // much here: a page named nothing but "Timeline" is the timeline page, and
  // "timeline" is only a MEDIUM term because in prose it is weak evidence.
  // Checking STRONG alone dropped `/timeline/` outright — the gate binning the
  // exact page it exists to protect.
  return (
    STRONG.some((term) => text.includes(term)) ||
    NAV_TERMS.dates.some((term) => text.includes(term))
  );
}

/** The topic a piece of text is most about, and how strongly. Ties go to `dates`. */
export function bestTopic(scores: TopicScores): { topic: Topic; score: number } {
  let best: Topic = "dates";
  for (const topic of TOPICS) {
    if (scores[topic] > scores[best]) best = topic;
  }
  return { topic: best, score: scores[best] };
}
