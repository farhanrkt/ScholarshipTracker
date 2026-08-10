import { createHash } from "node:crypto";

import { isPdf, MAX_PDF_BYTES, pdfToText } from "./pdf.ts";

const USER_AGENT =
  process.env.CRAWL_USER_AGENT ||
  "ScholarTrackBot/1.0 (scholarship deadline verification; +https://github.com/)";

/**
 * The second identity, used ONLY after a host has refused the first one.
 *
 * A large share of the 403s in a run are not the site saying "not you" — they
 * are a WAF rejecting a request that does not look like a browser: no
 * Accept-Language, a bare bot token, no Sec-Fetch headers. The page is public,
 * robots.txt allows it, and a person opening the same URL gets it instantly.
 *
 * This still names us and still carries the contact URL, so the site can
 * identify and block us deliberately if it wants to — and robots.txt, which is
 * the mechanism a site actually uses to say no, is honoured before either
 * identity is used. What changes is only the shape of the request.
 */
const BROWSER_USER_AGENT =
  process.env.CRAWL_FALLBACK_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36 ScholarTrackBot/1.0 (+https://github.com/)";

/**
 * Be a polite client: one request at a time per host, with a gap between them.
 *
 * 800ms rather than the original 1,500. The gap is a floor on how long a crawl
 * of one site can possibly take — sixteen pages cannot finish faster than
 * fifteen gaps — and at 1.5s that floor was 24 seconds per programme before a
 * single byte of latency. Any `Crawl-delay` the site publishes still overrides
 * this upward, and `CRAWL_DELAY_MS` raises the floor for a run that needs to be
 * gentler.
 */
export const FETCH_DELAY_MS = Number(process.env.CRAWL_DELAY_MS) || 800;

/**
 * A response the server answered with an error status.
 *
 * Carries the status so callers can tell the two failure families apart, which
 * they must: a 404 means the URL we hold is WRONG and re-running will never fix
 * it, while a 403 means the URL is probably fine and we were turned away.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }

  /** Does this status mean the page is gone, as opposed to withheld? */
  get isDeadLink(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

export interface FetchedPage {
  url: string;
  /** Plain text. Grounding compares against exactly this. */
  text: string;
  /** Raw HTML, kept only so the crawler can read links out of it. */
  html: string;
  sha256: string;
  fetchedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The single normalisation used on BOTH sides of the grounding check.
 *
 * If the page text and the model's quote are normalised differently, grounding
 * produces false rejections (or worse, false passes), so this function is the
 * contract — never normalise inline anywhere else.
 */
export function normalise(input: string): string {
  return input
    .replace(/ /g, " ") // non-breaking space
    .replace(/[‘’‛]/g, "'") // curly single quotes
    .replace(/[“”]/g, '"') // curly double quotes
    .replace(/[‐-―]/g, "-") // dashes of every width
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: "...",
};

function decodeEntities(html: string): string {
  return html
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * HTML to text. Deliberately dependency-free: the goal is faithful *wording*,
 * not layout, and a full DOM parser buys nothing for that.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      // `nav` and `footer` carry the same twenty link labels on every page of a
      // site. As TEXT they are pure noise: they crowd real prose out of the
      // passage budget and give the model month names to misread as deadlines.
      // Their LINKS are still harvested, because extractLinks reads the raw
      // HTML — which is the arrangement we want, since navigation is a
      // hand-written index of the pages worth crawling.
      .replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
      // Block-level boundaries become newlines so adjacent cells and list items
      // do not silently fuse into one phantom sentence.
      .replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|br)\s*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* robots.txt                                                                 */
/* -------------------------------------------------------------------------- */

/** Our own token, as it appears in a robots.txt User-agent line. */
const ROBOTS_TOKEN = "scholartrackbot";

interface RobotsRule {
  /** Path pattern, may contain `*` and a trailing `$`. */
  pattern: string;
  allow: boolean;
}

interface RobotsPolicy {
  rules: RobotsRule[];
  /** Seconds the site asks us to wait between requests, if it says. */
  crawlDelayMs: number | null;
  /**
   * Sitemaps the site advertises.
   *
   * `Sitemap:` is global to the file rather than scoped to a User-agent group,
   * which is why it is collected outside the groups below. It is also the one
   * place a site volunteers a complete index of its own pages — worth far more
   * to discovery than any link we could find by crawling.
   */
  sitemaps: string[];
}

const robotsCache = new Map<string, RobotsPolicy>();

/**
 * robots.txt, parsed the way the standard actually works.
 *
 * The previous version collected `Disallow` lines and ignored everything else,
 * which is not "conservative" — it is wrong in both directions:
 *
 *  - **No `Allow` support.** A site whose robots.txt reads `Disallow: /`
 *    followed by `Allow: /scholarships/` is explicitly inviting us to the one
 *    section we want, and we refused to fetch any of it.
 *  - **Groups were merged.** Rules under `User-agent: Googlebot` were applied
 *    to us, and a `User-agent: *` group followed by any other group lost its
 *    rules entirely, because one flag was overwritten line by line.
 *
 * The rule now: collect every group, prefer the one naming us over `*`, and
 * within it let the LONGEST matching pattern win — allow beating disallow on a
 * tie, which is what the major crawlers do.
 */
function parseRobots(body: string): RobotsPolicy {
  const groups = new Map<string, { rules: RobotsRule[]; crawlDelay: number | null }>();
  const sitemaps: string[] = [];
  let currentAgents: string[] = [];
  // Consecutive User-agent lines share one block of rules; a rule line ends the
  // run of agents so the next User-agent starts a fresh group.
  let collectingAgents = false;

  const ensure = (agent: string) => {
    const existing = groups.get(agent);
    if (existing) return existing;
    const created = { rules: [] as RobotsRule[], crawlDelay: null as number | null };
    groups.set(agent, created);
    return created;
  };

  for (const rawLine of body.split("\n")) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      if (!collectingAgents) currentAgents = [];
      collectingAgents = true;
      currentAgents.push(value.toLowerCase());
      continue;
    }

    // Global directive: it belongs to the file, not to whichever group happens
    // to precede it, so it is read before the group check below.
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    collectingAgents = false;
    if (currentAgents.length === 0) continue;

    for (const agent of currentAgents) {
      const group = ensure(agent);
      if (key === "disallow") {
        // An empty Disallow means "allow everything" — not "block everything".
        if (value) group.rules.push({ pattern: value, allow: false });
      } else if (key === "allow") {
        if (value) group.rules.push({ pattern: value, allow: true });
      } else if (key === "crawl-delay") {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds > 0) group.crawlDelay = seconds;
      }
    }
  }

  const chosen =
    [...groups.entries()].find(([agent]) => agent && ROBOTS_TOKEN.startsWith(agent))?.[1] ??
    groups.get("*");

  return {
    rules: chosen?.rules ?? [],
    crawlDelayMs: chosen?.crawlDelay ? chosen.crawlDelay * 1_000 : null,
    sitemaps,
  };
}

