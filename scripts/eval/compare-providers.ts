/**
 * ScholarTrack :: provider comparison
 *
 *   npm run eval:providers -- --plan                 # list programmes and models; call nothing
 *   npm run eval:providers                           # 5 programmes × gemini, haiku, sonnet
 *   npm run eval:providers -- --limit 4
 *   npm run eval:providers -- --ids <uuid>,<uuid>    # specific programmes
 *   npm run eval:providers -- --providers haiku,sonnet
 *   npm run eval:providers -- --max-cost 3           # stop before spending more (USD, default 5)
 *   npm run eval:providers -- --gemini-price 0.1,0.4 # Gemini USD per 1M tokens in,out (default 0: free tier)
 *   npm run eval:providers -- --verbose              # stream the pipeline's own log
 *
 * For each provider it reports how many values the model extracted, how many
 * survived the quote check, the tokens it used and what that cost.
 *
 * READ-ONLY. The real pipeline runs end to end (crawl, the cycle and profile
 * calls, gap fill, the quote check), but the store handed to it keeps rows in
 * memory, so nothing is staged, re-pointed or written to Supabase. Programmes
 * are read with the anon key, which the RLS policy already lets anyone use.
 *
 * Each provider runs alone, with no escalation, so every token and every value
 * belongs to the model named in the report. Pages are cached across providers
 * for one programme, so all of them read the same crawl.
 *
 * Needs in .env.local: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY;
 * GEMINI_API_KEY for gemini; Anthropic credentials (ANTHROPIC_API_KEY) for haiku
 * and sonnet. Results are also written to scripts/eval/results/ as JSON.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { clearPageCache } from "../extract/page.ts";
import {
  extractProgramme,
  type ExtractionStore,
  type ProgrammeTarget,
  type StagedExtraction,
} from "../extract/programme.ts";
import type { ExtractionProvider } from "../extract/providers/index.ts";
import { AnthropicProvider } from "../extract/providers/anthropic.ts";
import { GeminiProvider } from "../extract/providers/gemini.ts";
import {
  ANTHROPIC_PRICES,
  callCost,
  classifyDiscards,
  countKeptValues,
  int,
  pct,
  summarise,
  table,
  usd,
  type Price,
  type RunMetrics,
} from "./metrics.ts";

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing ${name}. Add it to .env.local — see .env.example.\n`);
    process.exit(1);
  }
  return value;
}

const plan = flag("plan");
const verbose = flag("verbose");
const limit = Number(option("limit") ?? 5);
const ids = option("ids")?.split(",").map((id) => id.trim()).filter(Boolean);
const maxCost = Number(option("max-cost") ?? 5);
const maxPages = Number(option("pages") ?? 20);
const wanted = (option("providers") ?? "gemini,haiku,sonnet").split(",").map((p) => p.trim());

const [geminiIn = 0, geminiOut = 0] = (option("gemini-price") ?? "0,0").split(",").map(Number);
const geminiPrice: Price = { input: geminiIn, output: geminiOut };

/* -------------------------------------------------------------------------- */
/* Contenders                                                                 */
/* -------------------------------------------------------------------------- */

interface Contender {
  key: string;
  build: () => ExtractionProvider;
  price: Price;
  /** Said once in the report, next to the numbers it qualifies. */
  note?: string;
}

const CONTENDERS: Record<string, Contender> = {
  gemini: {
    key: "gemini",
    build: () => new GeminiProvider(requireEnv("GEMINI_API_KEY")),
    price: geminiPrice,
    note:
      geminiIn === 0 && geminiOut === 0
        ? "Gemini priced at $0 (free tier); pass --gemini-price in,out for paid rates. " +
          "Its provider records candidate tokens only, so thinking tokens (if the model thinks) are not counted."
        : "Gemini's provider records candidate tokens only, so thinking tokens (if the model thinks) are not counted.",
  },
  haiku: {
    key: "haiku",
    build: () => new AnthropicProvider("claude-haiku-5-5"),
    price: ANTHROPIC_PRICES["claude-haiku-5-5"]!,
  },
  sonnet: {
    key: "sonnet",
    build: () => new AnthropicProvider("claude-sonnet-5-5"),
    price: ANTHROPIC_PRICES["claude-sonnet-5-5"]!,
  },
};

const unknown = wanted.filter((key) => !CONTENDERS[key]);
if (unknown.length > 0) {
  console.error(`Unknown provider(s): ${unknown.join(", ")}. Choose from ${Object.keys(CONTENDERS).join(", ")}.`);
  process.exit(1);
}
const contenders = wanted.map((key) => CONTENDERS[key]!);

/* -------------------------------------------------------------------------- */
/* Programmes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which programmes to read. Explicit `--ids` win; otherwise one per country in
 * turn, so a five-programme sample is not five pages from the same funder.
 */
async function loadTargets(): Promise<ProgrammeTarget[]> {
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } },
  );
  let query = supabase
    .from("scholarships")
    .select("id, title, country, source_url, official_portal_url")
    .not("official_portal_url", "is", null);
  if (ids) query = query.in("id", ids);

  const { data, error } = await query.order("country").order("title");
  if (error) throw new Error(`Reading scholarships failed: ${error.message}`);
  const rows = (data ?? []) as ProgrammeTarget[];
  if (ids) return rows;

  const byCountry = new Map<string, ProgrammeTarget[]>();
  for (const row of rows) byCountry.set(row.country, [...(byCountry.get(row.country) ?? []), row]);
  const picked: ProgrammeTarget[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    const before = picked.length;
    for (const group of byCountry.values()) {
      if (picked.length < limit && group[round]) picked.push(group[round]!);
    }
    if (picked.length === before) break;
  }
  return picked;
}

