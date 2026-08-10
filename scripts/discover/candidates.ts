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
  /\/(news|newsroom|newsletter|news-and-events|latest-[a-z-]*news|blog|press|stories|events|privacy|cookie|terms|contact|search|login|account|sitemap|tag|category|author|feed)(\/|$)/i;

/**
 * Dated path segments — the shape of a blog archive, not of a programme.
 *
 * `/september-2015/gates-foundation-grants` and
 * `/students/newsletter/october-2015/discretionary-funding-available-apply-now`
 * are newsletter posts. They score WELL: "funding" and "grants" are programme
 * words, the paths are deep, and the month-and-year that makes them archives is
 * read by the date scorer as a positive. Edinburgh's first sitemap harvest came
 * back as five of these.
 *
 * Anchor text used to hide the problem — "Read the October newsletter" scores
 * nothing. A sitemap has no anchor text at all, so the path has to carry the
 * whole judgement, and a segment that is nothing but a date is the clearest
 * signal an archive gives.
 *
 * Only a segment that is ENTIRELY a date counts. `chevening-2026` and
 * `2026-intake` are programme pages and must survive.
 */
const ARCHIVE_PATH =
  /\/((19|20)\d{2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_](19|20)\d{2}|(19|20)\d{2}[-_]\d{1,2})(\/|$)/i;

/**
 * Pages about a programme, written for someone who is not an applicant.
 *
 * Fulbright's `/host-institutions/flta-program/flta-during-the-program` and
 * `/host-institutions/flta-program/flta-thinking-of-applying` are guidance for
 * universities hosting fellows. Both describe the FLTA programme, so the
 * classifier said "yes, a programme" to each — and staged the same award twice,
 * from two pages that never mention what it pays.
 *
 * These sections are where a site keeps material for people already inside the
 * programme: current grantees, alumni, host institutions, advisers, staff.
 * Nothing an applicant needs lives there.
 *
 * `current-*` is matched broadly and then carved back, rather than listed:
 * the people-noun after it is whatever the funder calls its own alumni
 * (`/current-fulbrighters/`, `/current-grantees/`, `/current-chevening-
 * scholars/`), and no list will predict them all. What must NOT be swept up is
 * `/current-scholarships/` — a thing-noun, and a perfectly good index of open
 * awards — so the funding words are excluded by lookahead and everything else
 * after `current-` is still treated as an audience.
 */
const INTERNAL_AUDIENCE_PATH =
  /\/(host-institutions?|current-(?!scholarships?\b|awards?\b|grants?\b|fellowships?\b|opportunit|funding\b|competitions?\b)[a-z-]+|alumni|scholar-support|for-(advisers|advisors|partners|staff|institutions)|staff|faculty-resources|program-resources|panelist)s?(\/|$)/i;

/** Does this link look like it points at a programme rather than an article? */
export function scoreCandidate(label: string, url: string): number {
  const parsed = new URL(url);
  if (REJECT_PATH.test(parsed.pathname)) return -1;
  if (ARCHIVE_PATH.test(parsed.pathname)) return -1;
  if (INTERNAL_AUDIENCE_PATH.test(parsed.pathname)) return -1;

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
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A title reduced to what makes two names the SAME programme.
 *
 * Exact matching on a lowercased title let "Chevening Scholarship" and
 * "Chevening Scholarships" both into the database, where they now sit next to
 * each other on the dashboard contradicting one another. One character of
 * difference should not buy a second row.
 *
 * Punctuation goes, then a trailing `s` on every word — crude, and crude is
 * fine here because both sides get the same treatment and the result is only
 * ever compared, never displayed. "Studies" becoming "studie" costs nothing.
 *
 * Note what it deliberately does NOT do: any kind of fuzzy or substring match.
 * "Chevening Fellowships" and "Chevening Scholarships" are different awards
 * with different money and different deadlines, and quietly merging two real
 * programmes is a worse failure than showing two rows.
 */
export function titleFingerprint(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word.length > 3 ? word.replace(/s$/, "") : word))
    .join(" ");
}

/**
 * The URL a page says it is, when it says so.
 *
 * `rel="canonical"` and `og:url` collapse the trailing-slash, tracking-param
 * and print-view variants that otherwise queue as separate candidates. Only
 * same-origin canonicals are honoured — a syndicated page pointing at someone
 * else's site is not evidence about ours.
 */
export function canonicalUrl(page: FetchedPage): string {
  const patterns = [
    /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*\bhref\s*=\s*["']([^"']+)["']/i,
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']?canonical["']?/i,
    /<meta\b[^>]*\bproperty\s*=\s*["']og:url["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const href = pattern.exec(page.html)?.[1];
    if (!href) continue;
    try {
      const resolved = new URL(href, page.url);
      if (resolved.origin !== new URL(page.url).origin) continue;
      return canonicaliseUrl(resolved);
    } catch {
      continue;
    }
  }

  return canonicaliseUrl(new URL(page.url));
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

  /**
   * Answers that are not a country at all.
   *
   * A classifier asked "which country?" about the Rotary Peace Fellowship — one
   * programme, six partner universities on four continents — answers
   * "Unknown", or "Various", or "Worldwide". Stored raw, that becomes a filter
   * chip that renders and cannot filter, because the UI's country list is a
   * closed union. `Multiple` is in that union, so the row stays reachable.
   */
  unknown: "Multiple",
  unspecified: "Multiple",
  various: "Multiple",
  worldwide: "Multiple",
  global: "Multiple",
  international: "Multiple",
  "multiple countries": "Multiple",
  "several countries": "Multiple",
  "not specified": "Multiple",
  "n/a": "Multiple",
};

export function normaliseCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return COUNTRY_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