/** robots.txt patterns support `*` (any run) and `$` (end of path). */
function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  if (!body.includes("*")) {
    if (anchored) return path === body ? body.length : -1;
    return path.startsWith(body) ? body.length : -1;
  }

  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${escaped}${anchored ? "$" : ""}`);
  return regex.test(path) ? body.length : -1;
}

async function policyFor(origin: string): Promise<RobotsPolicy> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  let policy: RobotsPolicy = { rules: [], crawlDelayMs: null, sitemaps: [] };
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    // A missing or unreadable robots.txt is treated as allow, per the standard.
    if (response.ok) policy = parseRobots(await response.text());
  } catch {
    policy = { rules: [], crawlDelayMs: null, sitemaps: [] };
  }

  robotsCache.set(origin, policy);
  return policy;
}

export async function isAllowed(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const { rules } = await policyFor(parsed.origin);
  const path = parsed.pathname + parsed.search;

  let verdict = true;
  let strongest = -1;

  for (const rule of rules) {
    const length = matchLength(rule.pattern, path);
    // Longest match wins; Allow wins ties, which is how Google and Bing read it
    // and the reading a site owner writing an exception intends.
    if (length > strongest || (length === strongest && rule.allow)) {
      strongest = length;
      verdict = rule.allow;
    }
  }

  return verdict;
}

/** Sitemaps this origin advertises in robots.txt, if any. */
export async function declaredSitemaps(url: string): Promise<string[]> {
  try {
    return (await policyFor(new URL(url).origin)).sitemaps;
  } catch {
    return [];
  }
}

/**
 * Fetch a non-HTML text resource — a sitemap — under the same politeness and
 * robots rules as a page.
 *
 * Separate from `fetchPage` because that function is built for documents we
 * intend to READ: it converts HTML to text, hashes it for change detection, and
 * rejects anything under 200 characters as JavaScript-rendered. None of that
 * applies to XML we only intend to pull URLs out of, and the content-type check
 * in particular rejects the `application/xml` most sitemaps are served as.
 *
 * THE ACCEPT HEADER IS NOT COSMETIC. `fetchWithRetry` defaults to
 * `text/html,application/xhtml+xml` because that is what a page crawl wants,
 * and a server that honours content negotiation answers a request for XML with
 * **406 Not Acceptable** when told we only read HTML. Nottingham does exactly
 * that: its sitemap 406s under the HTML header and returns 19,917 URLs — 269 of
 * them scholarship-shaped — under a neutral one. The failure is silent, because
 * a 406 looks like any other "this origin has no sitemap".
 */
export async function fetchText(url: string, maxBytes = 5_000_000): Promise<string> {
  if (!(await isAllowed(url))) {
    throw new Error(`robots.txt disallows fetching ${url}`);
  }

  const { host } = new URL(url);
  const { delay, limit } = await politenessFor(url);
  const response = await schedulePerHost(host, delay, limit, () =>
    fetchWithRetry(url, ACCEPT_XML),
  );

  if (!response.ok) throw new HttpError(response.status, url);

  const body = await response.text();
  // Big sites publish enormous sitemaps; there is no value in holding one in
  // memory beyond the point where it stops being worth reading.
  return body.length > maxBytes ? body.slice(0, maxBytes) : body;
}

/** How long this origin asks us to wait between requests, if it says at all. */
export async function crawlDelayFor(url: string): Promise<number | null> {
  try {
    return (await policyFor(new URL(url).origin)).crawlDelayMs;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Fetch                                                                      */
/* -------------------------------------------------------------------------- */

/** Statuses that mean "not now" rather than "no". */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/**
 * Statuses that mean "not like that" — worth exactly one retry as a browser.
 *
 * 403 is the big one: a public page behind a WAF that scores the request rather
 * than the URL. 406 is content negotiation refusing our Accept header, and 451
 * and 401 are occasionally emitted by the same middleware for the same reason.
 * None of these are retried more than once, and none are retried at all if the
 * second identity gets the same answer — a site that means it is left alone.
 */
const REFUSED = new Set([401, 403, 406, 451]);

const MAX_ATTEMPTS = 3;

/**
 * How long to wait for a page, and how hard to try when nothing comes back.
 *
 * These two numbers were the largest avoidable cost in a run. At 30 seconds and
 * three attempts, a page that never responds costs 30+2+30+4+30 ≈ 96 seconds,
 * and a single Chevening run spent about four and a half minutes on three such
 * pages. The whole run was 15:07 of wall-clock for 2.4 seconds of CPU.
 *
 * A server that has not sent a byte in fifteen seconds is not thinking, it is
 * gone — and unlike a 503, which is the server telling us to come back, a
 * timeout carries no such promise. So timeouts get one retry rather than two:
 * a slow page is retried once in case the network hiccuped, and then abandoned
 * to the twelve other pages waiting behind it.
 *
 * Status-based retries are UNCHANGED at three attempts. A 429 or 503 is an
 * explicit "later", frequently with a Retry-After, and that is worth honouring.
 */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_ATTEMPTS = 2;

/** Did this failure mean "no answer", as opposed to "not now"? */
function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * One fetch, retried only when the server said the failure was temporary.
 *
 * A 404 is an answer and is not retried. A 429 or a 503 is the server asking us
 * to come back, and abandoning the page loses a programme's entire coverage
 * section over a momentary rate limit — which is exactly what was happening on
 * the busier university sites.
 *
 * `Retry-After` is honoured when present, because a server that tells you how
 * long to wait has earned being listened to.
 */
/**
 * What we tell the server we can read. See the 406 note on `fetchText`.
 *
 * `*\/*;q=0.8` on the HTML header is not decoration: a server that negotiates
 * content and is told we accept ONLY html answers 406 for a page it serves as
 * `application/xhtml+xml;charset=utf-8` or, more often, for one it serves
 * correctly but describes oddly.
 */
