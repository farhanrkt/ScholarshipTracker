import { createHash } from "node:crypto";

const USER_AGENT =
  "ScholarTrackBot/1.0 (scholarship deadline verification; +https://github.com/)";

/** Be a polite client: one page at a time, with a gap between hosts. */
export const FETCH_DELAY_MS = 1_500;

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
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
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

const robotsCache = new Map<string, string[]>();

/**
 * Minimal robots.txt support: collect Disallow rules under `*` and our own
 * agent. Not a full spec implementation — deliberately errs toward respecting
 * more than required. A missing or unreadable robots.txt is treated as allow.
 */
async function disallowedPaths(origin: string): Promise<string[]> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  let rules: string[] = [];
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      let applies = false;
      for (const rawLine of (await response.text()).split("\n")) {
        const line = rawLine.split("#")[0]?.trim() ?? "";
        const [field, ...rest] = line.split(":");
        const key = field?.trim().toLowerCase();
        const value = rest.join(":").trim();

        if (key === "user-agent") {
          applies = value === "*" || USER_AGENT.toLowerCase().startsWith(value.toLowerCase());
        } else if (key === "disallow" && applies && value) {
          rules.push(value);
        }
      }
    }
  } catch {
    rules = [];
  }

  robotsCache.set(origin, rules);
  return rules;
}

export async function isAllowed(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const rules = await disallowedPaths(parsed.origin);
  return !rules.some((rule) => parsed.pathname.startsWith(rule));
}

/* -------------------------------------------------------------------------- */
/* Fetch                                                                      */
/* -------------------------------------------------------------------------- */

export async function fetchPage(url: string): Promise<FetchedPage> {
  if (!(await isAllowed(url))) {
    throw new Error(`robots.txt disallows fetching ${url}`);
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text")) {
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
    url: response.url || url,
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

const SKIP_EXTENSIONS =
  /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|webp|mp4|mp3|ics)$/i;

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
