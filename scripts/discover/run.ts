/**
 * ScholarTrack :: discovery
 *
 *   npm run discover -- --dry-run           # crawl + classify, write nothing
 *   npm run discover -- --seed Chevening    # one seed by label match
 *   npm run discover -- --per-seed 15       # programme pages classified per seed
 *   npm run discover -- --max-listing 12    # listing/pagination pages per seed
 *   npm run discover -- --min medium        # keep only medium/high confidence
 *   npm run discover -- --no-sitemap        # skip the sitemap harvest
 *   npm run discover -- --sitemap-urls 300  # sitemap URLs taken per seed
 *   npm run discover -- --seed-concurrency 4  # seeds crawled at once
 *
 * Finds programmes we do not have rows for yet. It never writes dates: a
 * promoted candidate becomes a dateless, unverified skeleton, and the
 * extraction pipeline fills it in afterwards.
 *
 * TWO LEVELS, NOT ONE. A seed is expanded into its pagination and its
 * sub-listings first, and only then are the programme-shaped links classified.
 * The previous version read each seed exactly once, which meant page 2 of every
 * portal — and every "PhD scholarships A–Z" sub-index — was invisible. That,
 * not the classifier, was the ceiling on how many programmes a run could find.
 *
 * Review at /admin/candidates, or:
 *   select promote_candidate('<candidate_id>');
 */

import { createClient } from "@supabase/supabase-js";

import { SEEDS } from "./seeds.ts";
import {
  buildKnowledge,
  discoverSeed,
  type Confidence,
  type DiscoveryStore,
} from "./seed-crawl.ts";
import { DailyLimitError, pickProvider } from "../extract/providers/index.ts";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

const argv = process.argv;
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const dryRun = flag("dry-run");
const seedFilter = option("seed");
const perSeed = Number(option("per-seed") ?? 20);
const maxListings = Number(option("max-listing") ?? 8);
const minConfidence = (option("min") ?? "low") as Confidence;
/** Sitemaps are on by default — they are the cheapest volume there is. */
const useSitemap = !flag("no-sitemap");
const sitemapUrls = Number(option("sitemap-urls") ?? 150);
/**
 * Seeds crawled at once.
 *
 * Three, matching the extraction runner, and for the same reason: the fetch
 * layer spaces requests per host, so lanes on different hosts genuinely
 * overlap, while the model provider's rate limiter keeps the classification
 * calls inside one shared per-minute budget however many lanes there are.
 */
