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

import {
  canonicalUrl,
  countProgrammeLinks,
  findPaginationLinks,
  normaliseCountry,
  scoreCandidate,
  titleFingerprint,
} from "./candidates.ts";
import { classifyAuthority, sameOrganisation } from "./authority.ts";
import { classifyPage } from "./classify.ts";
import { prefilterPage } from "./prefilter.ts";
import { SEEDS } from "./seeds.ts";
import { discoverFromSitemap } from "./sitemap.ts";
import { extractLinks, fetchPage, type FetchedPage } from "../extract/page.ts";
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
const minConfidence = (option("min") ?? "low") as "low" | "medium" | "high";
/** Sitemaps are on by default — they are the cheapest volume there is. */
const useSitemap = !flag("no-sitemap");
const sitemapUrls = Number(option("sitemap-urls") ?? 150);

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

/** Links worth expanding a rejected page for. Below this it is not a list. */
const LISTING_LINK_THRESHOLD = 5;

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

interface PoolItem {
  url: string;
  label: string;
  score: number;
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

  const knownUrls = new Set<string>();
  const knownTitles = new Set<string>();
  /**
   * Fingerprint → the row it belongs to, so a "duplicate" can be recorded as a
   * SECOND SOURCE rather than dropped.
   *
   * Finding Chevening described on a university's site is not a failure to
   * de-duplicate; it is the cross-verification input arriving for free. It was
   * being thrown away only because there was nowhere to put it.
   */
  const rowByTitle = new Map<string, { id: string; portalUrl: string }>();
  // Plural-insensitive: see titleFingerprint. Exact matching is what let
  // "Chevening Scholarship" and "Chevening Scholarships" both through.
  const normaliseTitle = titleFingerprint;
  const normaliseUrl = (value: string) =>
    value.replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/, "");

  for (const row of existing ?? []) {
    knownTitles.add(normaliseTitle(row.title));
    rowByTitle.set(normaliseTitle(row.title), {
      id: row.id,
      portalUrl: row.official_portal_url,
    });
    if (row.official_portal_url) knownUrls.add(normaliseUrl(row.official_portal_url));
    if (row.source_url) knownUrls.add(normaliseUrl(row.source_url));
  }
  for (const row of queued ?? []) {
    knownUrls.add(normaliseUrl(row.url));
    knownTitles.add(normaliseTitle(row.programme_name));
  }

  console.log(
    `\n${seeds.length} seed(s) · ${provider.name}/${provider.model} · ${knownUrls.size} known URL(s)${dryRun ? " · DRY RUN" : ""}\n`,
  );

  let staged = 0;
  let rejected = 0;
  let duplicates = 0;
  let prefiltered = 0;
  let listingsFollowed = 0;
  let sitemapFound = 0;
  let sourcesRecorded = 0;
  let warnedAboutSources = false;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const seed of seeds) {
    console.log(`\n=== ${seed.label} — ${seed.url}`);

    const sameOriginOnly = !seed.followExternal;
    const pool = new Map<string, PoolItem>();
    const listingSeen = new Set<string>();
    let listingsFetched = 0;

    /** Harvest programme-shaped links, keeping the best score seen for each. */
    const addCandidates = (links: ReturnType<typeof extractLinks>) => {
      let added = 0;
      for (const link of links) {
        const score = scoreCandidate(link.label, link.url);
        if (score <= 0) continue;

        const key = normaliseUrl(link.url);
        if (listingSeen.has(key)) continue;

        const current = pool.get(key);
        if (current && current.score >= score) continue;
        if (!current) added++;
        pool.set(key, { url: link.url, label: link.label, score });
      }
      return added;
    };

    /* ---------------------------------------------------------------- */
    /* Level 1: the seed, its pagination, and anything that paginates it */
    /* ---------------------------------------------------------------- */

    const listingQueue: string[] = [seed.url];
    listingSeen.add(normaliseUrl(seed.url));
    /** Pager URLs discovered while classifying; drained back into level 1. */
    const deferredListings: string[] = [];

    const readListing = (page: FetchedPage) => {
      const links = extractLinks(page, { sameOriginOnly });
      addCandidates(links);

      for (const nextUrl of findPaginationLinks(page, links)) {
        const key = normaliseUrl(nextUrl);
        if (listingSeen.has(key)) continue;
        listingSeen.add(key);
        pool.delete(key);
        listingQueue.push(nextUrl);
      }
    };

    while (listingQueue.length > 0 && listingsFetched < maxListings) {
      const url = listingQueue.shift()!;
      const isSeedItself = listingsFetched === 0;

      let page: FetchedPage;
      try {
        page = await fetchPage(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSeedItself) {
          console.log(`    ✗ seed unreachable: ${message}`);
          console.log(`      Fix or remove this entry in scripts/discover/seeds.ts`);
          break;
        }
        console.log(`    · listing skipped ${url}: ${message}`);
        continue;
      }

      listingsFetched++;
      if (!isSeedItself) listingsFollowed++;
      readListing(page);

    }

    if (listingsFetched === 0) continue;

    console.log(
      `    ${listingsFetched} listing page(s) → ${pool.size} candidate link(s)`,
    );

    /* ---------------------------------------------------------------- */
    /* Level 1b: the site's own sitemap                                  */
    /* ---------------------------------------------------------------- */

    // Everything above this point is limited to what a site links from the
    // pages we happened to fetch. A sitemap is the site listing its own
    // inventory, so it reaches awards that are not linked from any index we
    // can see — which is the ceiling that curating more seeds cannot lift.
    if (useSitemap) {
      const before = pool.size;
      try {
        const urls = await discoverFromSitemap(seed.url, {
          maxUrls: sitemapUrls,
          onProgress: (line) => console.log(line),
        });

        let added = 0;
        for (const url of urls) {
          const key = normaliseUrl(url);
          if (listingSeen.has(key) || pool.has(key)) continue;
          // No anchor text exists in a sitemap; scoreCandidate already judged
          // the path, and its score is recomputed here for the shared ranking.
          pool.set(key, { url, label: "", score: scoreCandidate("", url) });
          added++;
        }

        sitemapFound += added;
        if (added > 0) {
          console.log(
            `    ⤷ sitemap: +${added} candidate(s) not linked from any listing (${before} → ${pool.size})`,
          );
        }
      } catch (error) {
        console.log(
          `    · sitemap unavailable: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    /* ---------------------------------------------------------------- */
    /* Level 2: classify the programme-shaped links                      */
    /* ---------------------------------------------------------------- */

    const ranked = [...pool.values()].sort((a, b) => b.score - a.score);

    /**
     * Expand a page we have already fetched into more candidates.
     *
     * Free in fetches — the page is in hand — which is what makes it worth
     * doing on a maybe rather than a certainty.
     */
    const expand = (page: FetchedPage, why: string) => {
      const key = normaliseUrl(page.url);
      if (listingsFetched >= maxListings || listingSeen.has(key)) return;

      listingSeen.add(key);
      listingsFetched++;
      listingsFollowed++;

      const before = pool.size;
      const links = extractLinks(page, { sameOriginOnly });
      addCandidates(links);
      for (const nextUrl of findPaginationLinks(page, links)) {
        if (!listingSeen.has(normaliseUrl(nextUrl))) deferredListings.push(nextUrl);
      }

      const added = pool.size - before;
      console.log(`    ⤷ ${why}: +${added} candidate(s) from ${page.url}`);

      if (added > 0) {
        const present = new Set(ranked.map((item) => normaliseUrl(item.url)));
        for (const item of pool.values()) {
          if (!present.has(normaliseUrl(item.url))) ranked.push(item);
        }
        ranked.sort((a, b) => b.score - a.score);
      }
    };

    // Pages that are not programmes still cost a fetch, so the loop needs its
    // own ceiling — `perSeed` only counts the ones that reach the model.
    let fetchBudget = perSeed * 2 + maxListings;
    let classified = 0;

    while (ranked.length > 0 && classified < perSeed && fetchBudget > 0) {
      const candidate = ranked.shift()!;
      const key = normaliseUrl(candidate.url);

      if (knownUrls.has(key)) {
        duplicates++;
        continue;
      }
      if (listingSeen.has(key)) continue;

      fetchBudget--;

      try {
        const page = await fetchPage(candidate.url);

        // Cheap rejection first: no model call for something a few string
        // checks can rule out.
        const verdict = prefilterPage(page.text);
        if (verdict.kind === "listing") {
          expand(page, "sub-listing");
          continue;
        }
        if (!verdict.keep) {
          prefiltered++;
          continue;
        }

        classified++;
        const result = await classifyPage(provider, page.url, page.text);
        inputTokens += result.inputTokens;
        outputTokens += result.outputTokens;

        const { classification: found } = result;

        if (!found.is_scholarship_programme || !found.programme_name) {
          rejected++;
          // The prefilter can miss a listing the model recognises as one. We
          // are holding the page either way — check before dropping it.
          const links = extractLinks(page, { sameOriginOnly });
          if (countProgrammeLinks(links) >= LISTING_LINK_THRESHOLD) {
            expand(page, "not a programme, but links to many");
          }
          continue;
        }
        if (CONFIDENCE_RANK[found.confidence] < CONFIDENCE_RANK[minConfidence]) {
          rejected++;
          continue;
        }
        if (knownTitles.has(normaliseTitle(found.programme_name))) {
          duplicates++;

          // Not a wasted fetch: this is another site describing a programme we
          // track, which is the input cross-verification needs and the reason
          // this pipeline needs no search engine to get one.
          const row = rowByTitle.get(normaliseTitle(found.programme_name));
          const sourceUrl = canonicalUrl(page);

          if (row && !dryRun && !sameOrganisation(sourceUrl, row.portalUrl)) {
            const authority = classifyAuthority(sourceUrl, {
              funderUrl: row.portalUrl,
            });

            const { error } = await supabase.from("scholarship_sources").upsert(
              {
                scholarship_id: row.id,
                url: sourceUrl,
                authority,
                found_via: seed.label,
                discovered_at: new Date().toISOString(),
              },
              { onConflict: "scholarship_id,url", ignoreDuplicates: true },
            );

            if (error) {
              // Once per run: the table is either there or it is not, and one
              // line per candidate would bury the actual findings.
              if (!warnedAboutSources) {
                warnedAboutSources = true;
                console.log(
                  `    ! cannot record second sources (${error.message}).` +
                    ` Apply supabase/migrations/011_cross_verification.sql.`,
                );
              }
            } else {
              sourcesRecorded++;
              console.log(`    ↳ second source for ${found.programme_name} (${authority})`);
            }
          }
          continue;
        }

        const hostCountry = normaliseCountry(found.host_country) ?? seed.country ?? null;

        console.log(
          `    + ${found.programme_name} (${hostCountry ?? "?"}, ${found.confidence})`,
        );

        knownUrls.add(normaliseUrl(canonicalUrl(page)));
        knownTitles.add(normaliseTitle(found.programme_name));

        if (dryRun) {
          staged++;
          continue;
        }

        const { error } = await supabase.from("scholarship_candidates").insert({
          // What the page says it is, so trailing-slash and tracking variants
          // of one page cannot queue as two candidates.
          url: canonicalUrl(page),
          found_via: seed.label,
          fetched_at: page.fetchedAt,
          model: `${provider.name}/${result.model}`,
          programme_name: found.programme_name,
          funder: found.funder,
          host_country: hostCountry,
          degree_levels: found.degree_levels,
          is_fully_funded: found.is_fully_funded,
          open_to_international: found.open_to_international,
          confidence: found.confidence,
          summary: found.summary,
        });

        // A unique-violation just means another run got there first.
        if (error && !error.message.includes("duplicate key")) {
          console.log(`    ✗ insert failed: ${error.message}`);
          continue;
        }
        staged++;
      } catch (error) {
        // A day-scale quota is not recoverable within this run; stop cleanly so
        // the candidates already staged are reported rather than lost.
        if (error instanceof DailyLimitError) throw error;
        console.log(
          `    · skipped ${candidate.url}: ${error instanceof Error ? error.message : error}`,
        );
      }

      // A pager found on a sub-listing is another page of programmes; take it
      // as soon as the classification loop pauses for breath.
      while (deferredListings.length > 0 && listingsFetched < maxListings) {
        const url = deferredListings.shift()!;
        if (listingSeen.has(normaliseUrl(url))) continue;
        listingSeen.add(normaliseUrl(url));

        try {
          const page = await fetchPage(url);
          listingsFetched++;
          listingsFollowed++;
          const before = pool.size;
          readListing(page);
          if (pool.size > before) {
            const present = new Set(ranked.map((item) => normaliseUrl(item.url)));
            for (const item of pool.values()) {
              if (!present.has(normaliseUrl(item.url))) ranked.push(item);
            }
            ranked.sort((a, b) => b.score - a.score);
          }
        } catch {
          // A dead pager is normal — sites link to pages that 404.
        }
      }
    }
  }

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
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
