import { classifyAuthority, type Authority } from "../discover/authority.ts";
import { crawlProgramme } from "./crawl.ts";
import { extractCycle } from "./extract.ts";
import { groundExtraction, isEmpty } from "./ground.ts";
import { selectPassages } from "./passages.ts";
import type { ExtractionProvider } from "./providers/index.ts";
import {
  describeConflict,
  reconcileField,
  type Reconciled,
  type SourcedValue,
} from "./reconcile.ts";
import type { FieldSource, FieldSources } from "../../src/lib/types/database.ts";

/**
 * Reading a programme from more than one site, and recording who said what.
 *
 * SCOPE, AND WHY IT IS NARROW. Only the cycle fields — the label, the opening
 * date and the closing date — are cross-verified. Not coverage, not
 * eligibility, not the document list.
 *
 * That is a cost decision made honestly. Each extra source is a full crawl plus
 * a model call, extraction already runs about five minutes a programme, and the
 * free tier allows fifteen requests a minute. Verifying everything would
 * multiply a slow pipeline by the number of sources. The deadline is where
 * being wrong actually costs a student something they cannot recover — a missed
 * date is a missed year — so that is what gets the budget.
 *
 * The profile fields still benefit from secondary sources, just not through
 * this path: a second site that states a stipend the funder omits is read by
 * the ordinary extraction when that source is crawled.
 */

export interface VerificationSource {
  url: string;
  authority: Authority;
}

export interface VerifiedCycle {
  cycle_label: Reconciled<string>;
  opens_date: Reconciled<string>;
  deadline_date: Reconciled<string>;
  /** Reviewer-facing lines for every field whose sources disagreed. */
  caveats: string[];
  /** Sources actually read, for the run log. */
  consulted: VerificationSource[];
  /** Provenance to store on the row. */
  fieldSources: FieldSources;
}

/** One source's grounded reading of the cycle. */
interface Reading {
  url: string;
  authority: Authority;
  cycle_label: { value: string | null; quote: string | null };
  opens_date: { value: string | null; quote: string | null };
  deadline_date: { value: string | null; quote: string | null };
}

const CYCLE_FIELDS = ["cycle_label", "opens_date", "deadline_date"] as const;
type CycleField = (typeof CYCLE_FIELDS)[number];

export interface VerifyOptions {
  provider: ExtractionProvider;
  title: string;
  country: string;
  /** The programme's own site, for tiering every other source against it. */
  funderUrl: string;
  /** Extra sources, strongest first. Already filtered for `muted`. */
  sources: VerificationSource[];
  /** Sources to actually read. Each one is a crawl plus a model call. */
  maxSources?: number;
  /** Characters of context per source. */
  budgetChars: number;
  /** Pages crawled per source — smaller than a primary crawl on purpose. */
  maxPages?: number;
  say?: (line: string) => void;
}

/**
 * Reads the primary reading plus up to `maxSources` others, and reconciles.
 *
 * `primary` is the funder's own extraction, already grounded. It is passed in
 * rather than re-read because the caller has just done that work, and because
 * a second crawl of the same site would be answered from the page cache
 * anyway — but the model call would not.
 */
