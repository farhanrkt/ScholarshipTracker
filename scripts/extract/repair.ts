import { titleTokens } from "./crawl.ts";
import { fetchPage, HttpError } from "./page.ts";
import { discoverFromSitemap } from "../discover/sitemap.ts";

/**
 * Finding a live page again after the stored one dies.
 *
 * WHY THIS IS NOT AN EDGE CASE. Funders reorganise their sites constantly —
 * a programme moves from `/scholarships/x/` to `/study/funding/x/`, a site
 * migrates from `/en/` to no prefix, a CMS starts appending trailing slashes.
 * The URL in our row keeps pointing at where the page WAS, so extraction fails
 * with `HTTP 404`, the row is reported as "fix these by hand", and it stays
 * broken until somebody does. Meanwhile the programme itself is fine and its
 * new page is two segments away.
 *
 * A 404 is therefore the one crawl failure that carries information: it says
 * the URL is wrong, which is a thing this pipeline can act on. A 403 says the
 * opposite — the URL is probably right and we were turned away — so it is not
 * repaired, only reported. (`fetchWithRetry` already gives a 403 a second go
 * with browser-shaped headers before it reaches here.)
 *
 * WHAT THIS DOES NOT DO. It does not decide that the page it found is the right
 * programme. It proposes an address; the extraction that follows reads it, and
 * `page_is_about_requested_programme` is what actually judges it. Only after
 * that judgement passes does the caller write the new URL to the row — so the
 * worst case of a bad guess is a wasted crawl, never a row silently re-pointed
 * at somebody else's scholarship.
 */

export interface RepairCandidate {
  url: string;
  /** How this address was arrived at, for the run log. */
  why: string;
}

/**
 * Spellings of the SAME address that a server may treat differently.
 *
 * Cheapest first and by a wide margin: no new page has to exist for any of
 * these to work, and a site that redirects `example.org/x` to
 * `www.example.org/x/` will answer one of them immediately.
 */
export function urlVariants(dead: string): RepairCandidate[] {
  let url: URL;
  try {
    url = new URL(dead);
  } catch {
    return [];
  }

  /**
   * De-duplicated on the LITERAL address, not the canonical one.
   *
   * `canonicaliseUrl` folds a trailing slash away, which is correct everywhere
   * else in the pipeline and exactly wrong here: the two spellings are the same
   * page to us and demonstrably different pages to some servers, which is the
   * whole reason this variant exists. Deduping canonically silently dropped the
   * cheapest and highest-yield repair there is.
   */
  const seen = new Set<string>([url.toString()]);
  const out: RepairCandidate[] = [];

  const add = (candidate: URL, why: string) => {
    const key = candidate.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, why });
  };

  // Trailing slash, both directions. A surprising number of CMSs 404 one form
  // and serve the other rather than redirecting between them.
  const slashed = new URL(url.toString());
  slashed.pathname = url.pathname.endsWith("/")
    ? url.pathname.replace(/\/+$/, "")
    : `${url.pathname}/`;
  if (slashed.pathname) add(slashed, "trailing slash");

  // www and its absence.
  const swapped = new URL(url.toString());
  swapped.host = url.host.startsWith("www.")
    ? url.host.slice(4)
    : `www.${url.host}`;
  add(swapped, swapped.host.startsWith("www.") ? "www" : "no www");

  // An explicit index file left over from an older site.
  if (/\/(index|default)\.(html?|php|aspx?)$/i.test(url.pathname)) {
    const stripped = new URL(url.toString());
    stripped.pathname = url.pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, "/");
    add(stripped, "without the index file");
  }

  if (url.protocol === "http:") {
    const secure = new URL(url.toString());
    secure.protocol = "https:";
    add(secure, "https");
  }

  return out;
}