// `application/pdf` is named explicitly rather than left to the `*/*` tail: a
// content-negotiating server offered only HTML will hand back an HTML landing
// page for a URL that is a PDF, and we would read the wrapper instead of the
// guideline.
const ACCEPT_HTML =
  "text/html,application/xhtml+xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8";
const ACCEPT_XML = "application/xml,text/xml;q=0.9,*/*;q=0.8";

/** Hosts that have already refused our own identity, so we skip straight past it. */
const refusedOurAgent = new Set<string>();

function headersFor(accept: string, asBrowser: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": asBrowser ? BROWSER_USER_AGENT : USER_AGENT,
    accept,
    // Sites serving several languages routinely 406 or redirect-loop a request
    // that expresses no preference at all.
    "accept-language": "en-GB,en;q=0.9",
  };

  if (asBrowser) {
    headers["sec-fetch-dest"] = "document";
    headers["sec-fetch-mode"] = "navigate";
    headers["sec-fetch-site"] = "none";
    headers["upgrade-insecure-requests"] = "1";
  }

  return headers;
}

async function fetchWithRetry(url: string, accept = ACCEPT_HTML): Promise<Response> {
  let lastError: Error | null = null;
  const { host } = new URL(url);
  // Once a host has turned our own agent away, every later page on it starts
  // with the second identity. Otherwise a site that 403s everything costs two
  // requests per page instead of one.
  let asBrowser = refusedOurAgent.has(host);
  let retriedAsBrowser = asBrowser;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: headersFor(accept, asBrowser),
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      // Turned away rather than answered: try once more looking like a browser,
      // and remember the host so its other pages skip the wasted first request.
      if (!retriedAsBrowser && REFUSED.has(response.status)) {
        retriedAsBrowser = true;
        asBrowser = true;
        refusedOurAgent.add(host);
        continue;
      }

      if (response.ok || !TRANSIENT.has(response.status)) return response;

      lastError = new HttpError(response.status, url);
      if (attempt === MAX_ATTEMPTS) return response;

      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1_000, 30_000)
        : attempt * 2_000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } catch (error) {
      // A DNS or connection failure is worth one more try; a bad URL fails the
      // same way again and costs two seconds. A TIMEOUT gets a lower ceiling —
      // see FETCH_TIMEOUT_MS: no answer is not a promise of a later one, and
      // the pages queued behind this one are worth more than a third attempt.
      lastError = error instanceof Error ? error : new Error(String(error));
      const ceiling = isTimeout(error) ? MAX_TIMEOUT_ATTEMPTS : MAX_ATTEMPTS;
      if (attempt >= ceiling) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }

  throw lastError ?? new Error(`Could not fetch ${url}`);
}

