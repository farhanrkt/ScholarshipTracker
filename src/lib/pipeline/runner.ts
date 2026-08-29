import type { SupabaseClient } from "@supabase/supabase-js";

import { extractProgramme, type ExtractionStore, type ProgrammeTarget } from "../../../scripts/extract/programme.ts";
import { pageCacheStats } from "../../../scripts/extract/page.ts";
import {
  buildKnowledge,
  discoverSeed,
  type DiscoveryStore,
} from "../../../scripts/discover/seed-crawl.ts";
import { SEEDS } from "../../../scripts/discover/seeds.ts";
import {
  DailyLimitError,
  pickFallbackProvider,
  pickProvider,
} from "../../../scripts/extract/providers/index.ts";
import type { Authority } from "../../../scripts/discover/authority.ts";
// `.ts` because this is now a RUNTIME import, not a type-only one: Node resolves
// the specifier literally, and the extensionless form only worked while the
// whole import was erased at compile time.
import { STALE_AFTER_DAYS, type JobArgs } from "./jobs.ts";

/**
 * The pipeline, running wherever the app runs.
 *
 * THE PROBLEM THIS SOLVES. A crawl takes minutes; a serverless function gets
 * seconds. The old runner dodged that by spawning `node scripts/extract/run.ts`
 * and refusing to start on Vercel at all, which meant the deployed app could
 * look at the data but never gather it.
 *
 * So a run is a ROW, not a process. This module does one TICK of it: claim the
 * job, do as much of the remaining work as fits in a time budget, write the
 * progress and the log back, and return. Whoever is watching calls it again.
 * The browser can close, the function can be recycled, the app can redeploy —
 * the run picks up from the cursor, because the cursor is in Postgres.
 *
 * WHAT IT DOES NOT DO is reimplement the crawlers. `extractProgramme` and
 * `discoverSeed` are the same functions the CLI calls, so a fix lands on both
 * hosts at once and there is no second pipeline to keep in sync.
 *
 * SERVER ONLY, without the `server-only` import: that package is a bundler
 * alias, and importing it makes this module unloadable in plain Node — which is
 * where its tests run. The guarantee is structural anyway. This reaches
 * `node:crypto` through the fetch layer, so a browser bundle containing it
 * would fail to build rather than ship.
 */

/**
 * How long a tick works before saving and returning.
 *
 * Comfortably under the route's `maxDuration` of 300s, because the budget is
 * only checked BETWEEN units: a unit that starts at 3:50 still gets to finish,
 * and being killed mid-unit means its work is lost. The gap between this and
 * the ceiling is that safety margin.
 */
const TICK_BUDGET_MS = Number(process.env.PIPELINE_TICK_MS) || 210_000;

/**
 * Units started together within one tick.
 *
 * The same reasoning as the CLI's `--concurrency`: the model provider's rate
 * limiter is shared and is the real bottleneck, while crawling is where the
 * wall-clock goes, so a few lanes overlap the waiting nicely. Kept low because
 * a tick that overshoots its budget cannot be resumed mid-unit.
 */
const BATCH = Number(process.env.PIPELINE_BATCH) || 3;

/**
 * A model call must not outlive the function.
 *
 * The CLI waits up to 300s for a profile response, which is right on a laptop
 * and fatal here: the function would be killed with the work unsaved, and the
 * job would look stuck. Only set when the operator has not chosen a value.
 */
process.env.GEMINI_TIMEOUT_MS ||= "90000";

export interface JobRow {
  id: string;
  kind: "extract" | "discover";
  args: JobArgs;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  units: JobUnit[];
  cursor: number;
  total: number;
  staged: number;
  failed: number;
  skipped: number;
}

/** What one unit of work is: a programme to read, or a seed to crawl. */
export type JobUnit =
  | { kind: "programme"; id: string; title: string }
  | { kind: "seed"; label: string };

export interface TickResult {
  status: JobRow["status"];
  cursor: number;
  total: number;
  staged: number;
  failed: number;
  skipped: number;
  lines: string[];
  /** Set when the run stopped for a reason worth showing prominently. */
  error?: string;
}

type Db = SupabaseClient;

/* -------------------------------------------------------------------------- */
/* Planning: what a run will do, decided once                                 */
/* -------------------------------------------------------------------------- */

/**
 * The work list, fixed at start time.
 *
 * Recomputing it every tick would let it shift under the cursor — a row
 * verified mid-run, or a proposal applied, changes which rows the query
 * returns, and unit 7 would silently become a different programme. Fixing it up
 * front is what makes "12 of 20" mean anything.
 */