/** Rows the pipeline would have staged, kept here instead of in Supabase. */
function memoryStore(): ExtractionStore & { rows: StagedExtraction[] } {
  const rows: StagedExtraction[] = [];
  return {
    rows,
    async stage(row) {
      rows.push(row);
    },
    async repoint() {
      // Never written: this run is read-only.
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const targets = await loadTargets();
  if (targets.length === 0) {
    console.error("No programmes matched.");
    process.exit(1);
  }

  console.log(`\nProgrammes (${targets.length}):`);
  for (const t of targets) console.log(`  ${t.id}  ${t.country.padEnd(14)} ${t.title}`);
  console.log(`\nProviders: ${contenders.map((c) => c.key).join(", ")}  ·  cost cap ${usd(maxCost)}  ·  ${maxPages} pages per crawl`);

  if (plan) {
    console.log("\n--plan: nothing was crawled and no model was called.\n");
    return;
  }

  const providers = new Map(contenders.map((c) => [c.key, c.build()]));
  const runs: RunMetrics[] = [];
  const logs: Record<string, string[]> = {};
  let spent = 0;
  let stoppedEarly = false;

  outer: for (const target of targets) {
    for (const contender of contenders) {
      if (spent >= maxCost) {
        stoppedEarly = true;
        break outer;
      }
      const provider = providers.get(contender.key)!;
      const label = `${provider.name}/${provider.model}`;
      const store = memoryStore();
      const lines: string[] = [];
      const calls: Array<{ input: number; output: number }> = [];
      const started = Date.now();
      let ok = true;
      let error: string | null = null;

      console.log(`\n▸ ${target.title} — ${label}`);
      try {
        const result = await extractProgramme({
          target,
          provider,
          fallback: null,
          store,
          say: (line) => {
            lines.push(line);
            if (verbose) console.log(line);
          },
          record: (_name, input, output) => calls.push({ input, output }),
          maxPages,
          force: true,
          fixUrls: false,
        });
        if (result.failed || store.rows.length === 0) {
          ok = false;
          error = result.failed ? "pipeline reported failure (see log)" : "nothing staged";
        }
      } catch (failure) {
        ok = false;
        error = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
      }

      const row = store.rows[0];
      const cost = calls.reduce((sum, call) => sum + callCost(contender.price, call.input, call.output), 0);
      spent += cost;
      const metrics: RunMetrics = {
        provider: label,
        programme: target.title,
        ok,
        error,
        calls: calls.length,
        inputTokens: calls.reduce((sum, call) => sum + call.input, 0),
        outputTokens: calls.reduce((sum, call) => sum + call.output, 0),
        cost,
        kept: row ? countKeptValues(row.proposed) : 0,
        discarded: classifyDiscards(row?.ungrounded_fields ?? []),
        seconds: Math.round((Date.now() - started) / 1000),
      };
      runs.push(metrics);
      logs[`${target.id} ${label}`] = lines;

      const extracted = metrics.kept + metrics.discarded.quoteNotFound + metrics.discarded.otherCheck;
      console.log(
        ok
          ? `  ${metrics.kept}/${extracted} values kept · ${metrics.calls} calls · ${usd(cost)} · ${metrics.seconds}s`
          : `  ✗ ${error}`,
      );
    }
    clearPageCache();
  }

  /* ------------------------------------------------------------------ report */

  const summary = summarise(runs);
  console.log("\n\nPer provider\n");
  console.log(
    table([
      ["provider", "programmes", "failed", "extracted", "kept", "quote not found", "other check", "kept %", "calls", "input tok", "output tok", "cost"],
      ...summary.map((s) => [
        s.provider, String(s.runs), String(s.failed), String(s.extracted), String(s.kept),
        String(s.quoteNotFound), String(s.otherCheck), pct(s.keepRate), String(s.calls),
        int(s.inputTokens), int(s.outputTokens), usd(s.cost),
      ]),
    ]),
  );

  console.log("\nPer programme\n");
  console.log(
    table([
      ["programme", "provider", "kept", "discarded", "calls", "cost", "time"],
      ...runs.map((r) => [
        r.programme.slice(0, 40), r.provider,
        r.ok ? String(r.kept) : "✗",
        r.ok ? String(r.discarded.quoteNotFound + r.discarded.otherCheck) : "",
        String(r.calls), usd(r.cost), `${r.seconds}s`,
      ]),
    ]),
  );

  for (const c of contenders) if (c.note) console.log(`\nNote: ${c.note}`);
  console.log(
    "\n'extracted' = values the model proposed; 'kept' = values in the staged proposal after the quote check;" +
      "\n'quote not found' = the model's quote is on no fetched page; 'other check' = quote found, value failed another check.",
  );
  if (stoppedEarly) console.log(`\nStopped early: the ${usd(maxCost)} cost cap was reached.`);
  console.log(`\nTotal spent: ${usd(spent)}`);

  const dir = new URL("./results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`providers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, dir);
  writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), maxPages, targets, summary, runs, logs }, null, 2));
  console.log(`Results: ${file.pathname}\n`);
}

main().catch((failure) => {
  console.error(failure);
  process.exit(1);
});
