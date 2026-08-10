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
import type { SEEDS } from "./seeds.ts";
import { discoverFromSitemap } from "./sitemap.ts";
import { extractLinks, fetchPage, type FetchedPage } from "../extract/page.ts";
import { DailyLimitError, type ExtractionProvider } from "../extract/providers/index.ts";
import type { Authority } from "./authority.ts";
// One definition of "the same programme", shared with the merge page. A second
// implementation here would drift, and the drift would show up as rows the
// dashboard has and the duplicates page cannot see.
import { compareProgrammes } from "../../src/lib/duplicates.ts";

/**
 * One seed, crawled and classified, with nowhere it insists on running.
 *
 * The counterpart of `extract/programme.ts`, and lifted out for the same
 * reason: this logic lived inside `run.ts`'s main(), closed over a service-role
 * client and a dozen counters, so the deployed app could not reach it. Writes
 * go through `DiscoveryStore` and output through `say`, so the CLI and a Route
 * Handler can both drive it with their own credentials and their own idea of
 * where a log line goes.
 */

export type Seed = (typeof SEEDS)[number];

/** Links worth expanding a rejected page for. Below this it is not a list. */
const LISTING_LINK_THRESHOLD = 5;

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;
export type Confidence = keyof typeof CONFIDENCE_RANK;

export interface StagedCandidate {
  url: string;
  found_via: string;
  fetched_at: string;
  model: string;
  programme_name: string;
  funder: string | null;
  host_country: string | null;
  degree_levels: string[];
  is_fully_funded: boolean | null;
  open_to_international: boolean | null;
  confidence: string;
  summary: string | null;
}

export interface StagedSource {
  scholarship_id: string;
  url: string;
  authority: Authority;
  found_via: string;
  discovered_at: string;
}

/**
 * The two writes discovery makes.
 *
 * Both return a reason rather than throwing when the database says no, because
 * neither failure should stop a seed: a duplicate candidate means another run
 * got there first, and a missing `scholarship_sources` table means migration
 * 011 has not been applied — worth saying once, not worth abandoning the crawl.
 */
export interface DiscoveryStore {
  stageCandidate(row: StagedCandidate): Promise<{ error?: string }>;
  recordSource(row: StagedSource): Promise<{ error?: string }>;
}

/**
 * What the run already knows about, shared across seeds and MUTATED as they go.
 *
 * Deliberately shared: two seeds routinely list the same programme, and the
 * second one should recognise it as known rather than queue a duplicate. Sets
 * are safe here because JavaScript runs one lane at a time — the awaits are
 * where other seeds get to move, and nothing observes these between a read and
 * its write.
 */
export interface DiscoveryKnowledge {
  urls: Set<string>;
  titles: Set<string>;
  rowByTitle: Map<string, { id: string; portalUrl: string }>;
  /**
   * Every known programme with an address, for near-match dedupe.
   *
   * `titles` answers "have we seen this exact name?" and nothing else, which is
   * how the catalogue ended up holding `Chevening Scholarship` beside
   * `Chevening Scholarships`, and three separate Humphrey rows. Matching also
   * needs the URL, because a name only means the same programme when it is on
   * the same site.
   */
  rows: Array<{ id: string; title: string; portalUrl: string }>;
}

/**
 * Does a newly classified page describe something we already have?
 *
 * Exact title first — unchanged, and still what most matches are. Then the same
 * comparison the merge page uses, so "already known" means one thing across the
 * app rather than two that drift apart.
 *
 * Only `certain` and `likely` count. `possible` is a prompt for a human on the
 * duplicates page, and acting on it here would silently discard real
 * programmes: nothing records what discovery declines to stage, so a wrong drop
 * is invisible and permanent.
 */
export function matchKnownProgramme(
  knowledge: DiscoveryKnowledge,
  programmeName: string,
  pageUrl: string,
): {
  row: { id: string; portalUrl: string } | null;
  reason: string;
} | null {
  const fingerprint = titleFingerprint(programmeName);

  if (knowledge.titles.has(fingerprint)) {
    return {
      row: knowledge.rowByTitle.get(fingerprint) ?? null,
      reason: "same title",
    };
  }

  for (const row of knowledge.rows) {
    const verdict = compareProgrammes(
      { title: programmeName, url: pageUrl },
      { title: row.title, url: row.portalUrl },
    );
    if (!verdict || verdict.confidence === "possible") continue;

    return {
      row: { id: row.id, portalUrl: row.portalUrl },
      reason: `${verdict.confidence} match for "${row.title}"`,
    };
  }

  return null;
}

