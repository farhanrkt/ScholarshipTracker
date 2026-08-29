import type { FetchedPage } from "./page.ts";
import { toBlocks, type Passage } from "./passages.ts";
import { specFor, type GapField } from "./gaps.ts";
import type { Topic } from "./relevance.ts";

/**
 * WHY A FIELD IS BLANK.
 *
 * The run log has been able to say `12/25 field(s) filled` for a while. It has
 * never been able to say anything about the other thirteen, and those thirteen
 * are not one thing. A blank has four causes, they are fixed in four different
 * files, and only the last of them is the pipeline working correctly:
 *
 *   never-crawled       no page on that subject was ever fetched. The answer
 *                       may be published and sitting one link away. Fix in the
 *                       crawl budget or the link scorer.
 *   not-retrieved       a fetched page uses this field's vocabulary and no
 *                       passage carrying it was ever sent. Fix in retrieval.
 *   model-silent        the words went to the model inside a passage and
 *                       nothing came back. Fix in the prompt, or escalate.
 *   grounding-rejected  something came back and its quote was not on the page.
 *                       Working as intended — the value was a guess.
 *   not-published       the pages on this subject were crawled, read, and do
 *                       not discuss it. Also working as intended, and the only
 *                       cause that is a fact about the funder rather than
 *                       about us.
 *
 * Without this split "improve coverage" is guesswork: you cannot tell a crawler
 * that never reached the benefits page from a funder that publishes no stipend,
 * and the two look identical on the dashboard. With it, every run produces a
 * burn-down list ordered by what is actually recoverable.
 *
 * IT IS ALSO WHAT LICENSES "NOT STATED". `not-published` is the only cause that
 * justifies telling a student the programme does not state something, and it is
 * deliberately the narrowest of the five: the topic has to have been crawled AND
 * the field's own vocabulary has to be absent from everything fetched. Anything
 * less is our failure to find it, and gets reported as ours.
 */

export const GAP_CAUSES = [
  "never-crawled",
  "not-retrieved",
  "model-silent",
  "grounding-rejected",
  "not-published",
] as const;

export type GapCause = (typeof GAP_CAUSES)[number];

/** Which causes are a bug in the pipeline rather than a fact about the funder. */
export const RECOVERABLE_CAUSES: readonly GapCause[] = [
  "never-crawled",
  "not-retrieved",
  "model-silent",
];

export const CAUSE_LABELS: Record<GapCause, string> = {
  "never-crawled": "no page on this subject was fetched",
  "not-retrieved": "the crawl mentions it, no passage carrying it was sent",
  "model-silent": "sent to the model, nothing came back",
  "grounding-rejected": "answered, but the quote was not on the page",
  "not-published": "the pages were read and do not state it",
};

export interface DiagnoseOptions {
  /** Slots still empty after every pass. */
  gaps: GapField[];
  /** Everything fetched for this programme, including the second crawl. */
  pages: FetchedPage[];
  /** Every passage sent to any model call for this programme. */
  sent: Passage[];
  /** Pages kept per topic. A topic at zero was never read at all. */
  topicCounts: Record<Topic, number>;
  /** `ungroundedFields` from every grounding pass, concatenated. */
  ungrounded: string[];
  /**
   * Questions a model answered with an explicit "the pages do not say".
   *
   * The strongest possible evidence of `not-published`, because it is an answer
   * rather than an inference — the reader had the passages and reported the
   * silence. Keys are bare (`max_age`), matching `GroundedProfile`.
   */
  silent: string[];
}

/**
 * Does any fetched page use the words that sit next to this fact?
 *
 * The same phrase list the gap pass retrieves on, so "the crawl mentions it"
 * means exactly "the gap pass had something to find". Checked against the whole
 * crawl rather than the blocks, because a phrase split across a block boundary
 * is still a mention.
 */
function crawlMentions(pages: FetchedPage[], field: GapField): boolean {
  const { phrases } = specFor(field);
  return pages.some((page) => {
    const haystack = page.text.toLowerCase();
    return phrases.some((phrase) => haystack.includes(phrase));
  });
}

/** Did any passage we actually sent carry this field's vocabulary? */
function sentMentions(sent: Passage[], field: GapField): boolean {
  const { phrases } = specFor(field);
  return sent.some((passage) => {
    const haystack = passage.text.toLowerCase();
    return phrases.some((phrase) => haystack.includes(phrase));
  });
}

/**
 * Was this field's subject matter crawled at all?
 *
 * A gap's spec names the topics whose pages tend to carry it. If every one of
 * them came back with zero pages, nothing that could have answered was ever
 * fetched — and no amount of prompt tuning will change that.
 */
function topicWasCrawled(
  topicCounts: Record<Topic, number>,
  field: GapField,
): boolean {
  return specFor(field).topics.some((topic) => topicCounts[topic] > 0);
}

/**
 * `ungroundedFields` entries are prose — `coverage.tuition (claimed covered,
 * quote not found…)` — so the field is matched as a prefix rather than parsed.
 * `documents[0] (claimed "Transcript"…)` maps back to `document_checklist`.
 */
