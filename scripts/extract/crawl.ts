import {
  canonicaliseUrl,
  extractLinks,
  fetchPage,
  HttpError,
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
  /**
   * Vocabulary of the facts this crawl is going after, for scoring links.
   *
   * WHY A SECOND CRAWL NEEDS ITS OWN WORDS. The topic scorers ask "is this page
   * about eligibility"; after a first pass, the question has become "is this
   * page about the AGE LIMIT, which is the one thing still missing". Those are
   * different questions and the second one is much narrower — a link labelled
   * `Age and residency` scores nothing on the eligibility phrase list, because
   * that list is built out of page-level headings like "who can apply".
   *
   * These are the same phrases the gap pass retrieves passages with, so the
   * crawl and the retrieval hunt the same fact with the same words.
   */
  gapPhrases?: string[];
  /**
   * Pages a previous crawl already has. Never fetched again.
   *
   * Passed as post-redirect canonical URLs, which is what `fetchedUrls` holds:
   * a second crawl that re-fetched the first crawl's pages would spend its
   * entire budget confirming what is already known.
   */
  skipUrls?: Iterable<string>;
  /**
   * Requests this crawl keeps in flight at once.
   *
   * This is NOT a politeness dial. Spacing is the fetch layer's job and is
   * enforced per host — including any `Crawl-delay` the site publishes — so a
   * site sees the same request rate whatever this is set to. What this controls
   * is only whether the crawler has a second request READY when the gate is
   * willing to start one.
   *
   * It is half of a pair, and useless alone: `schedulePerHost` allows two open
   * connections and spaces request starts by the gap, so the gap overlaps the
   * latency rather than following it — but only if something has queued the
   * next request. A strictly serial crawl leaves that capacity unused and pays
   * `latency + gap` per page regardless.
   *
   * Four is enough to keep the gate fed. Higher mainly grows the number of
   * pages chosen before the ranking has seen what they link to.
   */
  concurrency?: number;
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
  /**
   * `status` is present when the server answered with one. It is what lets the
   * caller tell "this URL is wrong" (404) from "we were turned away" (403) —
   * only the first is worth trying to repair.
   */
  errors: Array<{ url: string; message: string; status?: number }>;
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

export function titleTokens(title: string): string[] {
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
 * How strongly a link's words name a fact we are still missing.
 *
 * Deliberately worth more than a topic hit and less than a title match. A page
 * called `Fees and funding` is a good guess about the benefits section; a page
 * whose link text contains "settling-in allowance" is the page that states the
 * settling-in allowance, and on a second pass that is the only thing worth
 * spending a fetch on.
 */
function gapAffinity(phrases: string[], label: string, url: string): number {
  if (phrases.length === 0) return 0;

  let haystack = label.toLowerCase();
  try {
    haystack += ` ${decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ").toLowerCase()}`;
  } catch {
    // Judged on the label alone.
  }

  const hits = phrases.filter((phrase) => haystack.includes(phrase)).length;
  // Capped like `titleAffinity`, and for the same reason: a long phrase list
  // must not be able to outrank every other signal by weight of numbers.
  return Math.min(hits, 3) * 12;
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
  // `used` counts pages kept PLUS pages in flight — see `claimed` in the crawl
  // loop. Counting only what has landed would let four concurrent lanes each
  // claim the last slot of the same topic and blow the reservation.
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
  const phrases = (options.gapPhrases ?? []).map((phrase) => phrase.toLowerCase());
  const lanes = Math.min(Math.max(options.concurrency ?? 4, 1), 8);
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

  // A resumed crawl must not re-fetch what the first one already read. Seeded
  // into BOTH sets: `seen` stops the links being queued, `fetchedUrls` stops a
  // redirect landing on one of them and being counted.
  //
  // CANONICALISED HERE rather than by the caller. Both sets are keyed on the
  // canonical spelling, and a caller naturally passes `page.url` — the
  // post-redirect address, which may carry a trailing slash or a parameter the
  // canonical form drops. Matching those by hand at every call site is a
  // dedupe that silently stops working the first time somebody forgets.
  for (const raw of options.skipUrls ?? []) {
    let key = raw;
    try {
      key = canonicaliseUrl(new URL(raw));
    } catch {
      // Not a URL we can parse; the literal is still better than nothing.
    }
    seen.add(key.replace(/\/$/, ""));
    fetchedUrls.add(key);
  }

  const queue: Candidate[] = [];

  // The entry page always gets fetched, whatever it scores, and it is not
  // charged to any topic's reservation.
  let entry: CrawledPage | null = null;
  try {
    const page = await fetchPage(entryUrl);
    entry = { ...page, topic: "entry", linkScore: Infinity, depth: 0 };

    /**
     * RETURNED only when the caller does not already have it.
     *
     * The entry is always FETCHED — it is free on a second crawl, because the
     * page cache answers it, and its links are the whole frontier. But a
     * resumed crawl starts from the same entry the first one did, so returning
     * it again puts a duplicate page into the caller's list: the same text
     * twice in the grounding corpus, and the same blocks competing twice for
     * the gap pass's budget.
     */
    const landed = canonicaliseUrl(new URL(page.url));
    if (!fetchedUrls.has(landed)) pages.push(entry);
    fetchedUrls.add(landed);
    seen.add(landed);
  } catch (error) {
    return {
      pages: [],
      visited: [],
      errors: [
        {
          url: entryUrl,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof HttpError ? { status: error.status } : {}),
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
      const affinity =
        titleAffinity(tokens, link.label, link.url) +
        gapAffinity(phrases, link.label, link.url);
      const total = score + affinity;
      if (total < minLinkScore) continue;

      /**
       * A PDF has to earn its fetch with actual vocabulary, not a year.
       *
       * PDFs are now readable (see pdf.ts) and they are where funders put the
       * rules — but they are also the most expensive thing the crawler can
       * choose: a megabyte to download and a document to parse, against a page
       * budget that a guideline and a scanned exam paper cost the same.
       *
       * And a filename is mostly numbers. `/ja/_mt/2023/06/2019_ke_ja.pdf` is a
       * past exam paper, and it cleared the threshold on nothing but "2019" and
       * "2023" scoring as dates — nine of those were fetched in one MEXT crawl,
       * every one a scan with no text layer. So a PDF must score on words
       * somebody chose: deadline language, or any topic other than `dates`.
       */
      if (/\.pdf(\?|#|$)/i.test(link.url)) {
        const earned =
          hasDeadlineLanguage(readable) ||
          affinity > 0 ||
          TOPICS.some((candidate) => candidate !== "dates" && scores[candidate] > 0);
        if (!earned) continue;
      }

      seen.add(key);
      queue.push({ url: link.url, depth: page.depth + 1, topic, score: total, scores });
    }
  };

  enqueueLinksFrom(entry);

  /** Pages requested but not yet landed. Kept off `pages.length` on purpose. */
  let inFlight = 0;
  /** Reservations held by in-flight fetches, so quotas cannot be over-claimed. */
  const claimed = emptyCounts();

  /** Room for one more request: budget left, and space for the page it returns. */
  const canDispatch = () =>
    fetchBudget > 0 && pages.length + inFlight < maxPages;

  // Hubs are fetched before the topic loop so their navigation is already in
  // the frontier when quotas start being spent. Like the entry page they are
  // not charged to any topic — they are how the topics get found at all.
  //
  // Fetched together rather than one after another: they are two or three
  // requests to the same host, so the per-host gate spaces them anyway and
  // serialising the wait as well only adds their latency together.
  const hubUrls = hubCandidates(entry.url, maxHubs).filter((hubUrl) => {
    const key = canonicaliseUrl(new URL(hubUrl));
    if (seen.has(key) || fetchedUrls.has(key)) return false;
    seen.add(key);
    return true;
  });

  const hubResults = await Promise.all(
    hubUrls.slice(0, Math.max(0, Math.min(hubUrls.length, fetchBudget))).map(
      async (hubUrl) => {
        fetchBudget--;
        try {
          return await fetchPage(hubUrl);
        } catch {
          // A missing ancestor is completely normal — plenty of sites have no
          // page at an intermediate path. Not worth reporting as a crawl error.
          return null;
        }
      },
    ),
  );

  for (const hub of hubResults) {
    if (!hub || pages.length >= maxPages) continue;

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

  /**
   * The topic loop, several requests deep.
   *
   * Each pass fills the free lanes from the queue — respecting quotas, which
   * count in-flight claims as spent — and then waits for whichever request
   * finishes first. A landed page enqueues its own links before the next
   * dispatch, so the ranking still improves as the crawl goes; it simply is not
   * allowed to hold up requests that were already worth making.
   */
  const running = new Set<Promise<unknown>>();

  const dispatch = (next: Candidate) => {
    fetchBudget--;
    inFlight++;
    claimed[next.topic]++;

    const task = (async () => {
      let fetched: FetchedPage;
      try {
        fetched = await fetchPage(next.url);
      } catch (error) {
        errors.push({
          url: next.url,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof HttpError ? { status: error.status } : {}),
        });
        // A failed fetch fills no quota — release the reservation for a page
        // that might actually answer.
        return;
      } finally {
        inFlight--;
        claimed[next.topic]--;
      }

      // Dedupe again on what came BACK, not just on what we asked for. Two
      // links can differ before the request and be the same page after it — a
      // redirect, or a query parameter the server ignores — and a page counted
      // twice spends a topic's reservation on a document we already have.
      const landed = canonicaliseUrl(new URL(fetched.url));
      if (fetchedUrls.has(landed)) return;
      fetchedUrls.add(landed);
      seen.add(landed);

      // Concurrency means a lane can land after the budget is full. Keeping it
      // would overshoot maxPages, which is the passage budget's ceiling too.
      if (pages.length >= maxPages) return;

      const page: CrawledPage = {
        ...fetched,
        topic: next.topic,
        linkScore: next.score,
        depth: next.depth,
      };
      pages.push(page);
      topicCounts[next.topic]++;

      enqueueLinksFrom(page);
    })();

    running.add(task);
    void task.then(() => running.delete(task));
  };

  for (;;) {
    while (running.size < lanes && queue.length > 0 && canDispatch()) {
      const used = {
        dates: topicCounts.dates + claimed.dates,
        eligibility: topicCounts.eligibility + claimed.eligibility,
        benefits: topicCounts.benefits + claimed.benefits,
        documents: topicCounts.documents + claimed.documents,
        process: topicCounts.process + claimed.process,
      };

      const index = pickNext(queue, used, quotas);
      if (index === -1) break;
      dispatch(queue.splice(index, 1)[0]!);
    }

    if (running.size === 0) break;
    await Promise.race(running);
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
