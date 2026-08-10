/**
 * ScholarTrack :: AI-assisted extraction
 *
 *   npm run extract -- --dry-run              # crawl + extract, write nothing
 *   npm run extract                            # stage proposals for review
 *   npm run extract -- --limit 3               # first three only
 *   npm run extract -- --title Chevening       # one programme by title match
 *   npm run extract -- --pages 20              # bigger crawl per programme
 *   npm run extract -- --dates-only            # skip the profile call
 *   npm run extract -- --concurrency 5         # programmes crawled at once
 *   npm run extract -- --force                 # ignore "pending" and "unchanged" skips
 *   npm run extract -- --provider anthropic    # force a provider
 *   npm run extract -- --escalate              # retry empties on the other provider
 *   npm run extract -- --verify                # cross-check dates against other sources
 *   npm run extract -- --no-gap-fill           # skip the second look at empty fields
 *   npm run extract -- --no-fix-urls           # never rewrite a row's dead URL
 *   npm run extract -- --models                # list models your Groq key can reach
 *
 * TWO CALLS PER PROGRAMME. The crawl is shared; the extraction is not. Call one
 * reads the application cycle, call two reads what the award covers, who may
 * apply, and what they must submit. Splitting them is what makes the deep
 * fields affordable: one response carrying all of it, each value with its own
 * verbatim quote, overruns the output ceiling of the free-tier providers — and
 * a truncated response loses the dates as well.
 *
 * Nothing this script writes is visible in the app. Proposals land in
 * `scholarship_extractions` and reach `scholarships` only when a human applies
 * them — in the review UI or via `select apply_extraction('<id>')`.
 */

import { createClient } from "@supabase/supabase-js";

import { pageCacheStats } from "./page.ts";
import {
  extractProgramme,
  type ExtractionStore,
  type ProgrammeTarget,
} from "./programme.ts";
import type { Authority } from "../discover/authority.ts";
import {
  DailyLimitError,
  listGeminiModels,
  listGroqModels,
  pickFallbackProvider,
  pickProvider,
} from "./providers/index.ts";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const dryRun = flag("dry-run");
const limit = Number(option("limit") ?? 50);
const titleFilter = option("title");
/**
 * Pages crawled per programme.
 *
 * Twenty rather than sixteen: the crawl now runs several requests deep, so the
 * extra four pages cost about as much wall-clock as none of them used to, and
 * the topics that were starved at sixteen — documents and benefits, which are
 * spread thinnest across a site — are exactly what the extra budget reaches.
 */
const maxPages = Number(option("pages") ?? 20);
/**
 * Rewrite a row's URL when the stored one is dead and a live page is found.
 *
 * On by default because leaving it off means the row fails identically on every
 * future run: a 404 does not heal, and "fix these by hand" was a list nobody
 * was ever going to work through. The write only happens after an extraction
 * has confirmed the new page is about this programme, and never in a dry run.
 */
const fixUrls = !flag("no-fix-urls");
const escalate = flag("escalate");
const datesOnly = flag("dates-only");
const force = flag("force");
/**
 * Cross-check the cycle dates against other sites describing the same
 * programme. Off by default: each extra source is a crawl plus a model call,
 * and a run is already minutes per programme on a fifteen-per-minute tier.
 */
const verify = flag("verify");
const maxVerifySources = Number(option("verify-sources") ?? 2);
/**
 * The second look at whatever the profile call left empty.
 *
 * On by default. It is one extra model call against a crawl that has already
 * been fetched and paid for, and it is the difference between a row carrying a
 * deadline and three coverage lines and a row a student can actually plan
 * against. Turn it off with --no-gap-fill when the run is only about dates or
 * when a provider quota is the binding constraint.
 */
const gapFill = !flag("no-gap-fill");

/**
 * Programmes extracted at once.
 *
 * Three is deliberate rather than "as many as possible": the model providers
 * are the real bottleneck and their limiters are shared, so more lanes mostly
 * queue behind each other while making the logs harder to follow. Crawling is
 * where the wall-clock time goes, and three lanes overlap that nicely.
 */
