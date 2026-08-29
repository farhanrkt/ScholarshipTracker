/**
 * Reading the pages that "yield nothing".
 *
 * A JavaScript-rendered page has been a total loss: `fetchPage` counts the
 * characters, finds a shell, and throws. Every field on that programme is blank
 * and no amount of prompt or retrieval work can touch it, because nothing was
 * ever fetched. It is the largest single category of blank in the catalogue and
 * the one furthest from being the funder's fault.
 *
 * THE THING THAT MAKES THIS CHEAP. Most "JavaScript-rendered" pages are not.
 * A React or Vue site built with any of the mainstream frameworks ships its
 * content INSIDE the initial HTML as a JSON payload, so the client can hydrate
 * without a second round trip — `__NEXT_DATA__`, `window.__NUXT__`,
 * `self.__next_f`, an inline Apollo or Redux cache. The text is right there in
 * the bytes we already downloaded. It is only invisible because the extractor
 * throws away `<script>` and then measures what is left.
 *
 * So the ladder runs cheapest-first, and a headless browser is the last rung
 * rather than the first:
 *
 *   1. embedded hydration payloads — free, no extra request, no dependency
 *   2. `<noscript>` — what the site itself serves to a client without JS
 *   3. the AMP copy the page links to — one extra request, static by definition
 *   4. an external render service, if one is configured
 *
 * WHAT DOES NOT CHANGE is grounding. Recovered text becomes the page's text and
 * is searched for quotes exactly like prose. A value read out of a hydration
 * payload has to be quotable from that payload, which it is, because that is
 * where the site put it.
 */

/**
 * Strings from a payload that are worth treating as page text.
 *
 * A hydration blob is mostly identifiers, class names, image paths and feature
 * flags. Prose is what we are after, and it has a shape: long enough to say
 * something, containing spaces, and not a URL or an encoded blob.
 */
function looksLikeProse(value: string): boolean {
  if (value.length < 30 || value.length > 5_000) return false;
  if (!value.includes(" ")) return false;
  if (/^(https?:|data:|\/|[A-Za-z0-9+/]{60,}={0,2}$)/.test(value)) return false;
  // Minified code and CSS arrive as long "sentences" full of punctuation.
  const letters = value.replace(/[^a-z]/gi, "").length;
  if (letters / value.length < 0.55) return false;
  // A run of camelCase identifiers separated by spaces is a class list.
  if (/^(?:[a-z]+[A-Z][a-zA-Z]* ){3,}/.test(value)) return false;
  return true;
}

/** Every prose-shaped string in a parsed payload, in document order. */
function collectStrings(node: unknown, out: string[], depth = 0): void {
  if (depth > 12 || out.length > 4_000) return;

  if (typeof node === "string") {
    if (looksLikeProse(node)) out.push(node.trim());
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out, depth + 1);
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectStrings(value, out, depth + 1);
  }
}

/**
 * Balanced JSON starting at `start`, or null.
 *
 * The payloads are embedded in JavaScript, so there is no closing tag to search
 * for and a greedy match to the last `}` on the page swallows unrelated script.
 * Counting braces while respecting string literals is what finds the actual end
 * of the object.
 */
function balancedJson(source: string, start: number): string | null {
  if (source[start] !== "{" && source[start] !== "[") return null;

  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index++) {
    const char = source[index]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

/** Payload markers, in the order they are worth trying. */
const PAYLOAD_MARKERS = [
  // Next.js pages router — a script tag with a plain JSON body.
  /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>\s*/i,
  // Nuxt, Gatsby, Redux and Apollo all assign an object to a global.
  /window\.__NUXT__\s*=\s*/,
  /window\.__INITIAL_STATE__\s*=\s*/,
  /window\.__APOLLO_STATE__\s*=\s*/,
  /window\.__PRELOADED_STATE__\s*=\s*/,
  /window\.__staticRouterHydrationData\s*=\s*/,
];

function fromGlobals(html: string): string[] {
  const found: string[] = [];

  for (const marker of PAYLOAD_MARKERS) {
    const match = marker.exec(html);
    if (!match) continue;

    const json = balancedJson(html, match.index + match[0].length);
    if (!json) continue;

    try {
      collectStrings(JSON.parse(json), found);
    } catch {
      // A payload that is JavaScript rather than JSON (trailing functions,
      // `undefined`) is not worth a parser of our own.
    }
  }

  return found;
}

/**
 * The Next.js App Router streaming format.
 *
 * Content arrives as `self.__next_f.push([1,"…escaped chunk…"])`, one call per
 * flight chunk, and the chunks concatenate into a payload that is only
 * partially JSON. Rather than reconstruct it, the string literals are unescaped
 * and read directly — the prose filter does the rest of the work, and this
 * format carries the page's visible copy verbatim.
 */
const NEXT_FLIGHT = /self\.__next_f\.push\(\[\d+\s*,\s*("(?:[^"\\]|\\.)*")\]\)/g;

function fromFlight(html: string): string[] {
  const found: string[] = [];

  for (const match of html.matchAll(NEXT_FLIGHT)) {
    let chunk: string;
    try {
      chunk = JSON.parse(match[1]!) as string;
    } catch {
      continue;
    }

    // The chunk is flight protocol, not JSON. Its embedded strings are what we
    // want, and they are ordinary JSON string literals inside it.
    for (const literal of chunk.matchAll(/"((?:[^"\\]|\\.){30,5000})"/g)) {
      let text: string;
      try {
        text = JSON.parse(`"${literal[1]}"`) as string;
      } catch {
        continue;
      }
      if (looksLikeProse(text)) found.push(text.trim());
    }
  }

  return found;
}

