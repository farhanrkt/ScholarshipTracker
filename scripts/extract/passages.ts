import type { FetchedPage } from "./page.ts";
import { scoreText, scoreTopics, type Topic, type TopicScores } from "./relevance.ts";

/**
 * Turn a crawl into a compact, on-topic context.
 *
 * Sixteen full pages is ~90k characters of mostly navigation chrome, cookie
 * notices, and unrelated prose. Sending it all costs tokens and buries the two
 * sentences that matter. This keeps the passages that look like they state
 * something we asked for, in document order, labelled with the page they came
 * from.
 *
 * WHY THIS TAKES A TOPIC LIST: the extraction runs as two calls — dates, then
 * the programme profile — and each needs a different slice of the same crawl.
 * A single date-scored selection is what previously threw away every sentence
 * describing a stipend or a document list before the model ever saw it, even
 * when the page had been fetched.
 *
 * Grounding still runs against the FULL text of every crawled page, not against
 * this selection — so trimming context can never turn a real quote into a
 * rejected one.
 */

export interface Passage {
  url: string;
  text: string;
  /** Score of `topic` — what won this passage its place. */
  score: number;
  topic: Topic;
  /** Position within its source page, so output can be re-ordered naturally. */
  index: number;
}

/**
 * Passages accumulate to at least this before a paragraph break can end one.
 *
 * Never discard a block for being short: "Deadline: 6 October 2026" is 24
 * characters and is the single most important sentence on the page. Short lines
 * are glued to their neighbours for context instead — a bare date with no
 * surrounding words is unusable to the model and unquotable in a way grounding
 * can attribute.
 */
const SOFT_MIN = 200;
const MAX_PASSAGE = 1_200;

/**
 * Share of the budget each topic is reserved when it is requested.
 *
 * `process` is lowest because it is the most verbose and the least load-bearing:
 * "how to apply" prose is long, and what we actually extract from it (stage
 * names) is usually also stated on the timeline page.
 */
const TOPIC_WEIGHTS: Record<Topic, number> = {
  dates: 1,
  eligibility: 1,
  benefits: 1,
  documents: 1,
  process: 0.6,
};

/**
 * Splits page text into paragraph-ish blocks, gluing fragments together.
 *
 * Exported for the gap pass, which scores the same blocks against a different
 * vocabulary. Both selectors MUST see identical block boundaries — a second
 * look that cuts the page differently would report a passage the first call
 * never had a chance to read, and the comparison between them would be
 * meaningless.
 */
export function toBlocks(text: string): string[] {
  const blocks: string[] = [];
  let buffer = "";

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) blocks.push(trimmed);
    buffer = "";
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      // A paragraph break only ends a passage once it has enough context in it.
      if (buffer.length >= SOFT_MIN) flush();
      continue;
    }

    // List items and table cells arrive one line at a time; gluing them keeps
    // "Applications close" with the date that follows it on the next row.
    buffer = buffer ? `${buffer} ${line}` : line;

    if (buffer.length >= MAX_PASSAGE) flush();
  }

  flush();
  return blocks;
}

interface Scored extends Passage {
  scores: TopicScores;
}

/** The requested topic this block scores highest on. */
function assign(scores: TopicScores, topics: readonly Topic[]): Topic {
  let best = topics[0]!;
  for (const topic of topics) {
    if (scores[topic] > scores[best]) best = topic;
  }
  return best;
}

export function selectPassages(
  pages: FetchedPage[],
  budgetChars = 30_000,
  topics: readonly Topic[] = ["dates"],
): Passage[] {
  if (topics.length === 0) return [];

  const wantsDates = topics.includes("dates");
  const scored: Scored[] = [];

  for (const page of pages) {
    toBlocks(page.text).forEach((text, index) => {
      const scores = scoreTopics(text);
      const topic = assign(scores, topics);

      // A passage with no keyword signal on any requested topic, and no date
      // when dates were asked for, cannot contain what we are looking for.
      const hasDate = wantsDates && scoreText(text).hasDate;
      if (scores[topic] <= 0 && !hasDate) return;

      scored.push({ url: page.url, text, score: scores[topic], topic, index, scores });
    });
  }

  const totalWeight = topics.reduce((sum, topic) => sum + TOPIC_WEIGHTS[topic], 0);
  const kept: Scored[] = [];
  const taken = new Set<Scored>();
  let used = 0;

  // Reserved pass: each topic fills its own share, best-scoring first, so a
  // loud topic cannot crowd out a quiet one.
  for (const topic of topics) {
    const share = (budgetChars * TOPIC_WEIGHTS[topic]) / totalWeight;
    let spent = 0;

    const pool = scored
      .filter((passage) => passage.topic === topic)
      .sort((a, b) => b.score - a.score);

    for (const passage of pool) {
      if (spent + passage.text.length > share) continue;
      kept.push(passage);
      taken.add(passage);
      spent += passage.text.length;
      used += passage.text.length;
    }
  }

  // Leftover pass: a site with no documents page leaves that reservation
  // unspent, and the budget is better given to whatever the site does publish.
  for (const passage of scored.sort((a, b) => b.score - a.score)) {
    if (taken.has(passage)) continue;
    if (used + passage.text.length > budgetChars) continue;
    kept.push(passage);
    taken.add(passage);
    used += passage.text.length;
  }

  // Restore reading order within each page: a timeline read out of sequence is
  // much easier to mis-attribute.
  return kept.sort((a, b) =>
    a.url === b.url ? a.index - b.index : a.url.localeCompare(b.url),
  );
}

/** Renders selected passages into the block sent to the model. */
export function renderPassages(passages: Passage[]): string {
  const byPage = new Map<string, Passage[]>();
  for (const passage of passages) {
    const list = byPage.get(passage.url) ?? [];
    list.push(passage);
    byPage.set(passage.url, list);
  }

  return [...byPage.entries()]
    .map(
      ([url, list]) =>
        `--- PAGE: ${url} ---\n${list.map((passage) => passage.text).join("\n\n")}`,
    )
    .join("\n\n");
}