function wasRejected(ungrounded: string[], field: GapField): boolean {
  if (field === "document_checklist") {
    return ungrounded.some((entry) => entry.startsWith("documents["));
  }
  return ungrounded.some(
    (entry) => entry === field || entry.startsWith(`${field} `),
  );
}

/** The bare key a silence marker uses, for the fields that have one. */
function silenceKey(field: GapField): string {
  return field.startsWith("eligibility.")
    ? field.slice("eligibility.".length)
    : field;
}

/**
 * One cause per still-empty slot.
 *
 * ORDER IS THE WHOLE ALGORITHM, and it runs from the most specific evidence to
 * the least. A field that was rejected by grounding was obviously also crawled
 * and retrieved, so asking "was it rejected" first is what stops it being
 * reported as a retrieval bug. `not-published` is last because it is the
 * residual — the claim we are least entitled to make, so nothing reaches it
 * that any earlier rule could explain.
 */
export function diagnoseGaps(
  options: DiagnoseOptions,
): Record<string, GapCause> {
  const { gaps, pages, sent, topicCounts, ungrounded, silent } = options;
  const silentKeys = new Set(silent);
  const causes: Record<string, GapCause> = {};

  for (const field of gaps) {
    if (wasRejected(ungrounded, field)) {
      causes[field] = "grounding-rejected";
      continue;
    }

    // An explicit "the pages do not say" outranks every inference below it.
    if (silentKeys.has(silenceKey(field))) {
      causes[field] = "not-published";
      continue;
    }

    if (!topicWasCrawled(topicCounts, field)) {
      causes[field] = "never-crawled";
      continue;
    }

    if (!crawlMentions(pages, field)) {
      // The subject was crawled and this fact's vocabulary appears nowhere in
      // any of it. That is as close to "the funder does not publish this" as
      // a crawler can honestly get.
      causes[field] = "not-published";
      continue;
    }

    if (!sentMentions(sent, field)) {
      causes[field] = "not-retrieved";
      continue;
    }

    causes[field] = "model-silent";
  }

  return causes;
}

/**
 * The fields a second crawl could plausibly rescue, and the topics to spend it
 * on.
 *
 * Only `never-crawled` qualifies: `not-retrieved` is answered by re-reading
 * pages we already hold, and the other three are not about coverage of the
 * site at all. Returning the topics rather than the fields is what the crawler
 * needs — quotas are per topic.
 */
export function starvedTopics(causes: Record<string, GapCause>): Topic[] {
  const topics = new Set<Topic>();
  for (const [field, cause] of Object.entries(causes)) {
    if (cause !== "never-crawled") continue;
    for (const topic of specFor(field as GapField).topics) topics.add(topic);
  }
  return [...topics];
}

/** Phrase vocabulary for the fields a second crawl is going after. */
export function gapPhrases(fields: GapField[]): string[] {
  return [...new Set(fields.flatMap((field) => specFor(field).phrases))];
}

/**
 * The run-log line: how many blanks are ours, and which kind.
 *
 * Ordered recoverable-first because that is the order somebody reading a run
 * would act on them. A run whose blanks are all `not-published` is a run that
 * worked.
 */
export function describeCauses(causes: Record<string, GapCause>): string {
  const counts = new Map<GapCause, number>();
  for (const cause of Object.values(causes)) {
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }

  const parts = GAP_CAUSES.filter((cause) => counts.has(cause)).map(
    (cause) => `${counts.get(cause)} ${cause}`,
  );

  return parts.length > 0 ? parts.join(" · ") : "no gaps";
}

/**
 * Fields that are blank because the pages do not state them.
 *
 * This is the list the row carries into the UI as "Not stated by the
 * programme", so it is deliberately derived from the narrowest cause and
 * nothing else.
 */
export function notStatedFields(causes: Record<string, GapCause>): string[] {
  return Object.entries(causes)
    .filter(([, cause]) => cause === "not-published")
    .map(([field]) => field)
    .sort();
}

/** Blanks that are the pipeline's fault, for the run summary and the console. */
export function recoverableCount(causes: Record<string, GapCause>): number {
  return Object.values(causes).filter((cause) =>
    RECOVERABLE_CAUSES.includes(cause),
  ).length;
}

/**
 * Blocks of a page that mention a field, for a reviewer chasing a `model-silent`
 * diagnosis back to the text the model was looking at.
 *
 * Not used by the pipeline itself — this is the "show me why" affordance the
 * admin console needs to make a cause actionable rather than merely counted.
 */
export function mentioningBlocks(
  pages: FetchedPage[],
  field: GapField,
  limit = 3,
): Array<{ url: string; text: string }> {
  const { phrases } = specFor(field);
  const found: Array<{ url: string; text: string }> = [];

  for (const page of pages) {
    for (const block of toBlocks(page.text)) {
      const haystack = block.toLowerCase();
      if (!phrases.some((phrase) => haystack.includes(phrase))) continue;
      found.push({ url: page.url, text: block });
      if (found.length >= limit) return found;
    }
  }

  return found;
}