/**
 * The rows that have gone out of date, worst first.
 *
 * TWO QUERIES, because the two kinds of staleness have different rules and
 * expressing that as one nested PostgREST filter would be unreadable:
 *
 *   A CYCLE HAS TURNED — the deadline is in the past. This includes rows a
 *   human verified, and that is the point: a verification confirms a date, and
 *   a date that has passed has outlived its confirmation. Re-reading one stages
 *   a PROPOSAL for review, which overwrites nothing, so the rule that a machine
 *   never edits a checked row still holds.
 *
 *   A READING HAS AGED — nothing has looked in ninety days, or ever. Verified
 *   rows are left out here: a human's check does not expire on a timer, only
 *   when the thing it checked does.
 *
 * The passed deadlines come first because they are the ones actively misleading
 * somebody.
 */
async function planStale(
  db: Db,
  args: Extract<JobArgs, { kind: "extract" }>,
  notes: string[],
): Promise<Array<{ id: string; title: string }>> {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(
    Date.now() - STALE_AFTER_DAYS * 86_400_000,
  ).toISOString();

  // A title filter is a substring match on the same column in both queries;
  // `%%` matches everything, so the unfiltered case needs no separate branch.
  const pattern = `%${args.title ?? ""}%`;

  const [expired, aged] = await Promise.all([
    db
      .from("scholarships")
      .select("id, title")
      .ilike("title", pattern)
      .not("deadline_date", "is", null)
      .lt("deadline_date", today)
      .order("deadline_date", { ascending: true })
      .limit(args.limit),
    db
      .from("scholarships")
      .select("id, title")
      .ilike("title", pattern)
      .neq("verification_status", "verified")
      .or(`last_verified_at.is.null,last_verified_at.lt.${cutoff}`)
      .order("last_verified_at", { ascending: true, nullsFirst: true })
      .limit(args.limit),
  ]);

  if (expired.error) {
    throw new Error(`Could not load scholarships: ${expired.error.message}`);
  }
  if (aged.error) {
    throw new Error(`Could not load scholarships: ${aged.error.message}`);
  }

  const seen = new Set<string>();
  const rows: Array<{ id: string; title: string }> = [];

  for (const row of [...(expired.data ?? []), ...(aged.data ?? [])]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= args.limit) break;
  }

  if (rows.length === 0) {
    notes.push(
      `Nothing is stale: every row has a deadline still ahead of it and was read within ${STALE_AFTER_DAYS} days.`,
    );
  } else {
    const passed = (expired.data ?? []).length;
    notes.push(
      `${rows.length} stale row(s)` +
        (passed > 0 ? `, ${passed} with a deadline already gone` : ""),
    );
  }

  return rows;
}

