import { crawlProgramme, describeCrawl } from "./crawl.ts";
import { fetchPage } from "./page.ts";
import { findLiveEntry } from "./repair.ts";
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
  TruncatedError,
  type ExtractionProvider,
} from "./providers/index.ts";
import type { CycleExtraction } from "./schema.ts";

/**
 * One programme, crawled and read, with nowhere it insists on running.
 *
 * This used to live inside `run.ts`'s main(), closed over a dozen locals and a
 * service-role Supabase client. That made it a CLI feature: the deployed app
 * could not reach it, which is why `/admin/pipeline` refused to work on Vercel
 * and the whole pipeline was a laptop-only affair.
 *
 * Nothing here knows what is calling it. Writes go through `ExtractionStore` —
 * two methods — so the CLI can hand it a service-role client while a Route
 * Handler hands it one bound to the signed-in admin's session, and neither
 * needs the other's credentials. Output goes through `say`, so it can become
 * stdout in a terminal or rows in `pipeline_job_lines` on a serverless host.
 *
 * The logic itself is unchanged and deliberately so: there is one extraction
 * pipeline, and a bug fixed on one host is fixed on both.
 */

/** The half of the crawl the profile call reads. */
export const PROFILE_TOPICS = [
  "eligibility",
  "benefits",
  "documents",
  "process",
] as const;

export interface ProgrammeTarget {
  id: string;
  title: string;
  country: string;
  source_url: string | null;
  official_portal_url: string;
}

/** Exactly the row `scholarship_extractions` expects. */
export interface StagedExtraction {
  scholarship_id: string;
  source_url: string;
  fetched_at: string;
  page_sha256: string;
  model: string;
  proposed: Record<string, unknown>;
  evidence: Record<string, unknown>;
  ungrounded_fields: string[];
  caveats: string[];
  page_subject: string | null;
  model_notes: string | null;
}

/**
 * The two writes an extraction makes.
 *
 * An interface rather than a Supabase client because the two callers hold
 * different clients with different privileges, and because this is the whole
 * surface: a proposal, and — only when a dead URL was repaired — a corrected
 * address on the row.
 */
export interface ExtractionStore {
  stage(row: StagedExtraction): Promise<void>;
  repoint(scholarshipId: string, url: string): Promise<void>;
}

export interface ExtractProgrammeOptions {
  target: ProgrammeTarget;
  provider: ExtractionProvider;
  /** Escalation target, or null when `--escalate` was not asked for. */
  fallback?: ExtractionProvider | null;
  store: ExtractionStore;
  say: (line: string) => void;
  /** Token accounting, for the run summary. */
  record?: (provider: string, input: number, output: number) => void;

  maxPages?: number;
  datesOnly?: boolean;
  force?: boolean;
  dryRun?: boolean;
  fixUrls?: boolean;
  verify?: boolean;
  maxVerifySources?: number;

  /** The newest proposal for this row, for the unchanged check. */
  previous?: { source_url: string; page_sha256: string } | null;
  /** Other sites describing this programme, for `--verify`. */
  sources?: Array<{ url: string; authority: Authority }>;
}

export interface ProgrammeResult {
  staged: boolean;
  failed: boolean;
  skipped: boolean;
  /** The address the row was re-pointed at, when it was. */
  repaired: string | null;
  /** Set when every stored URL failed: the status the server gave, if any. */
  unreachable?: { status?: number };
}

interface Attempt {
  extraction: CycleExtraction;
  grounded: GroundedExtraction;
  provider: string;
  model: string;
}

