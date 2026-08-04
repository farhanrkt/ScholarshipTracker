import {
  canonicaliseUrl,
  extractLinks,
  fetchPage,
  type FetchedPage,
} from "./page.ts";
import {
  bestTopic,
  hasDeadlineLanguage,
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
  /**
   * Ancestor pages of the entry URL to fetch before anything else.
   *
   * Rows staged by discovery point at whatever page the classifier read, and
   * that is routinely a leaf: `/how-to-apply/eligibility/`,
   * `/host-institutions/flta-program/flta-during-the-program`. A leaf links to
   * its siblings and not much else, so a crawl starting there never reaches the
   * page describing what the award pays — which is why those rows came back
   * with a deadline and nothing else.
   *
   * The parent and the origin root are where a site keeps its navigation, and
   * navigation is a hand-written index of exactly the pages we want.
   */
  maxHubs?: number;
  /**
   * The programme's name, used to steer the crawl on a big site.
   *
   * Several rows point at a site ROOT rather than a programme page —
   * `studyinjapan.go.jp/`, `studyinkorea.go.kr/`, `foreign.fulbrightonline.org/`
   * — because that is what the seed data or the classifier recorded. Topic
   * scoring alone cannot help there: every portal has an eligibility page and a
   * FAQ, they are simply about the portal rather than about this award, and the
   * model duly reports "wrong site".
   *
   * Matching the title's distinctive words against link text and paths is what
   * tells `/en/planning/scholarships/mext-scholarships` apart from
   * `/en/planning/faq` when both look equally on-topic.
   */
  titleHint?: string;
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
 * Words in a programme's name that actually identify it.
 *
 * "Scholarship", "programme" and "international" appear in every title and on
 * every page of every funder — matching on them would boost the entire site
 * uniformly, which is the same as boosting nothing.
 */
const TITLE_STOPWORDS = new Set([
  "scholarship", "scholarships", "fellowship", "fellowships", "programme",
  "programmes", "program", "programs", "award", "awards", "grant", "grants",
  "bursary", "studentship", "the", "for", "and", "of", "in", "at", "to",
  "international", "student", "students", "study", "studies", "graduate",
  "postgraduate", "undergraduate", "masters", "phd", "doctoral", "type",
  "government", "foundation", "university", "national",
]);

function titleTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((word) => word.length >= 3 && !TITLE_STOPWORDS.has(word)),
    ),
  ];
}

