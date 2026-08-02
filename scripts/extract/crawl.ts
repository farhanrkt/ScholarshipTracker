import {
  canonicaliseUrl,
  extractLinks,
  fetchPage,
  FETCH_DELAY_MS,
  type FetchedPage,
} from "./page.ts";
import {
  bestTopic,
  scoreLinkTopics,
  TOPICS,
  type Topic,
  type TopicScores,
} from "./relevance.ts";

/**
 * A small, quota-driven crawl of one programme's own site.
 *
 * A scholarship's details are never on the page you have. Chevening publishes
 * eligibility on /who-can-apply/, the deadline on /application-timeline/, and
 * what the money covers somewhere else again — a single-page fetch of any one
 * of them misses the other two.
 *
 * WHY QUOTAS AND NOT ONE BEST-FIRST QUEUE: a single ranked queue is won
 * outright by whichever topic has the loudest vocabulary. The previous version
 * ranked on date language alone, so a twelve-page budget was spent on twelve
 * date-ish pages and /benefits was never fetched at all — the direct cause of
 * rows that had a deadline and nothing else. Each topic now gets a reserved
 * allocation, and only leftover budget is competed for.
 */

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  /** Ignore links whose best topic scores below this. Keeps the crawl on-topic. */
  minLinkScore?: number;
  /** Reserved page allocation per topic. Unused reservations become free budget. */
  quotas?: Partial<Record<Topic, number>>;
  /**
   * Ceiling on fetches ATTEMPTED, not pages kept. Defaults to twice maxPages.
   *
   * A failed fetch does not fill a quota, so without this a site whose links
   * mostly 404 or 403 walks its entire queue at a page and a half of latency
   * each. Scoring five topic families instead of one made those queues large
   * enough for that to matter: one programme spent ten minutes fetching pages
   * it then threw away.
   */
  maxFetches?: number;
}

/** A fetched page, plus why the crawler chose to fetch it. */
export interface CrawledPage extends FetchedPage {
  /** The topic whose quota this page was drawn against. */
  topic: Topic | "entry";
  linkScore: number;
  depth: number;
}

export interface CrawlResult {
  pages: CrawledPage[];
  visited: string[];
  errors: Array<{ url: string; message: string }>;
  /** Pages fetched per topic — logged so a thin crawl is visible, not silent. */
  topicCounts: Record<Topic, number>;
}

interface Candidate {
  url: string;
  depth: number;
  topic: Topic;
  score: number;
  scores: TopicScores;
}

/**
 * Deliberately generous on eligibility/benefits/documents.
 *
 * Dates usually live on one or two pages and are found quickly; the other
 * topics are spread thin across a site, so they need the room. The sum exceeds
 * maxPages on purpose — quotas are reservations, not promises, and a site with
 * no documents page spends that budget on whatever it does have.
 */
const DEFAULT_QUOTAS: Record<Topic, number> = {
  dates: 5,
  eligibility: 4,
  benefits: 4,
  documents: 3,
  process: 3,
};

function emptyCounts(): Record<Topic, number> {
  return { dates: 0, eligibility: 0, benefits: 0, documents: 0, process: 0 };
}

/**
 * Picks the next page to fetch.
 *
 * Two passes: first the highest-scoring candidate whose topic still has a
 * reservation, then — only when every topic is full — the highest-scoring
 * candidate of any topic, so leftover global budget is never wasted.
 */
function pickNext(
  queue: Candidate[],
  used: Record<Topic, number>,
  quotas: Record<Topic, number>,
): number {
  let withinQuota = -1;
  let anywhere = -1;

  for (const [index, candidate] of queue.entries()) {
    if (anywhere === -1 || candidate.score > queue[anywhere]!.score) {
      anywhere = index;
    }
    if (used[candidate.topic] >= quotas[candidate.topic]) continue;
    if (withinQuota === -1 || candidate.score > queue[withinQuota]!.score) {
      withinQuota = index;
    }
  }

  return withinQuota === -1 ? anywhere : withinQuota;
}

export async function crawlProgramme(
  entryUrl: string,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 16;
  const maxDepth = options.maxDepth ?? 2;
  const minLinkScore = options.minLinkScore ?? 6;
  const quotas = { ...DEFAULT_QUOTAS, ...options.quotas };
  let fetchBudget = options.maxFetches ?? maxPages * 2;

  const pages: CrawledPage[] = [];
  const errors: CrawlResult["errors"] = [];
  const topicCounts = emptyCounts();
  const seen = new Set<string>([entryUrl.replace(/\/$/, "")]);
  /** Post-redirect URLs of pages actually kept. See the dedupe below. */
  const fetchedUrls = new Set<string>();

  const queue: Candidate[] = [];

  // The entry page always gets fetched, whatever it scores, and it is not
  // charged to any topic's reservation.
  let entry: CrawledPage | null = null;
  try {
    const page = await fetchPage(entryUrl);
    entry = { ...page, topic: "entry", linkScore: Infinity, depth: 0 };
    pages.push(entry);
    fetchedUrls.add(canonicaliseUrl(new URL(page.url)));
    seen.add(canonicaliseUrl(new URL(page.url)));
  } catch (error) {
    return {
      pages: [],
      visited: [],
      errors: [
        {
          url: entryUrl,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      topicCounts,
    };
  }

  const enqueueLinksFrom = (page: CrawledPage) => {
    if (page.depth >= maxDepth) return;

    for (const link of extractLinks(page)) {
      const key = link.url.replace(/\/$/, "");
      if (seen.has(key)) continue;

      const scores = scoreLinkTopics(link.label, link.url);
      const { topic, score } = bestTopic(scores);
      if (score < minLinkScore) continue;

      seen.add(key);
      queue.push({ url: link.url, depth: page.depth + 1, topic, score, scores });
    }
  };

  enqueueLinksFrom(entry);

  while (queue.length > 0 && pages.length < maxPages && fetchBudget > 0) {
    const index = pickNext(queue, topicCounts, quotas);
    if (index === -1) break;
    const next = queue.splice(index, 1)[0]!;

    await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
    fetchBudget--;

    let fetched: FetchedPage;
    try {
      fetched = await fetchPage(next.url);
    } catch (error) {
      errors.push({
        url: next.url,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // Dedupe again on what came BACK, not just on what we asked for. Two links
    // can differ before the request and be the same page after it — a redirect,
    // or a query parameter the server ignores — and a page counted twice spends
    // a topic's reservation on a document we already have.
    const landed = canonicaliseUrl(new URL(fetched.url));
    if (fetchedUrls.has(landed)) continue;
    fetchedUrls.add(landed);
    seen.add(landed);

    const page: CrawledPage = {
      ...fetched,
      topic: next.topic,
      linkScore: next.score,
      depth: next.depth,
    };
    pages.push(page);
    topicCounts[next.topic]++;

    enqueueLinksFrom(page);
  }

  return {
    pages,
    visited: pages.map((page) => page.url),
    errors,
    topicCounts,
  };
}

/** One-line crawl summary for the run log, e.g. "dates 3 · benefits 2". */
export function describeCrawl(counts: Record<Topic, number>): string {
  const parts = TOPICS.filter((topic) => counts[topic] > 0).map(
    (topic) => `${topic} ${counts[topic]}`,
  );
  return parts.length > 0 ? parts.join(" · ") : "entry page only";
}