export async function extractProgramme(
  options: ExtractProgrammeOptions,
): Promise<ProgrammeResult> {
  const {
    target,
    provider,
    fallback = null,
    store,
    say,
    record = () => {},
    maxPages = 20,
    datesOnly = false,
    force = false,
    dryRun = false,
    fixUrls = true,
    verify = false,
    maxVerifySources = 2,
    previous = null,
    sources = [],
  } = options;

  const done = (patch: Partial<ProgrammeResult>): ProgrammeResult => ({
    staged: false,
    failed: false,
    skipped: false,
    repaired: null,
    ...patch,
  });

  /**
   * Where to start crawling. THE ORDER HERE IS LOAD-BEARING.
   *
   * `official_portal_url` first, `source_url` second — which is the reverse of
   * what it used to be, and the reversal fixes a feedback loop that was quietly
   * hollowing out every row it touched:
   *
   *   1. A crawl finds the deadline on `/scholarships/application-timeline/`.
   *   2. `bestSourceUrl` is that page, because it is the page a human
   *      re-verifying the date should open. Correct, and useful.
   *   3. `apply_extraction()` writes it to `source_url`.
   *   4. The NEXT crawl starts there instead of the programme's own page.
   *
   * Each pass moves the entry further toward a generic dates page and further
   * from the page describing the award. Observed: all three Chevening rows had
   * converged on the same `/application-timeline/` entry, so all three crawled
   * the same pages and the coverage matrix stayed empty, because nothing in
   * that neighbourhood discusses money.
   *
   * `official_portal_url` is the right anchor precisely because nothing in this
   * pipeline writes to it — except dead-link repair below, and only after an
   * extraction has vouched for the replacement.
   *
   * Both are kept because they are not always both alive: a stored page can 404
   * after a site reshuffle while the other still works.
   */
  const entryCandidates = [
    ...new Set(
      [target.official_portal_url, target.source_url].filter(
        (url): url is string => Boolean(url),
      ),
    ),
  ];

  if (entryCandidates.length === 0) {
    say(`    ✗ no URL on this row at all`);
    return done({ failed: true, unreachable: {} });
  }

  /**
   * Has anything changed since last time? One page answers that.
   *
   * This check used to run AFTER the crawl, which made it a saving on the two
   * model calls and nothing else — a re-run of three unchanged Chevening rows
   * still fetched sixty-one pages and took just under three minutes to announce
   * that it had no work to do. The answer depends on exactly one page, so that
   * is the only page fetched to find out.
   *
   * A failure here is neither a skip nor an error: it falls through to the full
   * crawl, which is where a dead URL gets diagnosed and repaired. The page is
   * cached either way, so the crawl does not pay for this request twice.
   */
  if (!force && previous?.source_url) {
    try {
      const page = await fetchPage(previous.source_url);
      if (page.sha256 === previous.page_sha256) {
        say(`    · unchanged since the last extraction — skipped (force to re-read)`);
        return done({ skipped: true });
      }
    } catch {
      // Gone, moved, or refusing us. The crawl below finds out which.
    }
  }

  try {
    let crawled: Awaited<ReturnType<typeof crawlProgramme>> | null = null;
    let entryUrl = entryCandidates[0]!;
    /** Set when the row's stored URL was dead and a live one was found. */
    let repairedUrl: string | null = null;

    /** The status the server gave each stored URL, when it gave one. */
    const entryStatus = new Map<string, number | undefined>();

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
      const failure = attemptCrawl.errors[0];
      entryStatus.set(candidate, failure?.status);
      say(`    · unreachable: ${failure?.message ?? "no readable pages"}`);
    }

    /* ----------------------------------------------------- dead-link repair */

    // A 404 is the one failure that tells us something actionable: the page has
    // moved, and the programme is probably still there under a new address.
    // Everything else — a timeout, a 403, a JavaScript-only page — is about the
    // request rather than the URL, so guessing new addresses would just be more
    // requests to a host that is already refusing us.
    if (!crawled) {
      const moved = entryCandidates.find((url) => {
        const status = entryStatus.get(url);
        return status === 404 || status === 410;
      });

      if (moved) {
        say(`    · ${moved} is gone — looking for where it moved to`);
        const found = await findLiveEntry(moved, { title: target.title, say });

        if (found) {
          const retry = await crawlProgramme(found.url, {
            maxPages,
            titleHint: target.title,
          });
          if (retry.pages.length > 0) {
            crawled = retry;
            entryUrl = found.url;
            repairedUrl = found.url;
          }
        }
      }
    }

    if (!crawled) {
      say(
        `    ✗ no reachable entry page (tried ${entryCandidates.length}) — the stored URL needs fixing`,
      );
      return done({
        failed: true,
        unreachable: {
          status: entryCandidates
            .map((url) => entryStatus.get(url))
            .find((status) => status !== undefined),
        },
      });
    }

    const { pages, errors, topicCounts } = crawled;

    // The prompt budget is the provider's, not a constant: a free-tier rate
    // limit is a much tighter ceiling than a context window. The two calls
    // SHARE that budget rather than each taking it in full — a rate limit is per
    // minute, and both calls happen inside the same minute. Dates are selected
    // first because a missed deadline is the costlier miss.
    const cycleBudget = datesOnly
      ? provider.promptBudgetChars
      : Math.floor(provider.promptBudgetChars * 0.55);

    const datePassages = selectPassages(pages, cycleBudget, ["dates"]);

    /**
     * What the dates did not spend goes to the profile, rather than expiring.
     *
     * Date passages are sparse by nature — a closing date lives in one or two
     * sentences — so reserving 45% for the profile did not mean the profile GOT
     * 45%. It meant the cycle half used a fraction of its share and the rest was
     * discarded, while eligibility and coverage passages that would have fitted
     * were dropped for want of room. The shared ceiling is unchanged.
     */
    const dateChars = datePassages.reduce((sum, item) => sum + item.text.length, 0);
    const profileBudget = Math.max(0, provider.promptBudgetChars - dateChars);

    const profilePassages = datesOnly
      ? []
      : selectPassages(pages, profileBudget, [...PROFILE_TOPICS]);

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
      say(`    ✗ no relevant passages found across the crawl`);
      return done({ failed: true });
    }

    /* -------------------------------------------------- call 1: the cycle */

    // Try the cheap provider first; escalate only when it produced nothing that
    // survived grounding.
    const chain: ExtractionProvider[] = fallback ? [provider, fallback] : [provider];
    let attempt: Attempt | null = null;
    let wrongSite = false;

    for (const [attemptIndex, candidate] of chain.entries()) {
      if (datePassages.length === 0) break;

      let result;
      try {
        result = await extractCycle(candidate, target.title, target.country, datePassages);
      } catch (failure) {
        if (failure instanceof DailyLimitError) throw failure;
        // A provider timeout or an unparseable response is not a reason to lose
        // the profile call as well — the two are independent readings of the
        // same crawl, and half an extraction beats none.
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

    /* ------------------------------------------------ call 2: the profile */

    // Best-effort by design: a profile that fails to parse, gets truncated, or
    // comes back empty must not cost us the deadline we already have.
    let profile: GroundedProfile | null = null;
    let profileNotes: string | null = null;

    if (profilePassages.length > 0) {
      const runner = chain.find((candidate) => candidate.name === attempt?.provider) ?? provider;
      /**
       * The profile escalates on an EMPTY result, the way the cycle call does.
       *
       * Coming back with nothing that survives grounding is the profile call's
       * characteristic failure on a small model: it summarises instead of
       * quoting, every quote misses by a word, and the whole thing is discarded.
       * The pages are fine and a stronger reader gets them.
       */
      const profileChain: ExtractionProvider[] =
        fallback && fallback.name !== runner.name ? [runner, fallback] : [runner];

      /**
       * Two goes at the profile, the second on half the context.
       *
       * A timeout here is the expensive failure: the cycle call still succeeds,
       * so the run reports success while the row it staged has a deadline and
       * nothing about the money, the eligibility, or the documents.
       *
       * Halving the passages is the right retry rather than waiting longer,
       * because prompt size is what makes the response slow. The highest-scoring
       * passages are kept, so the second attempt reads the densest half of what
       * the first one saw.
       */
      const attempts: Passage[][] = [
        profilePassages,
        profilePassages.slice(0, Math.ceil(profilePassages.length / 2)),
      ];

      for (const [providerIndex, reader] of profileChain.entries()) {
        for (const [index, passages] of attempts.entries()) {
          const isRetry = index > 0;
          if (isRetry && passages.length === profilePassages.length) break;

          try {
            const result = await extractProfile(
              reader,
              target.title,
              target.country,
              passages,
            );
            record(reader.name, result.inputTokens, result.outputTokens);

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
              failure instanceof TruncatedError ||
              /timeout|aborted|took too long/i.test(message);

            if (!isRetry && retryable) {
              say(`    · profile call ${message} — retrying on half the passages`);
              continue;
            }
            say(`    · profile extraction failed: ${message}`);
            break;
          }
        }

        if (profile) break;
        if (providerIndex < profileChain.length - 1) {
          say(`    · profile came back empty on ${reader.name}, escalating`);
        }
      }
    }

    if (!attempt && !profile) {
      say(`    ✗ nothing extracted — needs manual verification`);
      return done({ failed: true });
    }

    /* --------------------------------------------------------- reporting */

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

    /* ---------------------------------------- cross-verification (opt-in) */

    // Only the cycle dates, and only when other sources are on file. A missed
    // deadline is a missed year, which is the one error here a student cannot
    // recover from — so it gets the budget, and coverage and eligibility do not.
    let fieldSources: FieldSources = {};
    const otherSources = verify ? sources : [];

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
      // worth seeing in the log — otherwise there is no way to tell whether the
      // pages were silent or the pipeline never asked.
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

    if (dryRun) {
      if (repairedUrl) {
        say(`    ↻ would re-point this row at ${repairedUrl} (dry run)`);
      }
      return done({ staged: true, repaired: null });
    }

    const sourcePage = pages.find((page) => page.url === bestSourceUrl) ?? pages[0]!;

    await store.stage({
      scholarship_id: target.id,
      source_url: bestSourceUrl,
      fetched_at: sourcePage.fetchedAt,
      page_sha256: sourcePage.sha256,
      model: `${attempt?.provider ?? provider.name}/${attempt?.model ?? provider.model}`,
      // One JSONB column, both halves. apply_extraction() reads whichever keys
      // are present and leaves the rest of the row alone.
      proposed: {
        ...cycle,
        ...(profile?.proposed ?? {}),
        // Only when something was actually cross-checked: an empty object would
        // make "nobody else was asked" look like "one source agreed".
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

    /**
     * Re-point the row, now that the extraction has vouched for the page.
     *
     * This is the ONE place the pipeline writes `official_portal_url`, and it
     * only does so when the old value returned 404 and the model confirmed the
     * replacement is this programme — reaching this line means either the cycle
     * or the profile call answered `page_is_about_requested_programme`. The
     * stale `source_url` is cleared in the same write: it is a page on a site
     * that just moved, so it is the next thing to 404, and `apply_extraction`
     * will set it again from this proposal anyway.
     */
    let repaired: string | null = null;
    if (repairedUrl && fixUrls) {
      try {
        await store.repoint(target.id, repairedUrl);
        say(`    ↻ row re-pointed at ${repairedUrl}`);
        repaired = repairedUrl;
      } catch (failure) {
        say(
          `    ! could not save the repaired URL: ${failure instanceof Error ? failure.message : failure}`,
        );
      }
    } else if (repairedUrl) {
      say(`    ↻ live page found at ${repairedUrl} — not saved (URL repair is off)`);
    }

    say(`    ✓ staged for review`);
    return done({ staged: true, repaired });
  } catch (failure) {
    // A day-scale quota stops the whole run; the caller handles that. Anything
    // else is this programme's problem alone.
    if (failure instanceof DailyLimitError) throw failure;
    say(`    ✗ ${failure instanceof Error ? failure.message : String(failure)}`);
    return done({ failed: true });
  }
}
