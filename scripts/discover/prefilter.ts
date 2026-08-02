/**
 * Reject obvious non-programmes before spending a model call on them.
 *
 * The first real discovery run classified 48 pages and accepted 6. Those 42
 * rejections cost the same tokens as the acceptances and exhausted a day's free
 * quota — for decisions a few string checks can make.
 *
 * The asymmetry that makes this safe: a false reject loses one candidate we can
 * recover by adjusting the rules, while a false accept only costs one model
 * call, which is what we were paying anyway. So the rules are deliberately
 * loose — they reject what is clearly not a programme, not what is merely
 * unlikely to be one. Judgement stays with the model.
 */

const PROGRAMME_WORDS =
  /\b(scholarship|fellowship|bursary|studentship|grant|award)s?\b/gi;

/** A programme page tells you how to get it. An article about one does not. */
const APPLICATION_WORDS =
  /\b(apply|application|eligib|deadline|criteria|award(ed)?|covers?|funding|stipend|tuition|benefit)/i;

/** Markers of editorial content that mentions programmes without being one. */
const ARTICLE_MARKERS =
  /\b(min read|read more|posted on|published on|share this|related (articles|posts|stories)|by [A-Z][a-z]+ [A-Z][a-z]+ ·|comments?\s*\(\d+\))\b/i;

/** Listing pages enumerate programmes rather than describing one. */
const INDEX_MARKERS =
  /\b(browse all|view all|showing \d+|filter by|sort by|search results|\d+ results?\b)/i;

/**
 * `listing` is not a rejection.
 *
 * A page that enumerates many programmes is the most valuable thing discovery
 * can find — it is a seed we did not have to curate by hand. Throwing it away
 * (which is what this used to do) capped every run at whatever the four
 * hand-written seeds linked to directly. The caller expands it instead, using
 * the copy of the page it has already paid to fetch.
 */
export type PrefilterKind = "programme" | "listing" | "reject";

export interface PrefilterVerdict {
  /** True only for `programme` — the pages worth spending a model call on. */
  keep: boolean;
  kind: PrefilterKind;
  reason: string;
}

const reject = (reason: string): PrefilterVerdict => ({
  keep: false,
  kind: "reject",
  reason,
});

export function prefilterPage(text: string): PrefilterVerdict {
  if (text.length < 600) {
    return reject("too little text to describe a programme");
  }

  const hits = text.match(PROGRAMME_WORDS)?.length ?? 0;
  if (hits < 2) {
    return reject("barely mentions a scholarship or fellowship");
  }

  if (!APPLICATION_WORDS.test(text)) {
    return reject("no application or eligibility language");
  }

  // Only reject as editorial when there is ALSO no application language
  // density — many genuine programme pages carry a "share this" widget.
  const head = text.slice(0, 2_000);
  if (ARTICLE_MARKERS.test(head) && hits < 5) {
    return reject("reads as an article about a programme");
  }

  // Threshold lowered from 12 now that this routes to expansion rather than the
  // bin: the cost of being wrong is one page of links we ignore, not a lost
  // programme.
  if (INDEX_MARKERS.test(head) && hits >= 8) {
    return {
      keep: false,
      kind: "listing",
      reason: "reads as a listing of many programmes",
    };
  }

  return { keep: true, kind: "programme", reason: "" };
}

/**
 * How much page text the classifier actually needs.
 *
 * "Is this a programme, and what is it called?" is answered by the top of the
 * page. Sending 12,000 characters bought nothing and cost 4x the tokens.
 */
export const CLASSIFY_CHARS = 2_500;
