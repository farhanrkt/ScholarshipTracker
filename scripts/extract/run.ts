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

import { crawlProgramme, describeCrawl } from "./crawl.ts";
import { pageCacheStats } from "./page.ts";
import { extractCycle, extractProfile } from "./extract.ts";
import {
  groundExtraction,
  groundProfile,
  isEmpty,
  isEmptyProfile,
  type GroundedExtraction,
  type GroundedProfile,
} from "./ground.ts";
import { selectPassages, type Passage } from "./passages.ts";
import { verifyCycle } from "./verify.ts";
import type { Authority } from "../discover/authority.ts";
import type { FieldSources } from "../../src/lib/types/database.ts";
import {
  DailyLimitError,
  listGeminiModels,
  listGroqModels,
  pickFallbackProvider,
  pickProvider,
  TruncatedError,
  type ExtractionProvider,
} from "./providers/index.ts";
import type { CycleExtraction } from "./schema.ts";

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
const maxPages = Number(option("pages") ?? 16);
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
 * Programmes extracted at once.
 *
 * Three is deliberate rather than "as many as possible": the model providers
 * are the real bottleneck and their limiters are shared, so more lanes mostly
 * queue behind each other while making the logs harder to follow. Crawling is
 * where the wall-clock time goes, and three lanes overlap that nicely.
 */
const concurrency = Math.min(Math.max(Number(option("concurrency") ?? 3), 1), 8);

/** The half of the crawl the profile call reads. */
const PROFILE_TOPICS = ["eligibility", "benefits", "documents", "process"] as const;

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

interface Target {
  id: string;
  title: string;
  country: string;
  source_url: string | null;
  official_portal_url: string;
}

