/**
 * The arithmetic behind `compare-providers.ts`, kept free of SDKs and network
 * calls so it can be tested without keys or an install.
 */

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  /** A prompt above this many input tokens bills the whole call at `long`. */
  longAbove?: number;
  long?: { input: number; output: number };
}

/**
 * Anthropic first-party list prices, as published on 2026-10-06. Output tokens
 * include thinking, which the API bills as output and reports in
 * `usage.output_tokens`, so nothing extra is needed to account for it.
 */
export const ANTHROPIC_PRICES: Record<string, Price> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    longAbove: 100_000,
    long: { input: 0.5, output: 2.5 },
  },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

export function callCost(price: Price, inputTokens: number, outputTokens: number): number {
  const rate =
    price.long && price.longAbove !== undefined && inputTokens > price.longAbove
      ? price.long
      : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/** Bookkeeping keys on a staged proposal that are not extracted values. */
const META_KEYS = new Set(["eligibility_silent", "not_stated", "field_sources"]);

/**
 * How many values a staged proposal keeps, after the quote check.
 *
 * A scalar counts once when it is set; a list counts per item (timeline stages,
 * documents, fields of study); an object counts per key (coverage lines,
 * eligibility flags). An eligibility flag present with `null` is still a kept
 * value: by the schema's own definition it means "the pages state no limit",
 * which is a grounded statement, where an absent key means "not read".
 */
export function countKeptValues(proposed: Record<string, unknown>): number {
  let count = 0;
  for (const [key, value] of Object.entries(proposed)) {
    if (META_KEYS.has(key) || value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) count += value.length;
    else if (typeof value === "object") count += Object.keys(value).length;
    else count += 1;
  }
  return count;
}

export interface DiscardCounts {
  /** The model quoted something no fetched page contains. */
  quoteNotFound: number;
  /** The quote exists but the value failed another check (malformed or unstated date, …). */
  otherCheck: number;
}

/** Sorts the pipeline's `ungrounded_fields` reasons into the two kinds that matter here. */
export function classifyDiscards(ungrounded: readonly string[]): DiscardCounts {
  let quoteNotFound = 0;
  for (const reason of ungrounded) if (/quote not found/i.test(reason)) quoteNotFound += 1;
  return { quoteNotFound, otherCheck: ungrounded.length - quoteNotFound };
}

export interface RunMetrics {
  provider: string;
  programme: string;
  ok: boolean;
  error: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  kept: number;
  discarded: DiscardCounts;
  seconds: number;
}

export interface ProviderSummary {
  provider: string;
  runs: number;
  failed: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  extracted: number;
  kept: number;
  quoteNotFound: number;
  otherCheck: number;
  /** kept / extracted, or null when nothing was extracted. */
  keepRate: number | null;
}

/** Rolls per-programme runs up into one line per provider, in first-seen order. */
export function summarise(runs: readonly RunMetrics[]): ProviderSummary[] {
  const byProvider = new Map<string, ProviderSummary>();
  for (const run of runs) {
    const s = byProvider.get(run.provider) ?? {
      provider: run.provider, runs: 0, failed: 0, calls: 0, inputTokens: 0, outputTokens: 0,
      cost: 0, extracted: 0, kept: 0, quoteNotFound: 0, otherCheck: 0, keepRate: null,
    };
    s.runs += 1;
    if (!run.ok) s.failed += 1;
    s.calls += run.calls;
    s.inputTokens += run.inputTokens;
    s.outputTokens += run.outputTokens;
    s.cost += run.cost;
    s.kept += run.kept;
    s.quoteNotFound += run.discarded.quoteNotFound;
    s.otherCheck += run.discarded.otherCheck;
    s.extracted = s.kept + s.quoteNotFound + s.otherCheck;
    s.keepRate = s.extracted > 0 ? s.kept / s.extracted : null;
    byProvider.set(run.provider, s);
  }
  return [...byProvider.values()];
}

/** A plain fixed-width table: the first row is the header. */
export function table(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  const line = (row: ReadonlyArray<string>) =>
    row.map((cell, col) => (col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!))).join("  ");
  return [line(rows[0]!), widths.map((w) => "-".repeat(w)).join("  "), ...rows.slice(1).map(line)].join("\n");
}

export const usd = (n: number): string => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const pct = (n: number | null): string => (n === null ? "—" : `${Math.round(n * 100)}%`);
export const int = (n: number): string => n.toLocaleString("en-US");