const concurrency = Math.min(Math.max(Number(option("concurrency") ?? 3), 1), 8);

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing ${name}. Add it to .env.local — see .env.example.\n`);
    process.exit(1);
  }
  return value;
}

// The service-role key bypasses RLS, which is what lets this script write to
// the deny-all staging table. It must never carry a NEXT_PUBLIC_ prefix and
// must never be imported by anything under src/.
function supabaseAdmin() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/** What the query selects, which is exactly what an extraction needs. */
type Target = ProgrammeTarget;

interface Outcome {
  staged: boolean;
  failed: boolean;
  skipped: boolean;
  /** Buffered so a programme's output prints as one block, not interleaved. */
  lines: string[];
}

/**
 * Runs `worker` over `items`, `size` at a time, stopping early if it aborts.
 *
 * Concurrency here is safe because politeness lives in the fetch layer: a host
 * is never hit faster than its gap allows however many crawls are in flight,
 * and the provider clients hold their own shared rate limiters. What is NOT
 * safe is interleaved logging, so each worker buffers its lines and prints them
 * as a block when it finishes.
 */
async function runPool<T>(
  items: T[],
  size: number,
  worker: (item: T, index: number) => Promise<Outcome>,
  onDone: (outcome: Outcome, item: T, index: number) => void,
): Promise<{ aborted: Error | null }> {
  let cursor = 0;
  let aborted: Error | null = null;

  const lane = async () => {
    for (;;) {
      if (aborted) return;
      const index = cursor++;
      if (index >= items.length) return;

      const item = items[index]!;
      try {
        onDone(await worker(item, index), item, index);
      } catch (error) {
        // A day-scale quota is not recoverable within this run. Stop every lane
        // so the rows already staged get reported rather than every remaining
        // programme failing the same way.
        if (error instanceof DailyLimitError) {
          aborted ??= error;
          return;
        }
        onDone(
          {
            staged: false,
            failed: true,
            skipped: false,
            lines: [`    ✗ ${error instanceof Error ? error.message : String(error)}`],
          },
          item,
          index,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, size) }, lane));
  return { aborted };
}

async function main() {
  if (flag("models")) {
    const gemini = process.env.GEMINI_API_KEY;
    const groq = process.env.GROQ_API_KEY;
    if (gemini) {
      console.log("\nGemini:");
      console.log((await listGeminiModels(gemini)).map((m) => `  ${m}`).join("\n"));
    }
    if (groq) {
      console.log("\nGroq:");
      console.log((await listGroqModels(groq)).map((m) => `  ${m}`).join("\n"));
    }
    if (!gemini && !groq) console.error("No GEMINI_API_KEY or GROQ_API_KEY set.");
    return;
  }

  const provider = pickProvider(option("provider"));
  const fallback = escalate ? pickFallbackProvider(provider) : null;
  const supabase = supabaseAdmin();

  let query = supabase
    .from("scholarships")
    .select("id, title, country, source_url, official_portal_url")
    .neq("verification_status", "verified") // never overwrite human-checked rows
    // Never-checked rows first, then the longest-neglected. Without an ORDER BY
    // the LIMIT took an arbitrary slice, so repeated runs could chew the same
    // rows forever and never reach the tail of the table.
    .order("last_verified_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (titleFilter) query = query.ilike("title", `%${titleFilter}%`);

  const { data, error } = await query;
  if (error) throw new Error(`Could not load scholarships: ${error.message}`);

  let targets = (data ?? []) as Target[];
  if (targets.length === 0) {
    console.log("Nothing to extract — every matching row is already verified.");
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* What is already waiting, and what has not changed                       */
  /* ---------------------------------------------------------------------- */

  // Re-running used to stage a SECOND proposal for a row that already had one
  // pending, so the review queue filled with duplicates of the same programme
  // and a reviewer had to work out which was newer.
  const { data: pendingRows } = await supabase
    .from("scholarship_extractions")
    .select("scholarship_id")
    .eq("status", "pending");

  const pending = new Set((pendingRows ?? []).map((row) => row.scholarship_id));

  // The newest proposal per row, so an unchanged page can skip the model calls
  // entirely. `page_sha256` has been stored since the first migration for
  // exactly this and was never read.
  const { data: historyRows } = await supabase
    .from("scholarship_extractions")
    .select("scholarship_id, source_url, page_sha256, created_at")
    .order("created_at", { ascending: false });

  /**
   * Other sites describing these programmes, recorded by discovery from what it
   * used to discard as duplicates. Loaded once rather than per programme: it is
   * one small table and the alternative is a query inside every lane.
   */
  const sourcesByScholarship = new Map<string, Array<{ url: string; authority: Authority }>>();
  if (verify) {
    const { data: sourceRows, error: sourcesError } = await supabase
      .from("scholarship_sources")
      .select("scholarship_id, url, authority")
      .eq("muted", false);

    // Say so rather than quietly doing nothing. A --verify run that silently
    // skips verification looks exactly like one where every source agreed.
    if (sourcesError) {
      console.log(
        `--verify was requested but scholarship_sources is unavailable (${sourcesError.message}).\n` +
          `Apply supabase/migrations/011_cross_verification.sql, then run discovery to collect sources.\n`,
      );
    }

    for (const row of sourceRows ?? []) {
      const list = sourcesByScholarship.get(row.scholarship_id) ?? [];
      list.push({ url: row.url, authority: row.authority });
      sourcesByScholarship.set(row.scholarship_id, list);
    }
  }

  const lastSeen = new Map<string, { source_url: string; page_sha256: string }>();
  for (const row of historyRows ?? []) {
    if (!lastSeen.has(row.scholarship_id)) {
      lastSeen.set(row.scholarship_id, {
        source_url: row.source_url,
        page_sha256: row.page_sha256,
      });
    }
  }

  if (!force) {
    const before = targets.length;
    targets = targets.filter((target) => !pending.has(target.id));
    const held = before - targets.length;
    if (held > 0) {
      console.log(
        `${held} programme(s) skipped — a proposal is already waiting in review. Use --force to re-extract anyway.`,
      );
    }
  }

  if (targets.length === 0) {
    console.log("Nothing to extract — every matching row already has a proposal pending.");
    return;
  }

  console.log(
    `\n${targets.length} programme(s) · ${provider.name}/${provider.model}` +
      (fallback ? ` → escalates to ${fallback.name}/${fallback.model}` : "") +
      (concurrency > 1 ? ` · ${concurrency} at a time` : "") +
      (datesOnly ? " · dates only" : "") +
      (force ? " · FORCED" : "") +
      (dryRun ? " · DRY RUN" : "") +
      "\n",
  );

  let staged = 0;
  let failed = 0;
  let skipped = 0;
  /** Rows whose URL was dead and has been re-pointed at a live page. */
  let repaired = 0;
  /** Rows whose stored URLs are all dead — a data problem no re-run will fix. */
  const unreachable: Array<{ target: Target; status?: number }> = [];
  const usage = new Map<string, { input: number; output: number }>();

  const record = (name: string, input: number, output: number) => {
    const current = usage.get(name) ?? { input: 0, output: 0 };
    usage.set(name, {
      input: current.input + input,
      output: current.output + output,
    });
  };

  /**
   * The two writes an extraction makes, done with the service-role client.
   *
   * The deployed runner implements this same interface against a client bound
   * to the signed-in admin, which is how the pipeline reaches Vercel without
   * the service-role key going with it.
   */
  const store: ExtractionStore = {
    async stage(row) {
      const { error } = await supabase.from("scholarship_extractions").insert(row);
      if (error) throw new Error(`Insert failed: ${error.message}`);
    },
    async repoint(scholarshipId, url) {
      const { error } = await supabase
        .from("scholarships")
        .update({ official_portal_url: url, source_url: null })
        .eq("id", scholarshipId);
      if (error) throw new Error(error.message);
    },
  };

  const processTarget = async (target: Target): Promise<Outcome> => {
    const lines: string[] = [];

    const result = await extractProgramme({
      target,
      provider,
      fallback,
      store,
      say: (line) => lines.push(line),
      record,
      maxPages,
      datesOnly,
      force,
      dryRun,
      fixUrls,
      verify,
      maxVerifySources,
      gapFill,
      previous: lastSeen.get(target.id) ?? null,
      sources: sourcesByScholarship.get(target.id) ?? [],
    });

    if (result.repaired) repaired++;
    if (result.unreachable) {
      unreachable.push({ target, status: result.unreachable.status });
    }

    return {
      staged: result.staged,
      failed: result.failed,
      skipped: result.skipped,
      lines,
    };
  };

  const { aborted } = await runPool(
    targets,
    concurrency,
    processTarget,
    (outcome, target, index) => {
      if (outcome.staged) staged++;
      if (outcome.failed) failed++;
      if (outcome.skipped) skipped++;
      console.log(`[${index + 1}/${targets.length}] ${target.title}`);
      for (const line of outcome.lines) console.log(line);
    },
  );

  const cache = pageCacheStats();
  console.log(
    `\n${staged} staged · ${failed} failed` +
      (repaired > 0 ? ` · ${repaired} URL(s) repaired` : "") +
      (skipped > 0 ? ` · ${skipped} unchanged` : "") +
      // Programmes on one site share almost every page, so on a multi-row
      // funder this is the difference between one crawl and one crawl per row.
      (cache.hits > 0
        ? ` · ${cache.hits} of ${cache.hits + cache.misses} page request(s) served from cache`
        : ""),
  );
  for (const [name, tokens] of usage) {
    const cost =
      name === "anthropic"
        ? ` · ~$${((tokens.input / 1e6) * 5 + (tokens.output / 1e6) * 25).toFixed(3)}`
        : " · free tier";
    console.log(
      `  ${name}: ${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out${cost}`,
    );
  }

  // Called out separately because it is the one failure a re-run cannot help
  // with: every URL on the row is dead and automatic repair found nothing, so
  // someone has to find a live one. The status is printed because it says which
  // kind of problem this is — 404 means the address is wrong, 403 means the
  // address is probably right and the host is refusing us, and those two want
  // completely different fixes.
  if (unreachable.length > 0) {
    console.log(`\n${unreachable.length} row(s) have no reachable URL — fix these by hand:`);
    for (const { target, status } of unreachable) {
      console.log(`  ${target.title}${status ? `  [HTTP ${status}]` : ""}`);
      console.log(`    ${target.official_portal_url}`);
      if (target.source_url && target.source_url !== target.official_portal_url) {
        console.log(`    ${target.source_url}`);
      }
    }
  }

  if (staged > 0 && !dryRun) {
    console.log(`\nReview at /admin/review, or:`);
    console.log(`  select * from extraction_review;`);
    console.log(`  select apply_extraction('<extraction_id>');\n`);
  }

  // Reported last, after the tally, so the rows that did make it are visible
  // rather than buried above a stack trace.
  if (aborted) {
    console.error(`\nStopped early: ${aborted.message}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
