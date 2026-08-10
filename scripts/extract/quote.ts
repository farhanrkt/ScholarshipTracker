import { normalise } from "./page.ts";

/**
 * Finding a model's quote in the pages we actually fetched.
 *
 * Grounding asks one question — is this text on the page? — and until now
 * answered it with a substring search. That is the right question and it was
 * the wrong search, because it rejects for reasons that have nothing to do with
 * whether the model read the page:
 *
 *   page:  "Applications close on 6 October 2026.\n· Interviews follow in
 *           November"
 *   quote: "Applications close on 6 October 2026. Interviews follow in November"
 *
 * The model stitched across a bullet. The fact is real, the value is right, the
 * quote is on the page in every sense a human would recognise — and a substring
 * search says no, so the deadline is discarded and the row stays empty. The
 * same thing happens when the page writes "the award covers return airfare" and
 * the quote drops a "the", or when a table cell arrives with a stray tab.
 *
 * So there are two matchers, tried in order:
 *
 *   EXACT   the old substring search, unchanged, and still what almost every
 *           quote hits.
 *   LOOSE   a sliding window over the page's word tokens that accepts a window
 *           containing at least 85% of the quote's tokens AND every number the
 *           quote states. Word order is not enforced; density is. A hallucinated
 *           quote fails this as comprehensively as it failed the substring
 *           search, because its words are not on the page in any order.
 *
 * WHAT MAKES THIS SAFE RATHER THAN A LOOSENING. The match returns the SPAN OF
 * PAGE TEXT it matched, and every downstream check — does the quote state the
 * day, does it contain this stipend figure, does it name IELTS — runs against
 * that span instead of against the model's quote. Previously those checks ran
 * against the quote and trusted the substring search to have tied it to a page.
 * Now the page text is what is examined directly, so a loose match cannot
 * smuggle a number the page never printed: the number has to be inside the
 * window, and the window is page text.
 */

export interface Token {
  text: string;
  start: number;
  end: number;
}

export interface QuotePage {
  url: string;
  /** Normalised page text. Both matchers search exactly this. */
  text: string;
  /** Tokenised on the first loose match against this page, then reused. */
  tokens?: Token[];
}

export interface QuoteMatch {
  url: string;
  /**
   * The page text backing the claim — the quote itself when the match was
   * exact, the matched window when it was loose. Support checks use THIS.
   */
  text: string;
  exact: boolean;
}

/**
 * Very short quotes match by accident on almost any page. "2026" is not
 * evidence of anything, so it is not accepted as evidence of anything.
 */
const MIN_QUOTE_CHARS = 8;

/**
 * Loose matching needs enough tokens for 85% to mean something. At five tokens
 * the threshold rounds to "one word may differ", which on a nav-heavy page is
 * a coincidence rather than a match. Short quotes get the exact search only.
 */
const MIN_LOOSE_TOKENS = 6;

/** Share of the quote's tokens the window must contain. */
const MIN_OVERLAP = 0.85;

/** Words and numbers. Punctuation, currency symbols and markup fall out. */
const TOKEN = /[a-z]+|\d+(?:[.,]\d+)*/g;

export function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

const isNumeric = (token: string) => /\d/.test(token);

/**
 * The tightest window of page text carrying this quote's tokens, or null.
 *
 * The window is deliberately WIDER than the quote — a quote that dropped a
 * word matches a stretch of page containing that word, so a same-width window
 * could never hold all of it — and then trimmed back to the first and last
 * token that actually matched. The trim is what keeps the returned span honest:
 * without it the span carries whatever the slack happened to overlap, and a
 * stray number in the next sentence could satisfy a check it has no business
 * satisfying.
 */
function looseMatch(page: QuotePage, needle: string[]): string | null {
  const tokens = (page.tokens ??= tokenise(page.text));
  if (tokens.length === 0) return null;

  const need = new Map<string, number>();
  for (const token of needle) need.set(token, (need.get(token) ?? 0) + 1);

  // Every figure the quote states must be inside the window. This is the rule
  // that stops "covers a monthly stipend of GBP 1,347" matching a page that
  // says only "covers a monthly stipend".
  const numbers = [...new Set(needle.filter(isNumeric))];

  const required = Math.ceil(needle.length * MIN_OVERLAP);
  const width = needle.length + Math.max(2, Math.ceil(needle.length * 0.25));

  /** Occurrences of each needed token inside the window. */
  const have = new Map<string, number>();
  /** Occurrences that count toward the overlap, capped per token. */
  let matched = 0;

  const add = (token: string) => {
    const wanted = need.get(token);
    if (wanted === undefined) return;
    const current = have.get(token) ?? 0;
    have.set(token, current + 1);
    if (current < wanted) matched++;
  };

  const drop = (token: string) => {
    const wanted = need.get(token);
    if (wanted === undefined) return;
    const current = have.get(token) ?? 0;
    have.set(token, current - 1);
    if (current <= wanted) matched--;
  };

  /**
   * The BEST window, not the first one over the line.
   *
   * A window sliding onto a sentence qualifies a token or two before it has
   * covered the whole thing, and the first qualifying window therefore ends
   * mid-quote. That truncated span is then what every support check reads, so
   * "up to 3 years for a doctorate" can arrive as "up to 3 years for a" and
   * lose the words that made it worth keeping. Cheap to fix: keep scanning.
   */
  let bestEnd = -1;
  let bestMatched = 0;

  for (const [end, token] of tokens.entries()) {
    add(token.text);
    if (end >= width) drop(tokens[end - width]!.text);

    if (matched < required) continue;
    if (matched <= bestMatched) continue;
    if (!numbers.every((number) => (have.get(number) ?? 0) > 0)) continue;

    bestEnd = end;
    bestMatched = matched;
  }

  if (bestEnd === -1) return null;

  const from = Math.max(0, bestEnd - width + 1);
  let first = -1;
  let last = -1;
  for (let index = from; index <= bestEnd; index++) {
    if (!need.has(tokens[index]!.text)) continue;
    if (first === -1) first = index;
    last = index;
  }
  if (first === -1) return null;

  return page.text.slice(tokens[first]!.start, tokens[last]!.end);
}

/**
 * The first page whose text backs this quote, and what it backs it with.
 *
 * Exact matches are tried across every page before any loose match is
 * attempted, so a quote that is verbatim on page three is never attributed to
 * a near-miss on page one.
 */
export function findQuote(
  pages: QuotePage[],
  quote: string | null,
): QuoteMatch | null {
  if (!quote) return null;

  const needle = normalise(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;

  for (const page of pages) {
    if (page.text.includes(needle)) {
      return { url: page.url, text: needle, exact: true };
    }
  }

  const tokens = tokenise(needle).map((token) => token.text);
  if (tokens.length < MIN_LOOSE_TOKENS) return null;

  for (const page of pages) {
    const span = looseMatch(page, tokens);
    if (span) return { url: page.url, text: span, exact: false };
  }

  return null;
}
