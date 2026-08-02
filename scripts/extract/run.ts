/**
 * ScholarTrack :: AI-assisted extraction
 *
 *   npm run extract -- --dry-run              # crawl + extract, write nothing
 *   npm run extract                            # stage proposals for review
 *   npm run extract -- --limit 3               # first three only
 *   npm run extract -- --title Chevening       # one programme by title match
 *   npm run extract -- --pages 20              # bigger crawl per programme
 *   npm run extract -- --dates-only            # skip the profile call
 *   npm run extract -- --provider anthropic    # force a provider
 *   npm run extract -- --escalate              # retry empties on the other provider
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
import { extractCycle, extractProfile } from "./extract.ts";
import {
  groundExtraction,
  groundProfile,
  isEmpty,
  isEmptyProfile,
  type GroundedExtraction,
  type GroundedProfile,
} from "./ground.ts";
import { FETCH_DELAY_MS } from "./page.ts";
import { selectPassages } from "./passages.ts";
import {
  DailyLimitError,
  listGeminiModels,
  listGroqModels,
  pickFallbackProvider,
  pickProvider,
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
    .limit(limit);

  if (titleFilter) query = query.ilike("title", `%${titleFilter}%`);

  const { data, error } = await query;
  if (error) throw new Error(`Could not load scholarships: ${error.message}`);

  const targets = (data ?? []) as Target[];
  if (targets.length === 0) {
    console.log("Nothing to extract — every matching row is already verified.");
    return;
  }

  console.log(
    `\n${targets.length} programme(s) · ${provider.name}/${provider.model}` +
      (fallback ? ` → escalates to ${fallback.name}/${fallback.model}` : "") +
      (datesOnly ? " · dates only" : "") +
      (dryRun ? " · DRY RUN" : "") +
      "\n",
  );

  let staged = 0;
  let failed = 0;
  const usage = new Map<string, { input: number; output: number }>();

  const record = (name: string, input: number, output: number) => {
    const current = usage.get(name) ?? { input: 0, output: 0 };
    usage.set(name, {
      input: current.input + input,
      output: current.output + output,
    });
  };

  for (const [index, target] of targets.entries()) {
    const entryUrl = target.source_url ?? target.official_portal_url;
    console.log(`[${index + 1}/${targets.length}] ${target.title}`);
    console.log(`    crawling from ${entryUrl}`);

    try {
      const { pages, errors, topicCounts } = await crawlProgramme(entryUrl, { maxPages });
      if (pages.length === 0) {
        throw new Error(errors[0]?.message ?? "crawl returned no readable pages");
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

      console.log(
        `    ${pages.length} page(s) [${describeCrawl(topicCounts)}], ${crawledChars.toLocaleString()} chars → ${datePassages.length}+${profilePassages.length} passage(s), ${keptChars.toLocaleString()} chars`,
      );
      for (const failure of errors) {
        console.log(`    · skipped ${failure.url}: ${failure.message}`);
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
          console.log(
            `    · cycle extraction failed on ${candidate.name}: ${failure instanceof Error ? failure.message : failure}`,
          );
          continue;
        }
        record(candidate.name, result.inputTokens, result.outputTokens);

        if (!result.extraction.page_is_about_requested_programme) {
          console.log(`    ✗ wrong site — model saw: ${result.extraction.page_subject}`);
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
          console.log(`    · ${candidate.name} found nothing, escalating`);
        }
      }

      if (wrongSite) {
        failed++;
        continue;
      }

      /* --------------------------------------------- call 2: the profile */

      // Best-effort by design: a profile that fails to parse, gets truncated,
      // or comes back empty must not cost us the deadline we already have.
      let profile: GroundedProfile | null = null;
      let profileNotes: string | null = null;

      if (profilePassages.length > 0) {
        const runner = chain.find((candidate) => candidate.name === attempt?.provider) ?? provider;
        try {
          const result = await extractProfile(
            runner,
            target.title,
            target.country,
            profilePassages,
          );
          record(runner.name, result.inputTokens, result.outputTokens);

          if (result.extraction.page_is_about_requested_programme) {
            const groundedProfile = groundProfile(result.extraction, pages);
            profileNotes = result.extraction.notes_for_reviewer || null;
            if (!isEmptyProfile(groundedProfile)) profile = groundedProfile;
          } else {
            console.log(`    · profile call read the wrong programme, dropped`);
          }
        } catch (failure) {
          if (failure instanceof DailyLimitError) throw failure;
          console.log(
            `    · profile extraction failed: ${failure instanceof Error ? failure.message : failure}`,
          );
        }
      }

      if (!attempt && !profile) {
        failed++;
        console.log(`    ✗ nothing extracted — needs manual verification`);
        continue;
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

      for (const failure of ungrounded) console.log(`    ⚠ dropped ${failure}`);
      for (const caveat of caveats) console.log(`    ! ${caveat}`);

      if (attempt && isEmpty(attempt.grounded) && !profile) {
        console.log(`    ✗ no grounded dates found — needs manual verification`);
        failed++;
        continue;
      }

      const cycle = attempt?.grounded.proposed ?? {
        cycle_label: null,
        opens_date: null,
        deadline_date: null,
        timeline: [],
      };

      console.log(
        `    → opens ${cycle.opens_date ?? "—"} · closes ${cycle.deadline_date ?? "—"} · ${cycle.timeline.length} stage(s)` +
          (attempt ? `  [${attempt.provider}]` : "  [no cycle]"),
      );
      if (profile) {
        const { coverage_matrix, eligibility_flags, document_checklist } = profile.proposed;
        console.log(
          `    → ${Object.keys(coverage_matrix).length} coverage line(s) · ${Object.keys(eligibility_flags).length} eligibility field(s) · ${document_checklist.length} document(s)`,
        );
      }

      const bestSourceUrl = attempt?.grounded.bestSourceUrl ?? entryUrl;
      console.log(`    source: ${bestSourceUrl}`);

      const notes = [attempt?.extraction.notes_for_reviewer, profileNotes]
        .filter((note): note is string => Boolean(note && note.trim()))
        .join(" · ");
      if (notes) console.log(`    note: ${notes}`);

      if (dryRun) {
        staged++;
        continue;
      }

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
          proposed: { ...cycle, ...(profile?.proposed ?? {}) },
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

      console.log(`    ✓ staged for review`);
      staged++;
    } catch (failure) {
      // Not recoverable within this run — stop so the staged rows are
      // reported instead of every remaining programme failing identically.
      if (failure instanceof DailyLimitError) throw failure;
      console.log(
        `    ✗ ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      failed++;
    }

    if (index < targets.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
    }
  }

  console.log(`\n${staged} staged · ${failed} failed`);
  for (const [name, tokens] of usage) {
    const cost =
      name === "anthropic"
        ? ` · ~$${((tokens.input / 1e6) * 5 + (tokens.output / 1e6) * 25).toFixed(3)}`
        : " · free tier";
    console.log(
      `  ${name}: ${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out${cost}`,
    );
  }

  if (staged > 0 && !dryRun) {
    console.log(`\nReview at /admin/review, or:`);
    console.log(`  select * from extraction_review;`);
    console.log(`  select apply_extraction('<extraction_id>');\n`);
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