interface Attempt {
  extraction: CycleExtraction;
  grounded: GroundedExtraction;
  provider: string;
  model: string;
}

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
  /** Rows whose stored URLs are all dead — a data problem no re-run will fix. */
  const unreachable: Target[] = [];
  const usage = new Map<string, { input: number; output: number }>();

  const record = (name: string, input: number, output: number) => {
    const current = usage.get(name) ?? { input: 0, output: 0 };
    usage.set(name, {
      input: current.input + input,
      output: current.output + output,
    });
  };

  const processTarget = async (target: Target): Promise<Outcome> => {
    const lines: string[] = [];
    const say = (line: string) => lines.push(line);
    const done = (patch: Partial<Outcome>): Outcome => ({
      staged: false,
      failed: false,
      skipped: false,
      lines,
      ...patch,
    });

    /**
     * Where to start crawling. THE ORDER HERE IS LOAD-BEARING.
     *
     * `official_portal_url` first, `source_url` second — which is the reverse
     * of what it used to be, and the reversal fixes a feedback loop that was
     * quietly hollowing out every row it touched:
     *
     *   1. A crawl finds the deadline on `/scholarships/application-timeline/`.
     *   2. `bestSourceUrl` is that page, because it is the page a human
     *      re-verifying the date should open. Correct, and useful.
     *   3. `apply_extraction()` writes it to `source_url`.
     *   4. The NEXT crawl starts there instead of the programme's own page.
     *
     * Each pass moves the entry further toward a generic dates page and further
     * from the page describing the award. Observed: all three Chevening rows —
     * Scholarships, SIDS, Fellowships — had converged on the same
     * `/application-timeline/` entry, so all three crawled the same pages, none
     * started from its own programme page, and the coverage matrix stayed empty
     * because nothing in that neighbourhood discusses money.
     *
     * Worse, converging distinct programmes on ONE entry is how a row inherits
     * another programme's dates. The Fellowships row was saved only by the
     * model noticing and reporting "wrong site".
     *
     * `official_portal_url` is the right anchor precisely because nothing in
     * this pipeline ever writes to it: it stays the programme's own page. The
     * timeline page is still reached — it is one link away, the crawler scores
     * it highly, and `bestSourceUrl` still records it for the reviewer.
     *
     * Both are kept because they are not always both alive: a stored page can
     * 404 after a site reshuffle while the other still works, and giving up on
     * the first failure threw away a programme over a URL we had a spare for.
     */
    const entryCandidates = [...new Set(
      [target.official_portal_url, target.source_url].filter(
        (url): url is string => Boolean(url),
      ),
    )];

    try {
      let crawled: Awaited<ReturnType<typeof crawlProgramme>> | null = null;
      let entryUrl = entryCandidates[0]!;

      for (const candidate of entryCandidates) {
        say(`    crawling from ${candidate}`);
        const attemptCrawl = await crawlProgramme(candidate, {
          maxPages,
          titleHint: target.title,
        });

        if (attemptCrawl.pages.length > 0) {
          crawled = attemptCrawl;
          entryUrl = candidate;
          break;
        }
        say(`    · unreachable: ${attemptCrawl.errors[0]?.message ?? "no readable pages"}`);
      }

      if (!crawled) {
        unreachable.push(target);
        throw new Error(
          `no reachable entry page (tried ${entryCandidates.length}) — the stored URL needs fixing`,
        );
      }

      const { pages, errors, topicCounts } = crawled;

      // Nothing has changed since the last proposal for this row, so the model
      // would read the same words and reach the same conclusion. Crawling was
      // cheap; the two calls are not.
      const previous = lastSeen.get(target.id);
      if (!force && previous) {
        const samePage = pages.find((page) => page.url === previous.source_url);
        if (samePage && samePage.sha256 === previous.page_sha256) {
          say(`    · unchanged since the last extraction — skipped (--force to re-read)`);
          return done({ skipped: true });
        }
      }

      // The prompt budget is the provider's, not a constant: a free-tier rate
      // limit is a much tighter ceiling than a context window. The two calls
      // SHARE that budget rather than each taking it in full — a rate limit is
      // per minute, and both calls happen inside the same minute. Dates get the
      // larger share because a missed deadline is the costlier miss.
      const cycleBudget = datesOnly
        ? provider.promptBudgetChars
        : Math.floor(provider.promptBudgetChars * 0.55);
      const profileBudget = provider.promptBudgetChars - cycleBudget;

      const datePassages = selectPassages(pages, cycleBudget, ["dates"]);
      const profilePassages = datesOnly
        ? []
        : selectPassages(pages, profileBudget, PROFILE_TOPICS);

      const crawledChars = pages.reduce((sum, page) => sum + page.text.length, 0);
      const keptChars = [...datePassages, ...profilePassages].reduce(
        (sum, item) => sum + item.text.length,
        0,
      );

      say(
        `    ${pages.length} page(s) [${describeCrawl(topicCounts)}], ${crawledChars.toLocaleString()} chars → ${datePassages.length}+${profilePassages.length} passage(s), ${keptChars.toLocaleString()} chars`,
      );
      for (const failure of errors) {
        say(`    · skipped ${failure.url}: ${failure.message}`);
      }
      if (datePassages.length === 0 && profilePassages.length === 0) {
        throw new Error("no relevant passages found across the crawl");
      }

      /* ------------------------------------------------ call 1: the cycle */

      // Try the cheap provider first; escalate only when it produced nothing
      // that survived grounding.
      const chain: ExtractionProvider[] = fallback ? [provider, fallback] : [provider];
      let attempt: Attempt | null = null;
      let wrongSite = false;

      for (const [attemptIndex, candidate] of chain.entries()) {
        if (datePassages.length === 0) break;

        let result;
        try {
          result = await extractCycle(
            candidate,
            target.title,
            target.country,
            datePassages,
          );
        } catch (failure) {
          if (failure instanceof DailyLimitError) throw failure;
          // A provider timeout or an unparseable response is not a reason to
          // lose the profile call as well — the two are independent readings of
          // the same crawl, and half an extraction beats none.
          say(
            `    · cycle extraction failed on ${candidate.name}: ${failure instanceof Error ? failure.message : failure}`,
          );
          continue;
        }
        record(candidate.name, result.inputTokens, result.outputTokens);

        if (!result.extraction.page_is_about_requested_programme) {
          say(`    ✗ wrong site — model saw: ${result.extraction.page_subject}`);
          wrongSite = true;
          break;
        }

        // Ground against the FULL text of every crawled page, not the trimmed
        // passages — a real quote must never be rejected because of budgeting.
        const grounded = groundExtraction(result.extraction, pages, entryUrl);
        attempt = {
          extraction: result.extraction,
          grounded,
          provider: candidate.name,
          model: result.model,
        };

        if (!isEmpty(grounded)) break;
        if (attemptIndex < chain.length - 1) {
          say(`    · ${candidate.name} found nothing, escalating`);
        }
      }

      if (wrongSite) return done({ failed: true });

      /* --------------------------------------------- call 2: the profile */

      // Best-effort by design: a profile that fails to parse, gets truncated,
      // or comes back empty must not cost us the deadline we already have.
      let profile: GroundedProfile | null = null;
      let profileNotes: string | null = null;

      if (profilePassages.length > 0) {
        const runner = chain.find((candidate) => candidate.name === attempt?.provider) ?? provider;

        /**
         * Two goes at the profile, the second on half the context.
         *
         * A three-programme Chevening run lost the profile call on ALL THREE to
         * `The operation was aborted due to timeout`, and a timeout here is the
         * expensive failure: the cycle call still succeeds, so the run reports
         * "3 staged" while every row it staged has a deadline and nothing about
         * the money, the eligibility, or the documents. That is the shallow-data
         * symptom, arriving through the one path that looks like success.
         *
         * Halving the passages is the right retry rather than simply waiting
         * longer, because prompt size is what makes the response slow: fewer
         * passages means fewer values to quote and a much shorter JSON body. The
         * highest-scoring passages are kept, so the second attempt reads the
         * densest half of what the first one saw — a smaller answer from the
         * better evidence, which is a good trade and not merely a cheaper one.
         */
        const attempts: Passage[][] = [
          profilePassages,
          profilePassages.slice(0, Math.ceil(profilePassages.length / 2)),
        ];

        for (const [index, passages] of attempts.entries()) {
          const isRetry = index > 0;
          if (isRetry && passages.length === profilePassages.length) break;

          try {
            const result = await extractProfile(
              runner,
              target.title,
              target.country,
              passages,
            );
            record(runner.name, result.inputTokens, result.outputTokens);

            if (result.extraction.page_is_about_requested_programme) {
              const groundedProfile = groundProfile(result.extraction, pages);
              profileNotes = result.extraction.notes_for_reviewer || null;
              if (!isEmptyProfile(groundedProfile)) profile = groundedProfile;
            } else {
              say(`    · profile call read the wrong programme, dropped`);
            }
            break;
          } catch (failure) {
            if (failure instanceof DailyLimitError) throw failure;

            const message = failure instanceof Error ? failure.message : String(failure);
            // Only size-related failures are worth a smaller retry. A refusal or
            // a bad API key will fail identically on half the input.
            const retryable =
              failure instanceof TruncatedError || /timeout|aborted|took too long/i.test(message);

            if (!isRetry && retryable) {
              say(`    · profile call ${message} — retrying on half the passages`);
              continue;
            }
            say(`    · profile extraction failed: ${message}`);
            break;
          }
        }
      }

      if (!attempt && !profile) {
        say(`    ✗ nothing extracted — needs manual verification`);
        return done({ failed: true });
      }

      /* ------------------------------------------------------- reporting */

      const ungrounded = [
        ...(attempt?.grounded.ungroundedFields ?? []),
        ...(profile?.ungroundedFields ?? []),
      ];
      const caveats = [
        ...(attempt?.grounded.caveats ?? []),
        ...(profile?.caveats ?? []),
      ];

      for (const failure of ungrounded) say(`    ⚠ dropped ${failure}`);
      for (const caveat of caveats) say(`    ! ${caveat}`);

      if (attempt && isEmpty(attempt.grounded) && !profile) {
        say(`    ✗ no grounded dates found — needs manual verification`);
        return done({ failed: true });
      }

      const cycle = attempt?.grounded.proposed ?? {
        cycle_label: null,
        opens_date: null,
        deadline_date: null,
        timeline: [],
      };

      /* ------------------------------------ cross-verification (opt-in) */

      // Only the cycle dates, and only when other sources are on file. A
      // missed deadline is a missed year, which is the one error here that a
      // student cannot recover from — so it gets the budget, and coverage and
      // eligibility do not.
      let fieldSources: FieldSources = {};
      const otherSources = verify ? (sourcesByScholarship.get(target.id) ?? []) : [];

      if (verify && otherSources.length > 0 && attempt) {
        const verified = await verifyCycle(
          {
            url: attempt.grounded.bestSourceUrl,
            cycle_label: cycle.cycle_label,
            opens_date: cycle.opens_date,
            deadline_date: cycle.deadline_date,
            quotes: {
              cycle_label: attempt.grounded.evidence.cycle_label?.quote ?? null,
              opens_date: attempt.grounded.evidence.opens_date?.quote ?? null,
              deadline_date: attempt.grounded.evidence.deadline_date?.quote ?? null,
            },
          },
          {
            provider,
            title: target.title,
            country: target.country,
            funderUrl: target.official_portal_url,
            sources: otherSources,
            maxSources: maxVerifySources,
            budgetChars: Math.floor(provider.promptBudgetChars * 0.3),
            say,
          },
        );

        // The reconciled value replaces the primary reading only when a source
        // outranked it. The funder always wins, so in the ordinary case this
        // changes nothing and only records who else agreed.
        cycle.cycle_label = verified.cycle_label.value;
        cycle.opens_date = verified.opens_date.value;
        cycle.deadline_date = verified.deadline_date.value;

        fieldSources = verified.fieldSources;
        for (const caveat of verified.caveats) {
          say(`    ⚖ ${caveat}`);
          caveats.push(caveat);
        }

        if (verified.consulted.length > 0) {
          const agreed = Object.values(verified.fieldSources).filter(
            (entry) => (entry.corroborated_by?.length ?? 0) > 0,
          ).length;
          say(
            `    → cross-checked against ${verified.consulted.length} source(s)` +
              (agreed > 0 ? `, ${agreed} field(s) corroborated` : "") +
              (verified.caveats.length > 0 ? `, ${verified.caveats.length} disagreement(s)` : ""),
          );
        }
      }

      say(
        `    → opens ${cycle.opens_date ?? "—"} · closes ${cycle.deadline_date ?? "—"} · ${cycle.timeline.length} stage(s)` +
          (attempt ? `  [${attempt.provider}]` : "  [no cycle]"),
      );
      if (profile) {
        const {
          coverage_matrix,
          eligibility_flags,
          document_checklist,
          fields_of_study,
          award_duration,
          number_of_awards,
        } = profile.proposed;
        say(
          `    → ${Object.keys(coverage_matrix).length} coverage line(s) · ${Object.keys(eligibility_flags).length} eligibility field(s) · ${document_checklist.length} document(s)`,
        );

        // Reported separately and only when present. A field that extracted is
        // worth seeing in the log — otherwise there is no way to tell whether
        // the pages were silent or the pipeline never asked.
        const scope = [
          award_duration && `funded for ${award_duration}`,
          number_of_awards && `${number_of_awards} offered`,
          fields_of_study.length > 0 && `restricted to ${fields_of_study.join(", ")}`,
        ].filter((part): part is string => Boolean(part));
        if (scope.length > 0) say(`    → ${scope.join(" · ")}`);
      }

      const bestSourceUrl = attempt?.grounded.bestSourceUrl ?? entryUrl;
      say(`    source: ${bestSourceUrl}`);

      const notes = [attempt?.extraction.notes_for_reviewer, profileNotes]
        .filter((note): note is string => Boolean(note && note.trim()))
        .join(" · ");
      if (notes) say(`    note: ${notes}`);

      if (dryRun) return done({ staged: true });

      const sourcePage = pages.find((page) => page.url === bestSourceUrl) ?? pages[0]!;

      const { error: insertError } = await supabase
        .from("scholarship_extractions")
        .insert({
          scholarship_id: target.id,
          source_url: bestSourceUrl,
          fetched_at: sourcePage.fetchedAt,
          page_sha256: sourcePage.sha256,
          model: `${attempt?.provider ?? provider.name}/${attempt?.model ?? provider.model}`,
          // One JSONB column, both halves. apply_extraction() reads whichever
          // keys are present and leaves the rest of the row alone.
          proposed: {
            ...cycle,
            ...(profile?.proposed ?? {}),
            // Only when something was actually cross-checked: an empty object
            // would make "nobody else was asked" look like "one source agreed".
            ...(Object.keys(fieldSources).length > 0 ? { field_sources: fieldSources } : {}),
          },
          evidence: {
            ...(attempt?.grounded.evidence ?? {}),
            ...(profile?.evidence ?? {}),
          },
          ungrounded_fields: ungrounded,
          caveats,
          page_subject: attempt?.extraction.page_subject ?? null,
          model_notes: notes || null,
        });

      if (insertError) throw new Error(`Insert failed: ${insertError.message}`);

      say(`    ✓ staged for review`);
      return done({ staged: true });
    } catch (failure) {
      // A day-scale quota stops the whole run; the pool handles that. Anything
      // else is this programme's problem alone.
      if (failure instanceof DailyLimitError) throw failure;
      say(`    ✗ ${failure instanceof Error ? failure.message : String(failure)}`);
      return done({ failed: true });
    }
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
  // with: every URL on the row is dead, so someone has to find a live one.
  if (unreachable.length > 0) {
    console.log(`\n${unreachable.length} row(s) have no reachable URL — fix these by hand:`);
    for (const target of unreachable) {
      console.log(`  ${target.title}`);
      console.log(`    ${target.source_url ?? target.official_portal_url}`);
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