/**
 * Ancestor paths, nearest first, ending at the origin root.
 *
 * When `/scholarships/chevening/how-to-apply` is gone, `/scholarships/chevening`
 * is where the programme most likely lives now, and the origin root always
 * exists on a site that exists at all. Landing on an ancestor is enough: the
 * crawler takes a title hint and scores links, so from the section index it
 * walks back down to the programme by itself.
 */
export function ancestorUrls(dead: string): RepairCandidate[] {
  let url: URL;
  try {
    url = new URL(dead);
  } catch {
    return [];
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const out: RepairCandidate[] = [];

  for (let depth = segments.length - 1; depth >= 0; depth--) {
    const path = segments.slice(0, depth).join("/");
    out.push({
      url: path ? `${url.origin}/${path}/` : `${url.origin}/`,
      why: depth === 0 ? "site root" : `parent section /${path}/`,
    });
  }

  return out;
}

/**
 * How well a URL's path matches the programme's distinctive words.
 *
 * The same token matching the crawler uses to steer, applied to a list of
 * addresses instead of a list of links. It is the only signal available for a
 * sitemap entry, which carries no anchor text at all.
 */
export function scorePathAgainstTitle(url: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;

  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch {
    return 0;
  }
  const haystack = path.replace(/[^a-z0-9]+/g, " ");

  return tokens.filter((token) => haystack.includes(token)).length;
}

export interface RepairOptions {
  /** The programme's name, used to recognise its page in a sitemap. */
  title: string;
  /** Addresses actually requested. Each one is a fetch, so this is the cost. */
  maxProbes?: number;
  /** Progress lines, so the caller owns its own log formatting. */
  say?: (line: string) => void;
  /** Skip the sitemap step. It is one or two extra requests when it runs. */
  useSitemap?: boolean;
}

/** Is this failure the kind a new address could fix? */
export function isDeadLink(error: unknown): boolean {
  return error instanceof HttpError && error.isDeadLink;
}

/**
 * Probes for a live page to crawl in place of one that has gone.
 *
 * Returns the first address that answers with readable HTML, along with how it
 * was found. Order is deliberate — variants, then ancestors, then the sitemap —
 * because it runs cheapest-first and each step is strictly less likely to be
 * the programme's own page than the one before it.
 */
export async function findLiveEntry(
  dead: string,
  options: RepairOptions,
): Promise<RepairCandidate | null> {
  const say = options.say ?? (() => {});
  const maxProbes = options.maxProbes ?? 6;
  const tokens = titleTokens(options.title);

  let probes = 0;

  const probe = async (candidate: RepairCandidate): Promise<RepairCandidate | null> => {
    if (probes >= maxProbes) return null;
    probes++;

    try {
      const page = await fetchPage(candidate.url);
      // Report where we LANDED, not what was asked for: following the redirect
      // is half the point of trying the variants at all.
      return { url: page.url, why: candidate.why };
    } catch {
      return null;
    }
  };

  for (const candidate of [...urlVariants(dead), ...ancestorUrls(dead)]) {
    if (probes >= maxProbes) break;
    const found = await probe(candidate);
    if (found) {
      say(`    ↻ recovered via ${found.why}: ${found.url}`);
      return found;
    }
  }

  if (options.useSitemap === false || probes >= maxProbes) return null;

  // Last resort, and the only step that can find a page at a genuinely new
  // address: ask the site for its own inventory and take the entry whose path
  // names this programme.
  try {
    const urls = await discoverFromSitemap(dead, { maxUrls: 400, maxDocuments: 4 });
    const ranked = urls
      .map((url) => ({ url, hits: scorePathAgainstTitle(url, tokens) }))
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    for (const entry of ranked.slice(0, Math.max(0, maxProbes - probes))) {
      const found = await probe({ url: entry.url, why: "the site's sitemap" });
      if (found) {
        say(`    ↻ recovered via ${found.why}: ${found.url}`);
        return found;
      }
    }
  } catch {
    // No sitemap, or an unreadable one. Nothing more to try.
  }

  return null;
}