const seedConcurrency = Number(option("seed-concurrency") ?? 3);

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing ${name}. Add it to .env.local — see .env.example.\n`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const provider = pickProvider(option("provider"));
  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const seeds = seedFilter
    ? SEEDS.filter((seed) =>
        seed.label.toLowerCase().includes(seedFilter.toLowerCase()),
      )
    : SEEDS;

  if (seeds.length === 0) {
    console.log(`No seed matches "${seedFilter}".`);
    return;
  }

  // Everything we already know about, so we never queue a duplicate.
  const [{ data: existing }, { data: queued }] = await Promise.all([
    supabase.from("scholarships").select("id, title, official_portal_url, source_url"),
    supabase.from("scholarship_candidates").select("url, programme_name"),
  ]);

  const knowledge = buildKnowledge({
    scholarships: existing ?? [],
    candidates: queued ?? [],
  });

  console.log(
    `\n${seeds.length} seed(s) · ${provider.name}/${provider.model} · ${knowledge.urls.size} known URL(s)` +
      (seeds.length > 1 && seedConcurrency > 1 ? ` · ${seedConcurrency} at a time` : "") +
      (dryRun ? " · DRY RUN" : "") +
      "\n",
  );

  let staged = 0;
  let rejected = 0;
  let duplicates = 0;
  let prefiltered = 0;
  let listingsFollowed = 0;
  let sitemapFound = 0;
  let sourcesRecorded = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  /**
   * One seed, start to finish, with its output buffered.
   *
   * Buffered because seeds now run several at a time and interleaved logs are
   * unreadable: a line saying `+ Chevening Scholarships` has to appear under
   * the seed that found it, not wherever it landed in time. Each seed's lines
   * are printed as one block when it finishes, which is how the extraction
   * runner has always done it.
   */
  /**
   * The two writes discovery makes, done with the service-role client.
   *
   * The deployed runner implements the same interface against the signed-in
   * admin's session, which is how discovery runs on Vercel without the
   * service-role key going with it.
   */
  const store: DiscoveryStore = {
    async stageCandidate(row) {
      const { error } = await supabase.from("scholarship_candidates").insert(row);
      return error ? { error: error.message } : {};
    },
    async recordSource(row) {
      const { error } = await supabase
        .from("scholarship_sources")
        .upsert(row, { onConflict: "scholarship_id,url", ignoreDuplicates: true });
      return error ? { error: error.message } : {};
    },
  };

  /**
   * One seed, start to finish, with its output buffered.
   *
   * Buffered because seeds run several at a time and interleaved logs are
   * unreadable: a line saying `+ Chevening Scholarships` has to appear under
   * the seed that found it, not wherever it landed in time.
   */
  const processSeed = async (seed: (typeof SEEDS)[number]): Promise<string[]> => {
    const lines: string[] = [];

    const result = await discoverSeed({
      seed,
      provider,
      knowledge,
      store,
      say: (line) => lines.push(line),
      options: {
        perSeed,
        maxListings,
        minConfidence,
        useSitemap,
        sitemapUrls,
        dryRun,
      },
    });

    staged += result.staged;
    rejected += result.rejected;
    duplicates += result.duplicates;
    prefiltered += result.prefiltered;
    listingsFollowed += result.listingsFollowed;
    sitemapFound += result.sitemapFound;
    sourcesRecorded += result.sourcesRecorded;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    return lines;
  };

  /**
   * Seeds, several at a time.
   *
   * Safe for the same reason the extraction runner's pool is: politeness lives
   * in the fetch layer, which spaces requests PER HOST, and seeds are different
   * hosts. Two lanes on the same host queue behind each other exactly as one
   * lane would. The model provider holds its own rate limiter, shared across
   * lanes, so the classification calls stay inside the same per-minute budget
   * they always did — they simply stop waiting on each other's page fetches.
   *
   * This is the single biggest lever on discovery's wall-clock: a run was
   * strictly one request at a time across the whole seed list, so twenty-three
   * seeds cost the sum of twenty-three crawls, most of it spent waiting.
   */
  const lanes = Math.min(Math.max(seedConcurrency, 1), 8);
  let cursor = 0;
  let stopped: unknown = null;

  const lane = async () => {
    for (;;) {
      if (stopped) return;
      const seed = seeds[cursor++];
      if (!seed) return;

      try {
        for (const line of await processSeed(seed)) console.log(line);
      } catch (error) {
        // A day-scale quota is not recoverable within this run. Stop the other
        // lanes so what is already staged gets reported.
        if (error instanceof DailyLimitError) {
          stopped ??= error;
          return;
        }
        console.log(`\n=== ${seed.label}`);
        console.log(`    ✗ ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, lane));

  console.log(
    `\n${staged} new candidate(s) · ${listingsFollowed} extra listing page(s) followed` +
      (useSitemap ? ` · ${sitemapFound} found via sitemap` : "") +
      (sourcesRecorded > 0 ? ` · ${sourcesRecorded} second source(s) recorded` : "") +
      ` · ${prefiltered} filtered without a model call · ${rejected} classified as not programmes · ${duplicates} already known`,
  );
  console.log(
    `${provider.name}: ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out` +
      (provider.name === "groq" ? " · free tier" : ""),
  );
  if (staged > 0 && !dryRun) {
    console.log(`\nReview at /admin/candidates\n`);
  }

  // Reported after the tally, so the candidates that did make it are visible
  // rather than buried above a stack trace.
  if (stopped) {
    console.error(
      `\nStopped early: ${stopped instanceof Error ? stopped.message : String(stopped)}\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