const NOSCRIPT = /<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi;

/**
 * What the site serves to a client without JavaScript.
 *
 * Often a "please enable JavaScript" notice and nothing else — the prose filter
 * and the caller's length check both handle that — but news and university
 * sites routinely put the whole article in here for search engines.
 */
function fromNoscript(html: string, toText: (html: string) => string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(NOSCRIPT)) {
    const text = toText(match[1] ?? "").trim();
    if (text.length >= 200) found.push(text);
  }
  return found;
}

/**
 * Text recovered from a page whose visible markup came back empty.
 *
 * Deduplicated and joined as lines. Returns "" when there is nothing, which the
 * caller treats exactly as it treated a short page before this existed.
 */
export function hydrateText(
  html: string,
  toText: (html: string) => string,
): string {
  const candidates = [
    ...fromGlobals(html),
    ...fromFlight(html),
    ...fromNoscript(html, toText),
  ];

  const seen = new Set<string>();
  const lines: string[] = [];
  let used = 0;

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    // A payload can carry the same page twice — server state and client cache.
    seen.add(candidate);
    lines.push(candidate);
    used += candidate.length;
    if (used > 200_000) break;
  }

  return lines.join("\n\n");
}

/** The AMP copy of this page, which is static markup by definition. */
export function amphtmlUrl(html: string, baseUrl: string): string | null {
  const match =
    /<link\b[^>]*\brel\s*=\s*["']amphtml["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(
      html,
    ) ??
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']amphtml["']/i.exec(
      html,
    );

  if (!match?.[1]) return null;

  try {
    const resolved = new URL(match[1], baseUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* External renderer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A headless browser, if the operator has provided one.
 *
 * NOT A DEPENDENCY, deliberately. Bundling Playwright would put a browser
 * download into every install of a project whose whole point is that it costs
 * nothing to run, and would not deploy to the serverless host the pipeline now
 * runs on. The contract instead is a URL that accepts `{ "url": … }` and
 * returns `{ "html": … }` — which browserless, a three-line Playwright worker,
 * or any of the hosted equivalents already satisfy.
 *
 * Configured or not, the ladder above runs first: a page recoverable from its
 * own hydration payload never costs a render.
 */
export function renderServiceUrl(): string | null {
  const configured = process.env.RENDER_SERVICE_URL?.trim();
  return configured ? configured : null;
}

const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 30_000;

/** Rendered HTML for a URL, or null when no service is configured or it fails. */
export async function renderPage(url: string): Promise<string | null> {
  const service = renderServiceUrl();
  if (!service) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);

  try {
    const response = await fetch(service, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.RENDER_SERVICE_TOKEN
          ? { authorization: `Bearer ${process.env.RENDER_SERVICE_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as { html?: unknown; content?: unknown };
      const html = body.html ?? body.content;
      return typeof html === "string" && html.length > 0 ? html : null;
    }

    // A service that just returns the HTML is a perfectly good service.
    const text = await response.text();
    return text.length > 0 ? text : null;
  } catch {
    // A renderer is an optimisation. Its failure must read as "not rendered",
    // never as a crawl error, or configuring one would make the pipeline more
    // fragile than leaving it off.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