/** How strongly a link's text and path name this specific programme. */
function titleAffinity(tokens: string[], label: string, url: string): number {
  if (tokens.length === 0) return 0;

  const haystack = `${label} ${decodeURIComponent(new URL(url).pathname)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");

  const hits = tokens.filter((token) => haystack.includes(token)).length;
  // Capped: two distinctive words is already a confident match, and an
  // uncapped bonus would let a long title outrank every topic signal.
  return Math.min(hits, 3) * 8;
}

/**
 * Ancestor URLs of the entry, nearest first, ending at the origin root.
 *
 * `/host-institutions/flta-program/flta-during-the-program` yields
 * `/host-institutions/flta-program` — the programme's own hub — and then the
 * site root. Both carry navigation the leaf does not.
 */
function hubCandidates(entryUrl: string, max: number): string[] {
  if (max <= 0) return [];

  let url: URL;
  try {
    url = new URL(entryUrl);
  } catch {
    return [];
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const hubs = new Set<string>();

  for (let depth = segments.length - 1; depth >= 0 && hubs.size < max; depth--) {
    const path = segments.slice(0, depth).join("/");
    hubs.add(path ? `${url.origin}/${path}` : url.origin);
  }

  return [...hubs];
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
  // Three, not two: sites routinely nest the page we want one level below the
  // section index — /how-to-apply/eligibility/nationality-requirements, or
  // /scholarships/chevening/what-it-covers. At depth 2 those are unreachable
  // from a hub, and the hub is where a leaf-entry crawl starts. `maxFetches`
  // and the topic quotas are what bound the cost, not the depth.
  const maxDepth = options.maxDepth ?? 3;
  const minLinkScore = options.minLinkScore ?? 6;
  const quotas = { ...DEFAULT_QUOTAS, ...options.quotas };
  const maxHubs = options.maxHubs ?? 2;
  const tokens = titleTokens(options.titleHint ?? "");
  let fetchBudget = options.maxFetches ?? maxPages * 2;

  // No sleeping here: fetchPage gates every request per host, honouring both
  // our own gap and any Crawl-delay the site publishes. Sleeping again would
  // simply halve the crawl rate.

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
      // eslint-disable-next-line prefer-const -- `topic` is re-routed below.
      let { topic, score } = bestTopic(scores);

      // A link is only charged to the DATE reservation if it talks like a
      // deadline. Month and year tokens alone make every news post and every
      // dated page look like a timeline, and because ties fall to `dates` those
      // pages then eat the allocation that exists to guarantee we find the
      // closing date. Re-route them to whatever they are actually about; if
      // that is nothing, the threshold below drops them.
      // Hyphens out, so "/application-timeline/" reads as the phrase it is.
      let readable = link.label;
      try {
        readable += ` ${decodeURIComponent(new URL(link.url).pathname).replace(/[-_/]+/g, " ")}`;
      } catch {
        // A URL we cannot parse is judged on its label alone.
      }

      if (topic === "dates" && !hasDeadlineLanguage(readable)) {
        let alternative: Topic = "process";
        for (const candidate of TOPICS) {
          if (candidate === "dates") continue;
          if (scores[candidate] > scores[alternative]) alternative = candidate;
        }
        // Re-route, never drop. An earlier version discarded these links when
        // no other topic scored, and that cost more than it saved: the MEXT row
        // went from three coverage lines to failing outright, because the three
        // pages it lost were carrying the programme context the profile call
        // needed to recognise what it was reading.
        //
        // The SCORE is deliberately kept as it was, so the link still ranks and
        // still clears the threshold. Only the quota it draws against changes —
        // which is the whole point. If the receiving topic is already full the
        // page simply waits for the leftover pass in `pickNext`, where competing
        // on merit against everything else is exactly what it should do.
        topic = alternative;
      }

      // A link naming this programme is worth following even when it carries no
      // topic vocabulary at all — on a portal, the programme's own page is
      // usually just its name — so the affinity is added BEFORE the threshold.
      const affinity = titleAffinity(tokens, link.label, link.url);
      const total = score + affinity;
      if (total < minLinkScore) continue;

      seen.add(key);
      queue.push({ url: link.url, depth: page.depth + 1, topic, score: total, scores });
    }
  };

  enqueueLinksFrom(entry);

  // Hubs are fetched before the topic loop so their navigation is already in
  // the frontier when quotas start being spent. Like the entry page they are
  // not charged to any topic — they are how the topics get found at all.
  for (const hubUrl of hubCandidates(entry.url, maxHubs)) {
    if (pages.length >= maxPages || fetchBudget <= 0) break;

    const key = canonicaliseUrl(new URL(hubUrl));
    if (seen.has(key) || fetchedUrls.has(key)) continue;
    seen.add(key);

    fetchBudget--;

    let hub: FetchedPage;
    try {
      hub = await fetchPage(hubUrl);
    } catch (error) {
      // A missing ancestor is completely normal — plenty of sites have no page
      // at an intermediate path. Not worth reporting as a crawl error.
      void error;
      continue;
    }

    const landed = canonicaliseUrl(new URL(hub.url));
    if (fetchedUrls.has(landed)) continue;
    fetchedUrls.add(landed);
    seen.add(landed);

    const page: CrawledPage = {
      ...hub,
      topic: "entry",
      linkScore: Infinity,
      // Depth 0: links off a hub are as close to the programme as the entry's.
      depth: 0,
    };
    pages.push(page);
    enqueueLinksFrom(page);
  }

  while (queue.length > 0 && pages.length < maxPages && fetchBudget > 0) {
    const index = pickNext(queue, topicCounts, quotas);
    if (index === -1) break;
    const next = queue.splice(index, 1)[0]!;

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
