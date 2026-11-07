/**
 * The 20-record hand check: build the dossiers, then a person reads them.
 *
 * Nothing here decides whether a value is right. It assembles, for a seeded
 * random sample of programmes, what the catalogue claims beside what the
 * funder's page says today — so the judgement is made against the page rather
 * than against the model's own summary of it.
 *
 * The sample is seeded (mulberry32, seed 20261030) so the audit can be re-run
 * and argued with.
 *
 *   node --env-file=.env.local scripts/audit/sample-dossiers.ts
 */

import { fetchPage, normalise } from "../extract/page.ts";
import { findQuote } from "../extract/quote.ts";
import { AS_OF, supabaseAdmin, writeEvidence } from "./lib.ts";

const SEED = 20_261_030;
const SAMPLE_SIZE = 20;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: T[], size: number, seed: number): T[] {
  const random = mulberry32(seed);
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, size);
}

/** Lines of the page that mention a term, so a reader can judge in context. */
function mentions(text: string, terms: string[], limit = 6): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const term of terms) {
    let from = 0;
    while (out.length < limit) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      out.push(text.slice(Math.max(0, at - 110), at + 170).replace(/\s+/g, " ").trim());
      from = at + term.length;
    }
  }
  return [...new Set(out)].slice(0, limit);
}

const NATIONALITY_TERMS = [
  "indonesia",
  "nationals of",
  "citizens of",
  "eligible countries",
  "permanent resident",
  "u.s. citizen",
  "us citizen",
  "open to",
  "who can apply",
  "eligibility",
];

async function main() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase.from("scholarships").select("*");
  if (error) throw error;
  const rows = data ?? [];

  const picked = sample(rows as any[], SAMPLE_SIZE, SEED);
  console.log(
    `\nHAND-CHECK SAMPLE — ${picked.length} of ${rows.length} programmes ` +
      `(${Math.round((100 * picked.length) / rows.length)}% of the catalogue), seed ${SEED}, as of ${AS_OF}\n`,
  );

  const dossiers = [];

  for (const row of picked) {
    const url = row.source_url ?? row.official_portal_url;
    console.log(`\n${"=".repeat(78)}\n${row.title}\n  ${url}`);

    let page: { url: string; text: string } | null = null;
    let fetchError: string | undefined;
    try {
      const fetched = await fetchPage(url);
      page = { url: fetched.url, text: normalise(fetched.text) };
    } catch (cause) {
      fetchError = cause instanceof Error ? cause.message : String(cause);
      console.log(`  PAGE UNREADABLE: ${fetchError.slice(0, 110)}`);
    }

    // The stored quotes for this row, and whether the page still carries them.
    const { data: extractions } = await supabase
      .from("scholarship_extractions")
      .select("evidence, fetched_at, model, status")
      .eq("scholarship_id", row.id)
      .eq("status", "applied")
      .order("created_at", { ascending: false })
      .limit(1);

    const evidence = (extractions?.[0]?.evidence ?? {}) as Record<string, any>;
    const quotes: Record<string, { quote: string; still_on_page: boolean | null }> = {};
    for (const [field, e] of Object.entries(evidence)) {
      if (!e?.grounded || typeof e.quote !== "string") continue;
      quotes[field] = {
        quote: e.quote,
        still_on_page: page ? Boolean(findQuote([page], e.quote)) : null,
      };
    }

    const dossier = {
      id: row.id,
      title: row.title,
      country: row.country,
      url,
      page_readable: Boolean(page),
      page_error: fetchError,
      page_chars: page?.text.length ?? 0,
      last_extraction: extractions?.[0]
        ? { fetched_at: extractions[0].fetched_at, model: extractions[0].model }
        : null,
      claims: {
        deadline_date: row.deadline_date,
        opens_date: row.opens_date,
        cycle_label: row.cycle_label,
        award_duration: row.award_duration,
        number_of_awards: row.number_of_awards,
        degree_levels: row.degree_levels,
        fields_of_study: row.fields_of_study,
        coverage_matrix: row.coverage_matrix,
        restricted_to_nationalities: row.eligibility_flags?.restricted_to_nationalities,
        language_test_required: row.eligibility_flags?.language_test_required,
        min_work_experience_years: row.eligibility_flags?.min_work_experience_years,
        max_age: row.eligibility_flags?.max_age,
        verification_status: row.verification_status,
        last_verified_at: row.last_verified_at,
      },
      stored_quotes: quotes,
      page_says_about_eligibility: page ? mentions(page.text, NATIONALITY_TERMS) : [],
    };

    dossiers.push(dossier);

    const kept = Object.values(quotes).filter((q) => q.still_on_page === true).length;
    console.log(
      `  claims: deadline=${row.deadline_date ?? "—"} opens=${row.opens_date ?? "—"} ` +
        `cycle=${row.cycle_label ?? "—"} status=${row.verification_status}`,
    );
    console.log(`  quotes: ${kept}/${Object.keys(quotes).length} still on the page`);
    console.log(`  nationality stored: ${JSON.stringify(row.eligibility_flags?.restricted_to_nationalities)}`);
  }

  writeEvidence("hand-check-dossiers.json", {
    as_of: AS_OF,
    seed: SEED,
    sample_size: picked.length,
    catalogue_size: rows.length,
    note:
      "Assembled for a human to read. Verdicts are recorded in the audit report, " +
      "not here — this file is the material the verdicts were formed from.",
    dossiers,
  });
}

await main();
