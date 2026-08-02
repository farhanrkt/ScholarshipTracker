import { canonicaliseUrl, type FetchedPage, type PageLink } from "../extract/page.ts";
import { scoreText } from "../extract/relevance.ts";

/**
 * Judging links on a listing page: which are programmes, and which are more
 * listing.
 *
 * Split out of `run.ts` so the seed-verification script can score links with
 * exactly the rules the crawler uses — a seed whose yield was measured with a
 * different heuristic is a seed measured wrong.
 */

const PROGRAMME_WORDS = [
  "scholarship",
  "fellowship",
  "grant",
  "award",
  "bursary",
  "studentship",
  "funding",
  "stipend",
];

const REJECT_PATH =
  /\/(news|blog|press|stories|events|privacy|cookie|terms|contact|search|login|account|sitemap|tag|category|author|feed)(\/|$)/i;

/** Does this link look like it points at a programme rather than an article? */
export function scoreCandidate(label: string, url: string): number {
  const parsed = new URL(url);
  if (REJECT_PATH.test(parsed.pathname)) return -1;

  const haystack = `${label} ${decodeURIComponent(parsed.pathname).replace(/[-_/]/g, " ")}`.toLowerCase();
  let score = 0;

  for (const word of PROGRAMME_WORDS) {
    if (haystack.includes(word)) score += 10;
  }
  // Deep paths are usually specific programmes; the root is usually an index.
  score += Math.min(parsed.pathname.split("/").filter(Boolean).length, 4) * 2;
  // Reuse the date-language scorer as a weak positive: programme pages tend to
  // mention applying.
  score += Math.min(scoreText(haystack).score, 10);

  return score;
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Anchor text that means "there is more of this list elsewhere".
 *
 * Bare numbers are included because numbered pagers are the most common form
 * on the portals we seed from, and they carry no other label. They are only
 * ever accepted when the URL also looks like the same list — see below — so a
 * link labelled "2" pointing at a programme page is not mistaken for a pager.
 */
const NEXT_LABEL =
  /^\s*(next( page)?|more|show more|load more|view all|see all|show all|older|»|›|>>|\d{1,3})\s*[»›>]*\s*$/i;

/** Params that address a different page of the SAME list. */
const PAGE_PARAMS = ["page", "paged", "pg", "p", "start", "offset", "from"];

/** WordPress and friends: /scholarships/page/2/ */
const PATH_PAGE = /\/page\/\d{1,3}\/?$/i;

function samePath(a: URL, b: URL): boolean {
  return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
}

function isPagerUrl(listing: URL, target: URL): boolean {
  if (target.origin !== listing.origin) return false;

  // Same path, different page param — the classic ?page=2.
  if (samePath(listing, target)) {
    return PAGE_PARAMS.some((param) => target.searchParams.has(param));
  }

  // /list/page/2 hanging off /list
  if (PATH_PAGE.test(target.pathname)) {
    const base = target.pathname.replace(PATH_PAGE, "");
    return listing.pathname.replace(/\/$/, "").startsWith(base.replace(/\/$/, ""));
  }

  return false;
}

/**
 * The next pages of the list this page is part of.
 *
 * Two independent signals, because sites publish one or the other and rarely
 * both: the machine-readable `rel="next"`, and a pager the human eye reads.
 */
export function findPaginationLinks(page: FetchedPage, links: PageLink[]): string[] {
  const listing = new URL(page.url);
  const found = new Set<string>();

  const relNext =
    /<(?:link|a)\b[^>]*\brel\s*=\s*["']?next["']?[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(
      page.html,
    ) ??
    /<(?:link|a)\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']?next["']?/i.exec(
      page.html,
    );

  if (relNext?.[1]) {
    try {
      found.add(canonicaliseUrl(new URL(relNext[1], page.url)));
    } catch {
      // A malformed rel=next is not worth failing a seed over.
    }
  }

  for (const link of links) {
    let target: URL;
    try {
      target = new URL(link.url);
    } catch {
      continue;
    }
    if (!isPagerUrl(listing, target)) continue;
    // "View all" is worth following whatever it points at within the same list;
    // a bare number only when the URL already looks like a pager, which
    // isPagerUrl has just confirmed.
    if (!NEXT_LABEL.test(link.label)) continue;

    found.add(canonicaliseUrl(target));
  }

  found.delete(canonicaliseUrl(new URL(page.url)));
  return [...found];
}

/** How many links on a page look like programmes — the "is this a list?" signal. */
export function countProgrammeLinks(links: PageLink[]): number {
  return links.filter((link) => scoreCandidate(link.label, link.url) >= 10).length;
}

/* -------------------------------------------------------------------------- */
/* Country names                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The classifier answers with whatever the page calls the country, and pages
 * say "United Kingdom" where the app's filters say "UK".
 *
 * `scholarships.country` is free text in the database but a six-value union in
 * the UI, so an unmapped spelling produces a row that exists, renders, and can
 * never be found by a country filter. Only the six targets are normalised —
 * anything else is passed through unchanged, because silently relabelling a
 * German programme would be worse than leaving it visibly out of scope.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "USA",
  "united states of america": "USA",
  us: "USA",
  "u.s.": "USA",
  "u.s.a.": "USA",
  america: "USA",
  "united kingdom": "UK",
  "great britain": "UK",
  britain: "UK",
  england: "UK",
  scotland: "UK",
  wales: "UK",
  "northern ireland": "UK",
  gb: "UK",
  "people's republic of china": "China",
  "peoples republic of china": "China",
  prc: "China",
  "mainland china": "China",
  "republic of korea": "South Korea",
  korea: "South Korea",
  "korea, south": "South Korea",
  "s. korea": "South Korea",
  "republic of singapore": "Singapore",
};

export function normaliseCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return COUNTRY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