/* -------------------------------------------------------------------------- */
/* Per-host politeness                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How many requests may be open to one host at a time.
 *
 * Two, and the number is the whole reason the crawl got faster.
 *
 * The previous scheduler put every request to a host on ONE promise chain and
 * measured the gap from the END of the last response. That is strictly serial:
 * a page costs `latency + gap`, and no amount of concurrency anywhere above it
 * changes that, because a programme's pages are all on the same host. Crawling
 * twenty pages of a site answering in two seconds cost 20 × 2.8s ≈ 56 seconds
 * of almost entirely idle waiting, and the "parallel" crawl above it was
 * queueing behind itself.
 *
 * Two open connections with request STARTS spaced by the delay is both faster
 * and still conservative — a browser opens six per host without anyone
 * considering it rude, and the sustained rate is unchanged at one request per
 * gap. What changes is that the gap now overlaps the latency instead of
 * following it.
 *
 * A site that publishes a `Crawl-delay` is asking for spacing explicitly, and
 * gets exactly one connection: an explicit request outranks our throughput.
 */
const HOST_CONCURRENCY = Number(process.env.CRAWL_HOST_CONCURRENCY) || 2;

/** Earliest moment the next request to a host may START. */
const nextStartAt = new Map<string, number>();
/** Requests currently open per host, and whoever is waiting for a slot. */
const openPerHost = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