export async function planUnits(
  db: Db,
  args: JobArgs,
): Promise<{ units: JobUnit[]; notes: string[] }> {
  const notes: string[] = [];

  if (args.kind === "discover") {
    const seeds = args.seed
      ? SEEDS.filter((seed) =>
          seed.label.toLowerCase().includes(args.seed!.toLowerCase()),
        )
      : SEEDS;

    if (seeds.length === 0) notes.push(`No seed matches "${args.seed}".`);

    return {
      units: seeds.map((seed) => ({ kind: "seed", label: seed.label })),
      notes,
    };
  }

  let rows: Array<{ id: string; title: string }>;

  if (args.staleOnly) {
    rows = await planStale(db, args, notes);
  } else {
    let query = db
      .from("scholarships")
      .select("id, title")
      .neq("verification_status", "verified") // never overwrite human-checked rows
      // Never-checked rows first, then the longest-neglected. Without an ORDER BY
      // the LIMIT takes an arbitrary slice, so repeated runs chew the same rows
      // forever and never reach the tail of the table.
      .order("last_verified_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .limit(args.limit);

    if (args.title) query = query.ilike("title", `%${args.title}%`);

    const { data, error } = await query;
    if (error) throw new Error(`Could not load scholarships: ${error.message}`);
    rows = (data ?? []) as Array<{ id: string; title: string }>;
  }

  // Re-running used to stage a SECOND proposal for a row that already had one
  // pending, so the review queue filled with duplicates of the same programme.
  if (!args.force && rows.length > 0) {
    const { data: pending } = await db
      .from("scholarship_extractions")
      .select("scholarship_id")
      .eq("status", "pending");

    const waiting = new Set((pending ?? []).map((row) => row.scholarship_id));
    const before = rows.length;
    rows = rows.filter((row) => !waiting.has(row.id));

    const held = before - rows.length;
    if (held > 0) {
      notes.push(
        `${held} programme(s) skipped — a proposal is already waiting in review. Use Force to re-extract anyway.`,
      );
    }
  }

  return {
    units: rows.map((row) => ({ kind: "programme", id: row.id, title: row.title })),
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* One tick                                                                   */
/* -------------------------------------------------------------------------- */

export async function runTick(db: Db, job: JobRow): Promise<TickResult> {
  const lines: string[] = [];
  const say = (line: string) => lines.push(line);

  /**
   * How much of `lines` is already in the database.
   *
   * A tick is minutes of crawling, and its output used to reach Postgres only
   * when the whole thing returned — so the console had nothing to show and
   * nothing to poll for, and an operator watched a blank pane for three and a
   * half minutes before the entire run appeared at once. Flushing after each
   * batch is what makes progress visible while it is happening.
   */
  let flushed = 0;

  const startedAt = Date.now();
  const timeLeft = () => TICK_BUDGET_MS - (Date.now() - startedAt);

  let cursor = job.cursor;
  let staged = job.staged;
  let failed = job.failed;
  let skipped = job.skipped;
  let status: JobRow["status"] = "running";
  let error: string | undefined;

  const provider = pickProvider(process.env.PIPELINE_PROVIDER);
  const fallback =
    job.args.kind === "extract" && job.args.escalate
      ? pickFallbackProvider(provider)
      : null;

  if (cursor === 0) {
    say(
      `${job.total} unit(s) · ${provider.name}/${provider.model}` +
        (fallback ? ` → escalates to ${fallback.name}/${fallback.model}` : "") +
        (job.args.dryRun ? " · DRY RUN" : ""),
    );
  }

  /* ------------------------------------------------------- shared context */

  const stores = makeStores(db);

  // Loaded once per tick rather than per unit: both are small queries, and the
  // alternative is the same round trip inside every lane.
  const context =
    job.args.kind === "extract"
      ? await extractContext(db, job)
      : await discoverContext(db);

  /* ------------------------------------------------------------ the work */

  try {
    while (cursor < job.total && timeLeft() > 0) {
      // Re-read the status, not the whole job: a cancel pressed mid-tick should
      // stop the next batch rather than wait for the budget to run out.
      const { data: live } = await db
        .from("pipeline_jobs")
        .select("status")
        .eq("id", job.id)
        .maybeSingle();

      if (live?.status === "cancelled") {
        status = "cancelled";
        say(`\n■ cancelled.`);
        break;
      }

      const batch = job.units.slice(cursor, cursor + BATCH);
      if (batch.length === 0) break;

      const results = await Promise.all(
        batch.map(async (unit, offset) => {
          const own: string[] = [];
          const index = cursor + offset + 1;
          own.push(
            `\n[${index}/${job.total}] ${unit.kind === "seed" ? unit.label : unit.title}`,
          );

          try {
            if (unit.kind === "programme" && job.args.kind === "extract") {
              // The work list was fixed when the run started, so a row can be
              // deleted — or lose its portal URL — between then and now. Say so
              // rather than handing the extractor an undefined target and
              // reporting whatever TypeError comes back out.
              const target = (context as ExtractContext).targets.get(unit.id);
              if (!target) {
                own.push(`    ✗ this row no longer exists — skipped`);
                return { lines: own, staged: false, failed: true, skipped: false };
              }

              const outcome = await extractProgramme({
                target,
                provider,
                fallback,
                store: stores.extraction,
                say: (line) => own.push(line),
                maxPages: job.args.pages,
                datesOnly: job.args.datesOnly,
                force: job.args.force,
                dryRun: job.args.dryRun,
                fixUrls: job.args.fixUrls,
                verify: job.args.verify,
                gapFill: job.args.gapFill,
                gapCrawl: job.args.gapCrawl,
                previous: (context as ExtractContext).previous.get(unit.id) ?? null,
                sources: (context as ExtractContext).sources.get(unit.id) ?? [],
              });
              return { lines: own, ...outcome };
            }

            if (unit.kind === "seed" && job.args.kind === "discover") {
              const seed = SEEDS.find((entry) => entry.label === unit.label);
              if (!seed) {
                own.push(`    ✗ seed no longer exists in seeds.ts`);
                return { lines: own, staged: false, failed: true, skipped: false };
              }

              const outcome = await discoverSeed({
                seed,
                provider,
                knowledge: (context as DiscoverContext).knowledge,
                store: stores.discovery,
                say: (line) => own.push(line),
                options: {
                  perSeed: job.args.perSeed,
                  maxListings: job.args.maxListing,
                  minConfidence: job.args.minConfidence,
                  useSitemap: job.args.useSitemap,
                  dryRun: job.args.dryRun,
                },
              });

              own.push(
                `    = ${outcome.staged} staged · ${outcome.rejected} not programmes · ${outcome.duplicates} already known`,
              );
              // A seed's tally is many candidates, not one outcome, so it is
              // folded into the run totals rather than counted as a single unit.
              return {
                lines: own,
                staged: outcome.staged > 0,
                failed: false,
                skipped: false,
                stagedCount: outcome.staged,
              };
            }

            own.push(`    ✗ unit does not match the job kind`);
            return { lines: own, staged: false, failed: true, skipped: false };
          } catch (failure) {
            if (failure instanceof DailyLimitError) throw failure;
            own.push(
              `    ✗ ${failure instanceof Error ? failure.message : String(failure)}`,
            );
            return { lines: own, staged: false, failed: true, skipped: false };
          }
        }),
      );

      for (const result of results) {
        for (const line of result.lines) say(line);
        if ("stagedCount" in result && typeof result.stagedCount === "number") {
          staged += result.stagedCount;
        } else if (result.staged) {
          staged++;
        }
        if (result.failed) failed++;
        if (result.skipped) skipped++;
      }

      cursor += batch.length;

      /**
       * Publish progress after each batch: the new lines, the cursor, and a
       * fresh heartbeat.
       *
       * The heartbeat matters as much as the lines. `claim_pipeline_tick`
       * hands the job to another worker when the current one looks dead, and a
       * tick that only touched the row at the end looked dead for its entire
       * duration to anything checking.
       *
       * Best-effort: a failed progress write must never lose the work this
       * tick has already done. The final `save` writes it all again anyway.
       */
      try {
        await appendLines(db, job.id, lines.slice(flushed));
        flushed = lines.length;

        await db
          .from("pipeline_jobs")
          .update({
            cursor,
            staged,
            failed,
            skipped,
            heartbeat_at: new Date().toISOString(),
          })
          .eq("id", job.id);
      } catch {
        // Report it next flush, or in the final save.
      }
    }
  } catch (failure) {
    // A day-scale quota is not recoverable by ticking again, so the job stops
    // rather than burning the rest of its units on the same error.
    if (failure instanceof DailyLimitError) {
      status = "failed";
      error = failure.message;
      say(`\n✗ ${failure.message}`);
    } else {
      status = "failed";
      error = failure instanceof Error ? failure.message : String(failure);
      say(`\n✗ ${error}`);
    }
  }

  if (status === "running" && cursor >= job.total) {
    status = "done";
    const cache = pageCacheStats();
    say(
      `\n✓ ${staged} staged · ${failed} failed` +
        (skipped > 0 ? ` · ${skipped} unchanged` : "") +
        (cache.hits > 0
          ? ` · ${cache.hits} of ${cache.hits + cache.misses} page request(s) from cache`
          : ""),
    );
    if (staged > 0 && !job.args.dryRun) {
      say(
        job.args.kind === "extract"
          ? `Review the proposals in Review.`
          : `Review the candidates in Candidates.`,
      );
    }
  }

  // Only what has not already been published — the mid-batch flushes above
  // wrote the rest, and re-inserting them would show every line twice.
  await save(db, job.id, {
    status,
    cursor,
    staged,
    failed,
    skipped,
    error,
    lines: lines.slice(flushed),
  });

  return { status, cursor, total: job.total, staged, failed, skipped, lines, error };
}

/* -------------------------------------------------------------------------- */
/* Stores: the writes, done as the signed-in admin                            */
/* -------------------------------------------------------------------------- */

/**
 * The pipeline's writes, through the caller's own session.
 *
 * This is the reason the deployed pipeline needs no service-role key: migration
 * 012 gives admins INSERT on exactly these tables, so RLS is doing the work the
 * key used to do — and doing it better, because a non-admin gets nothing rather
 * than everything.
 */
function makeStores(db: Db): { extraction: ExtractionStore; discovery: DiscoveryStore } {
  return {
    extraction: {
      async stage(row) {
        const { error } = await db.from("scholarship_extractions").insert(row);
        if (error) throw new Error(`Insert failed: ${error.message}`);
      },
      async repoint(scholarshipId, url) {
        const { error } = await db
          .from("scholarships")
          .update({ official_portal_url: url, source_url: null })
          .eq("id", scholarshipId);
        if (error) throw new Error(error.message);
      },
    },
    discovery: {
      async stageCandidate(row) {
        const { error } = await db.from("scholarship_candidates").insert(row);
        return error ? { error: error.message } : {};
      },
      async recordSource(row) {
        const { error } = await db
          .from("scholarship_sources")
          .upsert(row, { onConflict: "scholarship_id,url", ignoreDuplicates: true });
        return error ? { error: error.message } : {};
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Per-tick context                                                           */
/* -------------------------------------------------------------------------- */

interface ExtractContext {
  targets: Map<string, ProgrammeTarget>;
  previous: Map<string, { source_url: string; page_sha256: string }>;
  sources: Map<string, Array<{ url: string; authority: Authority }>>;
}

interface DiscoverContext {
  knowledge: ReturnType<typeof buildKnowledge>;
}

async function extractContext(db: Db, job: JobRow): Promise<ExtractContext> {
  const ids = job.units
    .filter((unit): unit is Extract<JobUnit, { kind: "programme" }> => unit.kind === "programme")
    .map((unit) => unit.id);

  const targets = new Map<string, ProgrammeTarget>();
  const previous = new Map<string, { source_url: string; page_sha256: string }>();
  const sources = new Map<string, Array<{ url: string; authority: Authority }>>();

  if (ids.length === 0) return { targets, previous, sources };

  const { data: rows } = await db
    .from("scholarships")
    .select("id, title, country, source_url, official_portal_url")
    .in("id", ids);

  for (const row of (rows ?? []) as ProgrammeTarget[]) targets.set(row.id, row);

  // The newest proposal per row, so an unchanged page can skip the model calls
  // entirely — `page_sha256` exists for exactly this.
  const { data: history } = await db
    .from("scholarship_extractions")
    .select("scholarship_id, source_url, page_sha256, created_at")
    .in("scholarship_id", ids)
    .order("created_at", { ascending: false });

  for (const row of history ?? []) {
    if (!previous.has(row.scholarship_id)) {
      previous.set(row.scholarship_id, {
        source_url: row.source_url,
        page_sha256: row.page_sha256,
      });
    }
  }

  if (job.args.kind === "extract" && job.args.verify) {
    const { data: sourceRows } = await db
      .from("scholarship_sources")
      .select("scholarship_id, url, authority")
      .in("scholarship_id", ids)
      .eq("muted", false);

    for (const row of sourceRows ?? []) {
      const list = sources.get(row.scholarship_id) ?? [];
      list.push({ url: row.url, authority: row.authority });
      sources.set(row.scholarship_id, list);
    }
  }

  return { targets, previous, sources };
}

async function discoverContext(db: Db): Promise<DiscoverContext> {
  const [{ data: existing }, { data: queued }] = await Promise.all([
    db.from("scholarships").select("id, title, official_portal_url, source_url"),
    db.from("scholarship_candidates").select("url, programme_name"),
  ]);

  return {
    knowledge: buildKnowledge({
      scholarships: existing ?? [],
      candidates: queued ?? [],
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write log lines, continuing the numbering from whatever is already there.
 *
 * Safe without a transaction because `claim_pipeline_tick` guarantees one
 * writer per job.
 *
 * SEPARATE FROM `save` SO IT CAN RUN MID-TICK. A tick is up to 210 seconds of
 * crawling, and every line it produced used to sit in a local array until the
 * whole thing finished — so the console showed nothing at all for three and a
 * half minutes and then the entire run at once. There was nothing to poll,
 * because the lines did not exist anywhere a poller could reach.
 */
async function appendLines(
  db: Db,
  jobId: string,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;

  const { data: last } = await db
    .from("pipeline_job_lines")
    .select("seq")
    .eq("job_id", jobId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();

  const start = (last?.seq ?? -1) + 1;

  await db.from("pipeline_job_lines").insert(
    lines.map((line, offset) => ({
      job_id: jobId,
      seq: start + offset,
      line,
    })),
  );
}

async function save(
  db: Db,
  jobId: string,
  update: {
    status: JobRow["status"];
    cursor: number;
    staged: number;
    failed: number;
    skipped: number;
    error?: string;
    lines: string[];
  },
): Promise<void> {
  await appendLines(db, jobId, update.lines);

  const finished = ["done", "failed", "cancelled"].includes(update.status);

  await db
    .from("pipeline_jobs")
    .update({
      status: update.status,
      cursor: update.cursor,
      staged: update.staged,
      failed: update.failed,
      skipped: update.skipped,
      error: update.error ?? null,
      heartbeat_at: new Date().toISOString(),
      ...(finished ? { finished_at: new Date().toISOString() } : {}),
    })
    .eq("id", jobId);
}
