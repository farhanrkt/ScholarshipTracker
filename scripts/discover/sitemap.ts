import { scoreCandidate } from "./candidates.ts";
import {
  canonicaliseUrl,
  declaredSitemaps,
  fetchText,
} from "../extract/page.ts";

/**
 * Programme URLs read straight out of a site's own sitemap.
 *
 * WHY THIS EXISTS. Every other path into the database is a link somebody had to
 * put on a page we happened to fetch. That caps discovery at the site's
 * navigation: Edinburgh publishes 467 programme-shaped links on one page and we
 * classify twenty of them, and any award that is not linked from the first few
 * listing pages is invisible no matter how large the budget is.
 *
 * A sitemap is the site telling us its complete inventory, in a machine-readable
 * form, at one fetch. It is the only source here that does not depend on how a
 * site chose to arrange its menus — which is exactly why it finds the pages
 * crawling misses.
 *
 * WHAT IT DOES NOT DO. It does not decide anything. Every URL it returns goes
 * through `scoreCandidate`, the prefilter and the classifier like any other
 * candidate, and discovery still cannot write dates. A sitemap is a source of
 * addresses, not a source of facts.
 *
 * Deliberately dependency-free, matching `htmlToText`: sitemaps are a flat
 * `<url><loc>` list and a regex reads them exactly as well as a parser would,
 * without the supply chain.
 */

/** Where a site keeps its sitemap when robots.txt does not say. */
const CONVENTIONAL_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/wp-sitemap.xml",
];

export interface SitemapOptions {
  /** Sitemap documents fetched per seed, including index files. */
  maxDocuments?: number;
  /** Programme-shaped URLs returned per seed. */
  maxUrls?: number;
  /** Minimum `scoreCandidate` for a URL to be worth classifying. */
  minScore?: number;
  /** Called with progress lines so the caller owns the logging. */
  onProgress?: (line: string) => void;
}

/**
 * `<loc>` values out of a sitemap or sitemap index.
 *
 * Both document types use the same element, which is convenient: whether a
 * `<loc>` is a page or another sitemap is decided by the wrapper, so that is
 * what gets checked.
 */
function locations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((match) => match[1]!)
    // Sitemaps are XML, so ampersands in query strings arrive escaped.
    .map((url) => url.replace(/&amp;/g, "&"));
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

/**
 * Gzipped sitemaps are skipped rather than decompressed.
 *
 * Not because it is hard — `node:zlib` would do it — but because a site that
 * gzips its sitemap almost always publishes a plain one too, and the ones that
 * do not are large enough that we would be discarding most of what we fetched.
 */
const SKIP = /\.gz$/i;

export async function discoverFromSitemap(
  seedUrl: string,
  options: SitemapOptions = {},
): Promise<string[]> {
  const maxDocuments = options.maxDocuments ?? 6;
  const maxUrls = options.maxUrls ?? 150;
  const minScore = options.minScore ?? 14;
  const say = options.onProgress ?? (() => {});

  let origin: string;
  let host: string;
  let protocol: string;
  let seedPath: string;
  try {
    const parsed = new URL(seedUrl);
    origin = parsed.origin;
    host = parsed.host;
    protocol = parsed.protocol;
    seedPath = parsed.pathname;
  } catch {
    return [];
  }

  // What the site says first, then the conventional spellings. Declared
  // sitemaps are more likely to be current, and on a big site they are often
  // already split by section.
  const declared = await declaredSitemaps(seedUrl);
  const conventional = CONVENTIONAL_PATHS.map((path) => `${origin}${path}`);
  const queue = [...declared, ...conventional].filter((url) => !SKIP.test(url));
  const isConventional = new Set(conventional);

  const seen = new Set<string>();
  const found = new Map<string, number>();
  /** Sitemap bodies already read, so the same document under two names is not
   *  paid for twice — `/sitemap.xml` and `/wp-sitemap.xml` are routinely the
   *  same file, and on a big site that is half the document budget. */
  const bodies = new Set<string>();
  let fetched = 0;

  while (queue.length > 0 && fetched < maxDocuments) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);

    // One conventional path having worked means the rest are guesses at a file
    // we have already found.
    if (fetched > 0 && isConventional.has(url)) continue;

    let xml: string;
    try {
      xml = await fetchText(url);
    } catch {
      // Most origins have no sitemap at most of these paths. That is the
      // expected case, not an error worth reporting.
      continue;
    }
    if (!/<(urlset|sitemapindex)\b/i.test(xml)) continue;

    // Same document, different name. Hash on length plus a slice rather than a
    // full digest: these are megabytes, and two files that agree on both are
    // the same sitemap for every purpose here.
    const fingerprint = `${xml.length}:${xml.slice(0, 400)}`;
    if (bodies.has(fingerprint)) continue;
    bodies.add(fingerprint);

    fetched++;
    const locs = locations(xml);

    if (isSitemapIndex(xml)) {
      // Prefer child sitemaps whose own name suggests the section we want; a
      // university's sitemap index can list fifty of them and we can afford a
      // handful.
      const ranked = locs
        .filter((loc) => !SKIP.test(loc) && !seen.has(loc))
        .sort(
          (a, b) =>
            Number(/scholar|fund|award|fellow|bursar|grant|study|admission/i.test(b)) -
            Number(/scholar|fund|award|fellow|bursar|grant|study|admission/i.test(a)),
        );
      queue.push(...ranked);
      say(`    sitemap index ${url}: ${locs.length} child sitemap(s)`);
      continue;
    }

    let kept = 0;
    for (const loc of locs) {
      let candidate: string;
      try {
        const parsed = new URL(loc);
        // Compare HOSTS, not origins, and re-stamp the seed's protocol.
        // Sitemaps routinely still declare http:// on sites that have long
        // since moved to https, and an origin comparison silently rejected
        // every URL of them — Edinburgh's 6,907-URL sitemap yielded zero.
        if (parsed.host !== host) continue;
        parsed.protocol = protocol;
        candidate = canonicaliseUrl(parsed);
      } catch {
        continue;
      }

      const score = scoreCandidate("", candidate);
      if (score < minScore) continue;

      // A sitemap has no anchor text, so the path is the only signal there is
      // and the threshold has to carry the whole judgement. Bias toward the
      // section the seed itself points at: a scholarship URL under the seed's
      // own subtree is far likelier to be in scope than one elsewhere on a
      // university's estate.
      const inSeedSection = seedPath.length > 1 && candidate.includes(seedPath);
      const existing = found.get(candidate) ?? 0;
      found.set(candidate, Math.max(existing, score + (inSeedSection ? 6 : 0)));
      kept++;
    }

    say(`    sitemap ${url}: ${locs.length} url(s) → ${kept} programme-shaped`);
  }

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxUrls)
    .map(([url]) => url);
}