function acquire(host: string, limit: number): Promise<void> {
  const open = openPerHost.get(host) ?? 0;
  if (open < limit) {
    openPerHost.set(host, open + 1);
    return Promise.resolve();
  }
  // FIFO, so a crawl cannot be starved by later arrivals on a busy host.
  return new Promise<void>((resolve) => {
    const queue = waiting.get(host) ?? [];
    queue.push(resolve);
    waiting.set(host, queue);
  });
}

function release(host: string): void {
  const queue = waiting.get(host);
  const next = queue?.shift();
  // The slot is HANDED OVER rather than freed and re-taken, which is what keeps
  // the open count honest under concurrency.
  if (next) {
    next();
    return;
  }
  openPerHost.set(host, Math.max(0, (openPerHost.get(host) ?? 1) - 1));
}

/**
 * Spaces requests to ONE host while letting different hosts run at once.
 *
 * Politeness used to live in the callers: every crawl loop slept between
 * fetches. That works only while exactly one crawl exists. The moment two
 * programmes are extracted concurrently — and three of them can share a host,
 * as the Chevening rows do — caller-side sleeps stop meaning anything and the
 * site gets simultaneous hits. Keeping the gate here makes the guarantee
 * structural, and callers cannot get it wrong by forgetting to sleep.
 *
 * The slot is reserved BEFORE the wait, not after it, so requests leave in the
 * order they arrived and a burst cannot all decide to start at the same moment.
 */
async function schedulePerHost<T>(
  host: string,
  delayMs: number,
  limit: number,
  task: () => Promise<T>,
): Promise<T> {
  await acquire(host, limit);

  try {
    const now = Date.now();
    const startAt = Math.max(now, nextStartAt.get(host) ?? 0);
    nextStartAt.set(host, startAt + delayMs);

    const wait = startAt - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    return await task();
  } finally {
    release(host);
  }
}

/** The delay and the connection limit this origin has earned. */
async function politenessFor(
  url: string,
): Promise<{ delay: number; limit: number }> {
  const declared = await crawlDelayFor(url);
  return {
    delay: Math.max(FETCH_DELAY_MS, declared ?? 0),
    limit: declared ? 1 : HOST_CONCURRENCY,
  };
}

/* -------------------------------------------------------------------------- */
/* Within-run page cache                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One fetch per URL per run, however many crawls want it.
 *
 * Programmes on the same site overlap almost completely. Three Chevening rows
 * were observed crawling the SAME sixteen pages — 48 requests where 16 would
 * do — because each row runs its own crawl and nothing remembered the last one.
 * MEXT did the same across two rows.
 *
 * That is three times the wall-clock, and three times the load on a funder's
 * server for no new information. The politeness gate makes it slow rather than
 * rude, which is the right trade but not a reason to do it at all: the fastest
 * and politest request is the one you do not send.
 *
 * PROMISES ARE CACHED, NOT RESULTS. Concurrent crawls request the same page at
 * the same time — that is the normal case with `--concurrency 3` on one host —
 * so storing the in-flight promise means the second caller awaits the first
 * rather than starting a second identical request.
 *
 * Rejections are evicted: a page that 404s for one programme should still be
 * ATTEMPTED for the next, since the failure may have been transient and
 * `fetchWithRetry` has its own view on that.
 *
 * `fetchedAt` on a cache hit is the time of the original fetch, not of the hit.
 * That is the honest value — it is when the bytes were actually read — and it
 * is what gets stored as the extraction's `fetched_at`.
 */
/**
 * Bounded by BYTES, not by entry count.
 *
 * A cached page holds its raw HTML as well as its text, because the crawler
 * reads links out of the HTML. University pages routinely run to several
 * hundred kilobytes of markup, so a 500-entry cap is somewhere between 5 MB and
 * 250 MB depending on which sites a run happens to touch — a limit that does
 * not limit anything you can predict. A byte budget does.
 */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** Belt and braces: a pathological run of tiny pages should not grow forever. */
const MAX_CACHED_PAGES = 1_000;

const pageCache = new Map<string, Promise<FetchedPage>>();
/** Resolved sizes, so eviction can account for what is actually held. */
const cachedBytes = new Map<string, number>();
let totalCachedBytes = 0;