export async function verifyCycle(
  primary: {
    url: string;
    cycle_label: string | null;
    opens_date: string | null;
    deadline_date: string | null;
    quotes: Partial<Record<CycleField, string | null>>;
  },
  options: VerifyOptions,
): Promise<VerifiedCycle> {
  const say = options.say ?? (() => {});
  const maxSources = options.maxSources ?? 2;

  const readings: Reading[] = [
    {
      url: primary.url,
      authority: classifyAuthority(primary.url, { funderUrl: options.funderUrl }),
      cycle_label: { value: primary.cycle_label, quote: primary.quotes.cycle_label ?? null },
      opens_date: { value: primary.opens_date, quote: primary.quotes.opens_date ?? null },
      deadline_date: {
        value: primary.deadline_date,
        quote: primary.quotes.deadline_date ?? null,
      },
    },
  ];

  const consulted: VerificationSource[] = [];

  // Strongest sources first: if the budget only allows two, they should be the
  // two most worth believing, not the two discovery happened to find first.
  const ordered = [...options.sources].sort(
    (a, b) =>
      (a.authority === "official" ? 0 : 1) - (b.authority === "official" ? 0 : 1),
  );

  for (const source of ordered.slice(0, maxSources)) {
    try {
      const crawled = await crawlProgramme(source.url, {
        // A secondary source is read for its dates, not surveyed. Four pages is
        // enough to reach a linked timeline and cheap enough to afford.
        maxPages: options.maxPages ?? 4,
        titleHint: options.title,
      });
      if (crawled.pages.length === 0) {
        say(`    · second source unreachable: ${source.url}`);
        continue;
      }

      const passages = selectPassages(crawled.pages, options.budgetChars, ["dates"]);
      if (passages.length === 0) {
        say(`    · second source says nothing about dates: ${source.url}`);
        continue;
      }

      const result = await extractCycle(
        options.provider,
        options.title,
        options.country,
        passages,
      );

      // A source that is not about this programme is worse than no source: it
      // would contribute a confident value about something else entirely.
      if (!result.extraction.page_is_about_requested_programme) {
        say(`    · second source is about something else: ${source.url}`);
        continue;
      }

      // Grounded against ITS OWN pages. A quote from one site can never be
      // validated against another's text.
      const grounded = groundExtraction(result.extraction, crawled.pages, source.url);
      if (isEmpty(grounded)) {
        say(`    · second source had no grounded dates: ${source.url}`);
        continue;
      }

      consulted.push(source);
      readings.push({
        url: source.url,
        authority: source.authority,
        cycle_label: {
          value: grounded.proposed.cycle_label,
          quote: grounded.evidence.cycle_label?.quote ?? null,
        },
        opens_date: {
          value: grounded.proposed.opens_date,
          quote: grounded.evidence.opens_date?.quote ?? null,
        },
        deadline_date: {
          value: grounded.proposed.deadline_date,
          quote: grounded.evidence.deadline_date?.quote ?? null,
        },
      });

      say(`    · read ${source.authority} source ${source.url}`);
    } catch (error) {
      // A second opinion is a bonus. Failing to get one must never cost the
      // reading we already have.
      say(
        `    · second source failed (${source.url}): ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const caveats: string[] = [];
  const fieldSources: FieldSources = {};
  const reconciled = {} as Record<CycleField, Reconciled<string>>;

  for (const field of CYCLE_FIELDS) {
    const claims: SourcedValue<string>[] = readings
      .filter((reading) => reading[field].value !== null)
      .map((reading) => ({
        value: reading[field].value as string,
        quote: reading[field].quote,
        sourceUrl: reading.url,
        authority: reading.authority,
      }));

    const result = reconcileField(claims);
    reconciled[field] = result;

    const conflict = describeConflict(field, result);
    if (conflict) caveats.push(conflict);

    // Recorded only when a value exists AND more than one source was in play.
    // Writing provenance for a single-source field would make "nobody else has
    // been asked" look like "one source agreed".
    if (result.value !== null && result.authority) {
      const hasOtherOpinions =
        result.corroboratedBy.length > 0 || result.conflicts.length > 0;
      if (hasOtherOpinions || result.authority !== "funder") {
        const entry: FieldSource = {
          authority: result.authority,
          source_url: result.sourceUrl,
        };
        if (result.corroboratedBy.length > 0) entry.corroborated_by = result.corroboratedBy;
        if (result.conflicts.length > 0) entry.conflicts = result.conflicts;
        fieldSources[field] = entry;
      }
    }
  }

  return {
    cycle_label: reconciled.cycle_label,
    opens_date: reconciled.opens_date,
    deadline_date: reconciled.deadline_date,
    caveats,
    consulted,
    fieldSources,
  };
}