export interface SeedOptions {
  perSeed?: number;
  maxListings?: number;
  minConfidence?: Confidence;
  useSitemap?: boolean;
  sitemapUrls?: number;
  dryRun?: boolean;
}

export interface SeedResult {
  staged: number;
  rejected: number;
  duplicates: number;
  prefiltered: number;
  listingsFollowed: number;
  sitemapFound: number;
  sourcesRecorded: number;
  inputTokens: number;
  outputTokens: number;
  /** Set once when second sources cannot be written at all. */
  sourcesUnavailable: string | null;
}

interface PoolItem {
  url: string;
  label: string;
  score: number;
}

// Plural-insensitive: see titleFingerprint. Exact matching is what let
// "Chevening Scholarship" and "Chevening Scholarships" both through as two rows.
export const normaliseTitle = titleFingerprint;

export function normaliseUrl(value: string): string {
  return value.replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/, "");
}

/**
 * Everything the run already knows about, from the two tables that hold it.
 *
 * Built once and shared by every seed. The `rowByTitle` half is what lets a
 * "duplicate" be recorded as a SECOND SOURCE rather than dropped: finding
 * Chevening described on a university's site is not a de-duplication failure,
 * it is the cross-verification input arriving for free.
 */
export function buildKnowledge(input: {
  scholarships: Array<{
    id: string;
    title: string;
    official_portal_url: string | null;
    source_url: string | null;
  }>;
  candidates: Array<{ url: string; programme_name: string }>;
}): DiscoveryKnowledge {
  const knowledge: DiscoveryKnowledge = {
    urls: new Set<string>(),
    titles: new Set<string>(),
    rowByTitle: new Map(),
    rows: [],
  };

  for (const row of input.scholarships) {
    knowledge.titles.add(normaliseTitle(row.title));
    if (row.official_portal_url) {
      knowledge.rowByTitle.set(normaliseTitle(row.title), {
        id: row.id,
        portalUrl: row.official_portal_url,
      });
      knowledge.rows.push({
        id: row.id,
        title: row.title,
        portalUrl: row.official_portal_url,
      });
      knowledge.urls.add(normaliseUrl(row.official_portal_url));
    }
    if (row.source_url) knowledge.urls.add(normaliseUrl(row.source_url));
  }

  for (const row of input.candidates) {
    knowledge.urls.add(normaliseUrl(row.url));
    knowledge.titles.add(normaliseTitle(row.programme_name));
  }

  return knowledge;
}