let cacheHits = 0;
let cacheMisses = 0;

function forget(key: string): void {
  pageCache.delete(key);
  const size = cachedBytes.get(key);
  if (size !== undefined) {
    totalCachedBytes -= size;
    cachedBytes.delete(key);
  }
}

/** Evicts oldest-first until both budgets are satisfied. */
function trimCache(): void {
  while (
    (totalCachedBytes > MAX_CACHE_BYTES || pageCache.size > MAX_CACHED_PAGES) &&
    pageCache.size > 1
  ) {
    const oldest = pageCache.keys().next();
    if (oldest.done) break;
    forget(oldest.value);
  }
}

/**
 * Requests served from the cache versus sent.
 *
 * Reported in the run summary so the saving is a number rather than a claim —
 * a cache whose hit rate silently fell to zero looks exactly like one that is
 * working.
 */
export function pageCacheStats(): { hits: number; misses: number } {
  return { hits: cacheHits, misses: cacheMisses };
}

/** Drops the cache. Exists for tests and long-lived processes. */
export function clearPageCache(): void {
  pageCache.clear();
  cachedBytes.clear();
  totalCachedBytes = 0;
  cacheHits = 0;
  cacheMisses = 0;
}

function cacheKey(url: string): string {
  try {
    return canonicaliseUrl(new URL(url));
  } catch {
    return url;
  }
}

export function fetchPage(url: string): Promise<FetchedPage> {
  const key = cacheKey(url);

  const cached = pageCache.get(key);
  if (cached) {
    cacheHits++;
    return cached;
  }

  cacheMisses++;
  const pending = fetchPageUncached(url).then((page) => {
    const size = page.html.length + page.text.length;
    if (pageCache.has(key)) {
      cachedBytes.set(key, size);
      totalCachedBytes += size;
    }

    // Also key on where we LANDED. Two different URLs that redirect to one page
    // are one page, and the next crawl should get it without the round trip.
    const landed = cacheKey(page.url);
    if (landed !== key && !pageCache.has(landed)) {
      pageCache.set(landed, Promise.resolve(page));
      cachedBytes.set(landed, size);
      totalCachedBytes += size;
    }

    // Oldest first: a crawl's early pages are the least likely to be wanted
    // again, and Map iterates in insertion order.
    trimCache();
    return page;
  });

  pending.catch(() => forget(key));

  pageCache.set(key, pending);
  return pending;
}