export async function discoverSeed(options: {
  seed: Seed;
  provider: ExtractionProvider;
  knowledge: DiscoveryKnowledge;
  store: DiscoveryStore;
  say: (line: string) => void;
  options?: SeedOptions;
}): Promise<SeedResult> {
  const { seed, provider, knowledge, store, say } = options;
  const perSeed = options.options?.perSeed ?? 20;
  const maxListings = options.options?.maxListings ?? 8;
  const minConfidence = options.options?.minConfidence ?? "low";
  const useSitemap = options.options?.useSitemap ?? true;
  const sitemapUrls = options.options?.sitemapUrls ?? 150;
  const dryRun = options.options?.dryRun ?? false;

  const result: SeedResult = {
    staged: 0,
    rejected: 0,
    duplicates: 0,
    prefiltered: 0,
    listingsFollowed: 0,
    sitemapFound: 0,
    sourcesRecorded: 0,
    inputTokens: 0,
    outputTokens: 0,
    sourcesUnavailable: null,
  };

  say(`\n=== ${seed.label} — ${seed.url}`);

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

  /* -------------------------------------------------------------------- */
  /* Level 1: the seed, its pagination, and anything that paginates it     */
  /* -------------------------------------------------------------------- */

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
        say(`    ✗ seed unreachable: ${message}`);
        say(`      Fix or remove this entry in scripts/discover/seeds.ts`);
        break;
      }
      say(`    · listing skipped ${url}: ${message}`);
      continue;
    }

    listingsFetched++;
    if (!isSeedItself) result.listingsFollowed++;
    readListing(page);
  }

  if (listingsFetched === 0) return result;

  say(`    ${listingsFetched} listing page(s) → ${pool.size} candidate link(s)`);

  /* -------------------------------------------------------------------- */
  /* Level 1b: the site's own sitemap                                      */
  /* -------------------------------------------------------------------- */

  // Everything above this point is limited to what a site links from the pages
  // we happened to fetch. A sitemap is the site listing its own inventory, so it
  // reaches awards that are not linked from any index we can see — which is the
  // ceiling that curating more seeds cannot lift.
  if (useSitemap) {
    const before = pool.size;
    try {
      const urls = await discoverFromSitemap(seed.url, {
        maxUrls: sitemapUrls,
        onProgress: (line) => say(line),
      });

      let added = 0;
      for (const url of urls) {
        const key = normaliseUrl(url);
        if (listingSeen.has(key) || pool.has(key)) continue;
        // No anchor text exists in a sitemap; scoreCandidate already judged the
        // path, and its score is recomputed here for the shared ranking.
        pool.set(key, { url, label: "", score: scoreCandidate("", url) });
        added++;
      }

      result.sitemapFound += added;
      if (added > 0) {
        say(
          `    ⤷ sitemap: +${added} candidate(s) not linked from any listing (${before} → ${pool.size})`,
        );
      }
    } catch (error) {
      say(`    · sitemap unavailable: ${error instanceof Error ? error.message : error}`);
    }
  }

  /* -------------------------------------------------------------------- */
  /* Level 2: classify the programme-shaped links                          */
  /* -------------------------------------------------------------------- */

  const ranked = [...pool.values()].sort((a, b) => b.score - a.score);

  /**
   * Expand a page we have already fetched into more candidates.
   *
   * Free in fetches — the page is in hand — which is what makes it worth doing
   * on a maybe rather than a certainty.
   */
  const expand = (page: FetchedPage, why: string) => {
    const key = normaliseUrl(page.url);
    if (listingsFetched >= maxListings || listingSeen.has(key)) return;

    listingSeen.add(key);
    listingsFetched++;
    result.listingsFollowed++;

    const before = pool.size;
    const links = extractLinks(page, { sameOriginOnly });
    addCandidates(links);
    for (const nextUrl of findPaginationLinks(page, links)) {
      if (!listingSeen.has(normaliseUrl(nextUrl))) deferredListings.push(nextUrl);
    }

    const added = pool.size - before;
    say(`    ⤷ ${why}: +${added} candidate(s) from ${page.url}`);

    if (added > 0) {
      const present = new Set(ranked.map((item) => normaliseUrl(item.url)));
      for (const item of pool.values()) {
        if (!present.has(normaliseUrl(item.url))) ranked.push(item);
      }
      ranked.sort((a, b) => b.score - a.score);
    }
  };

  // Pages that are not programmes still cost a fetch, so the loop needs its own
  // ceiling — `perSeed` only counts the ones that reach the model.
  let fetchBudget = perSeed * 2 + maxListings;
  let classified = 0;

  /**
   * Start fetching the next candidates before this one is classified.
   *
   * The loop below alternates one fetch with one model call, and each waits for
   * the other to finish — so a run spends its time strictly adding a page's
   * latency to a classification's, over and over. `fetchPage` caches the
   * in-flight promise, so warming the next two addresses means their bytes
   * arrive while the model is reading the current page.
   */
  const warmNext = (count: number) => {
    for (const item of ranked.slice(0, count)) {
      const key = normaliseUrl(item.url);
      if (knowledge.urls.has(key) || listingSeen.has(key)) continue;
      void fetchPage(item.url).catch(() => {
        // Failures are handled where the page is actually needed.
      });
    }
  };

  while (ranked.length > 0 && classified < perSeed && fetchBudget > 0) {
    const candidate = ranked.shift()!;
    const key = normaliseUrl(candidate.url);

    if (knowledge.urls.has(key)) {
      result.duplicates++;
      continue;
    }
    if (listingSeen.has(key)) continue;

    fetchBudget--;
    warmNext(2);

    try {
      const page = await fetchPage(candidate.url);

      // Cheap rejection first: no model call for something a few string checks
      // can rule out.
      const verdict = prefilterPage(page.text);
      if (verdict.kind === "listing") {
        expand(page, "sub-listing");
        continue;
      }
      if (!verdict.keep) {
        result.prefiltered++;
        continue;
      }

      classified++;
      const classification = await classifyPage(provider, page.url, page.text);
      result.inputTokens += classification.inputTokens;
      result.outputTokens += classification.outputTokens;

      const { classification: found } = classification;

      if (!found.is_scholarship_programme || !found.programme_name) {
        result.rejected++;
        // The prefilter can miss a listing the model recognises as one. We are
        // holding the page either way — check before dropping it.
        const links = extractLinks(page, { sameOriginOnly });
        if (countProgrammeLinks(links) >= LISTING_LINK_THRESHOLD) {
          expand(page, "not a programme, but links to many");
        }
        continue;
      }
      if (CONFIDENCE_RANK[found.confidence] < CONFIDENCE_RANK[minConfidence]) {
        result.rejected++;
        continue;
      }
      const sourceUrl = canonicalUrl(page);
      const known = matchKnownProgramme(knowledge, found.programme_name, sourceUrl);

      if (known) {
        result.duplicates++;
        if (known.reason !== "same title") {
          // Worth saying out loud: this is the branch that used to stage a
          // second row, and a wrong drop here leaves no record anywhere.
          say(`    = ${found.programme_name} — ${known.reason}, not staged`);
        }

        // Not a wasted fetch: this is another site describing a programme we
        // track, which is the input cross-verification needs and the reason this
        // pipeline needs no search engine to get one.
        const row = known.row;

        if (row && !dryRun && !sameOrganisation(sourceUrl, row.portalUrl)) {
          const authority = classifyAuthority(sourceUrl, { funderUrl: row.portalUrl });

          const { error } = await store.recordSource({
            scholarship_id: row.id,
            url: sourceUrl,
            authority,
            found_via: seed.label,
            discovered_at: new Date().toISOString(),
          });

          if (error) {
            // Once per run: the table is either there or it is not, and one line
            // per candidate would bury the actual findings.
            if (!result.sourcesUnavailable) {
              result.sourcesUnavailable = error;
              say(
                `    ! cannot record second sources (${error}).` +
                  ` Apply supabase/migrations/011_cross_verification.sql.`,
              );
            }
          } else {
            result.sourcesRecorded++;
            say(`    ↳ second source for ${found.programme_name} (${authority})`);
          }
        }
        continue;
      }

      const hostCountry = normaliseCountry(found.host_country) ?? seed.country ?? null;

      say(`    + ${found.programme_name} (${hostCountry ?? "?"}, ${found.confidence})`);

      knowledge.urls.add(normaliseUrl(canonicalUrl(page)));
      knowledge.titles.add(normaliseTitle(found.programme_name));

      if (dryRun) {
        result.staged++;
        continue;
      }

      const { error } = await store.stageCandidate({
        // What the page says it is, so trailing-slash and tracking variants of
        // one page cannot queue as two candidates.
        url: canonicalUrl(page),
        found_via: seed.label,
        fetched_at: page.fetchedAt,
        model: `${provider.name}/${classification.model}`,
        programme_name: found.programme_name,
        funder: found.funder,
        host_country: hostCountry,
        degree_levels: found.degree_levels,
        is_fully_funded: found.is_fully_funded,
        open_to_international: found.open_to_international,
        confidence: found.confidence,
        summary: found.summary,
      });

      // A unique violation just means another run got there first.
      if (error && !error.includes("duplicate key")) {
        say(`    ✗ insert failed: ${error}`);
        continue;
      }
      result.staged++;
    } catch (error) {
      // A day-scale quota is not recoverable within this run; stop cleanly so
      // the candidates already staged are reported rather than lost.
      if (error instanceof DailyLimitError) throw error;
      say(
        `    · skipped ${candidate.url}: ${error instanceof Error ? error.message : error}`,
      );
    }

    // A pager found on a sub-listing is another page of programmes; take it as
    // soon as the classification loop pauses for breath.
    while (deferredListings.length > 0 && listingsFetched < maxListings) {
      const url = deferredListings.shift()!;
      if (listingSeen.has(normaliseUrl(url))) continue;
      listingSeen.add(normaliseUrl(url));

      try {
        const page = await fetchPage(url);
        listingsFetched++;
        result.listingsFollowed++;
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

  return result;
}