async function fetchPageUncached(url: string): Promise<FetchedPage> {
  if (!(await isAllowed(url))) {
    throw new Error(`robots.txt disallows fetching ${url}`);
  }

  const { host } = new URL(url);
  const { delay, limit } = await politenessFor(url);
  const response = await schedulePerHost(host, delay, limit, () =>
    fetchWithRetry(url),
  );

  if (!response.ok) {
    throw new HttpError(response.status, url);
  }

  const contentType = response.headers.get("content-type");
  const landedUrl = response.url || url;

  /**
   * A PDF is a page here, not an attachment.
   *
   * MEXT and the Global Korea Scholarship publish a short HTML overview and put
   * the eligibility limits, the stipend, the document checklist and the closing
   * date in a PDF guideline. Skipping those was the direct reason the Japan and
   * Korea rows were thin: the pipeline read the poster and skipped the handbook.
   */
  if (isPdf(contentType, landedUrl)) {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_PDF_BYTES) {
      throw new Error(
        `${url} is ${(declared / 1e6).toFixed(1)} MB of PDF — too large to read`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    // Checked again against what arrived: content-length is optional, and a
    // chunked response can simply not declare one.
    if (bytes.byteLength > MAX_PDF_BYTES) {
      throw new Error(
        `${url} is ${(bytes.byteLength / 1e6).toFixed(1)} MB of PDF — too large to read`,
      );
    }

    let pdfText: string;
    try {
      pdfText = await pdfToText(bytes);
    } catch (error) {
      throw new Error(
        `Could not read the PDF at ${url}: ${error instanceof Error ? error.message : error}`,
      );
    }

    if (pdfText.length < 200) {
      throw new Error(
        `${url} produced only ${pdfText.length} characters of text — a scanned PDF has no text layer, so it needs manual verification.`,
      );
    }

    return {
      url: landedUrl,
      text: pdfText,
      // No markup, so `extractLinks` finds nothing — which is right. A PDF is a
      // leaf of the crawl: we read it, we do not follow it.
      html: "",
      sha256: createHash("sha256").update(pdfText).digest("hex"),
      fetchedAt: new Date().toISOString(),
    };
  }

  // A server that declares nothing is not declaring a binary. Plenty of older
  // university pages send no content-type at all, and rejecting those threw
  // away readable HTML on a technicality — the text-length check below is the
  // real guard, and it judges what actually arrived.
  if (contentType && !/html|text|xml/i.test(contentType)) {
    throw new Error(`Expected HTML from ${url}, got "${contentType}"`);
  }

  const html = await response.text();
  const text = htmlToText(html);

  if (text.length < 200) {
    throw new Error(
      `${url} produced only ${text.length} characters of text — likely JavaScript-rendered, so it needs manual verification.`,
    );
  }

  return {
    // The post-redirect URL: what was actually read is what gets recorded.
    url: landedUrl,
    text,
    html,
    sha256: createHash("sha256").update(text).digest("hex"),
    fetchedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Links                                                                      */
/* -------------------------------------------------------------------------- */

export interface PageLink {
  url: string;
  /** Anchor text, used to judge whether the link is worth following. */
  label: string;
}

/**
 * `.pdf` is deliberately absent — see pdf.ts. Every other binary is still
 * skipped, because nothing in this pipeline can read a spreadsheet or a video
 * and a link to one is a fetch spent on nothing.
 */
const SKIP_EXTENSIONS =
  /\.(docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|webp|mp4|mp3|ics)$/i;

/**
 * Query parameters worth keeping. Everything else is dropped.
 *
 * An allowlist, not a blocklist, and the ordering matters historically: this
 * used to strip the query string entirely, on the reasoning that query params
 * are usually tracking and keeping them turns one page into fifty
 * near-identical fetches. That reasoning holds for `utm_source` and dies on
 * `?page=2` — it made pagination structurally invisible to discovery, which is
 * the single largest cap on how many programmes a run can find.
 *
 * So: keep the handful of params that address a DIFFERENT page of content,
 * drop the rest. Values are kept verbatim and keys sorted, so two links to the
 * same page still de-duplicate to one fetch.
 */
const KEEP_PARAMS = new Set([
  "page",
  "paged",
  "pg",
  "p",
  "start",
  "offset",
  "from",
  "tab",
  "view",
]);

/** The one URL spelling used for de-duplication everywhere. */
export function canonicaliseUrl(url: URL): string {
  const kept = [...url.searchParams.entries()]
    .filter(([key]) => KEEP_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));

  url.hash = "";
  url.search = "";
  for (const [key, value] of kept) url.searchParams.append(key, value);

  // Trailing slashes are cosmetic; a trailing slash before a query is not.
  const text = url.toString();
  return kept.length > 0 ? text : text.replace(/\/$/, "");
}

/**
 * Links out of a page, de-fragmented and de-duplicated.
 *
 * Same-origin by default — that is what a per-programme crawl wants. Discovery
 * passes `sameOriginOnly: false`, because index pages exist precisely to link
 * out to the funders they list.
 */
export function extractLinks(
  page: FetchedPage,
  options: { sameOriginOnly?: boolean } = {},
): PageLink[] {
  const sameOriginOnly = options.sameOriginOnly ?? true;
  const origin = new URL(page.url).origin;
  const seen = new Set<string>();
  const links: PageLink[] = [];

  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of page.html.matchAll(anchor)) {
    const [, href, inner] = match;
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) {
      continue;
    }

    let resolved: URL;
    try {
      resolved = new URL(href, page.url);
    } catch {
      continue;
    }

    if (sameOriginOnly && resolved.origin !== origin) continue;
    if (!/^https?:$/.test(resolved.protocol)) continue;
    if (SKIP_EXTENSIONS.test(resolved.pathname)) continue;

    const normalised = canonicaliseUrl(resolved);

    if (seen.has(normalised)) continue;
    seen.add(normalised);

    links.push({
      url: normalised,
      label: htmlToText(inner ?? "").slice(0, 120),
    });
  }

  return links;
}
