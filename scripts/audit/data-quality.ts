/**
 * What is actually in the catalogue, counted three ways.
 *
 * Completeness here is NOT "is the column null". The schema distinguishes a
 * field the pages were read for and do not state (`not_stated`, migration 016)
 * from a field nobody has read, and collapsing those two is the specific
 * mistake the whole project is built to avoid. So every field is reported as
 * filled / stated-as-absent / never-read.
 *
 *   node --env-file=.env.local scripts/audit/data-quality.ts
 */

import { AS_OF, daysBetween, pct, supabaseAdmin, writeEvidence } from "./lib.ts";
import { COVERAGE_KEYS } from "../../src/lib/types/database.ts";

const ELIGIBILITY_KEYS = [
  "max_age",
  "min_gpa_4_scale",
  "min_work_experience_years",
  "language_test_required",
  "accepted_language_tests",
  "min_toefl_ibt",
  "min_ielts",
  "requires_university_admission_first",
  "requires_government_nomination",
  "requires_research_proposal",
  "restricted_to_nationalities",
] as const;

/** Columns a student reads off the page, in the order the UI shows them. */
const TOP_LEVEL_FIELDS = [
  "title",
  "country",
  "degree_levels",
  "official_portal_url",
  "source_url",
  "opens_date",
  "deadline_date",
  "cycle_label",
  "timeline",
  "coverage_matrix",
  "eligibility_flags",
  "document_checklist",
  "post_study_obligations",
  "language_training_included",
  "fields_of_study",
  "award_duration",
  "number_of_awards",
  "field_sources",
] as const;

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

type Row = Record<string, any>;

async function main() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase.from("scholarships").select("*");
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  const n = rows.length;

  console.log(`\nScholarTrack data quality — ${n} programmes, as of ${AS_OF}\n`);

  /* ---------------------------------------------------------------------- */
  /* Completeness, three-valued                                             */
  /* ---------------------------------------------------------------------- */

  const completeness: Record<string, { filled: number; notStated: number; unread: number }> = {};

  const score = (key: string, filled: (r: Row) => boolean) => {
    let f = 0;
    let s = 0;
    for (const r of rows) {
      if (filled(r)) f += 1;
      else if ((r.not_stated ?? []).includes(key)) s += 1;
    }
    completeness[key] = { filled: f, notStated: s, unread: n - f - s };
  };

  for (const key of TOP_LEVEL_FIELDS) score(key, (r) => isFilled(r[key]));
  for (const key of COVERAGE_KEYS) {
    score(`coverage_matrix.${key}`, (r) => r.coverage_matrix?.[key] !== undefined);
  }
  for (const key of ELIGIBILITY_KEYS) {
    // Key present with null is "read, and the page says nothing" — a real
    // answer, not a blank. Only an ABSENT key means nobody asked.
    score(`eligibility_flags.${key}`, (r) => r.eligibility_flags?.[key] !== undefined);
  }

  console.log("FIELD                                 FILLED      NOT STATED   NEVER READ");
  for (const [key, c] of Object.entries(completeness)) {
    console.log(
      `${key.padEnd(36)} ${String(c.filled).padStart(3)} ${pct(c.filled, n).padStart(5)}  ` +
        `${String(c.notStated).padStart(3)} ${pct(c.notStated, n).padStart(5)}  ` +
        `${String(c.unread).padStart(3)} ${pct(c.unread, n).padStart(5)}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Staleness — twice, because the two readings differ sharply              */
  /* ---------------------------------------------------------------------- */

  const bucket = (subset: Row[]) => {
    const out = { never: 0, under30: 0, over30: 0, over60: 0, over90: 0 };
    for (const r of subset) {
      if (!r.last_verified_at) {
        out.never += 1;
        continue;
      }
      const age = daysBetween(r.last_verified_at, AS_OF);
      if (age > 90) out.over90 += 1;
      else if (age > 60) out.over60 += 1;
      else if (age > 30) out.over30 += 1;
      else out.under30 += 1;
    }
    return out;
  };

  const asStored = bucket(rows);
  const humanChecked = bucket(rows.filter((r) => r.verification_status === "verified"));

  console.log("\nSTALENESS (last_verified_at, which apply_extraction sets to the CRAWL time)");
  console.log(` ${JSON.stringify(asStored)}`);
  console.log("STALENESS among rows a human actually verified (verification_status='verified')");
  console.log(` ${JSON.stringify(humanChecked)}`);

  /* ---------------------------------------------------------------------- */
  /* Deadlines                                                              */
  /* ---------------------------------------------------------------------- */

  const withDeadline = rows.filter((r) => r.deadline_date);
  const past = withDeadline.filter((r) => r.deadline_date < AS_OF);
  const future = withDeadline.filter((r) => r.deadline_date >= AS_OF);

  console.log(
    `\nDEADLINES  set ${withDeadline.length}/${n}  ·  past ${past.length}  ·  still open ${future.length}  ·  none ${n - withDeadline.length}`,
  );
  for (const r of past) {
    console.log(
      `  past: ${r.deadline_date}  (${daysBetween(r.deadline_date, AS_OF)}d ago)  ` +
        `cycle_label=${r.cycle_label ?? "—"}  ${r.title}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Status, provenance, hosts                                              */
  /* ---------------------------------------------------------------------- */

  const statuses: Record<string, number> = {};
  for (const r of rows) statuses[r.verification_status] = (statuses[r.verification_status] ?? 0) + 1;

  const hosts: Record<string, number> = {};
  for (const r of rows) {
    for (const url of [r.source_url, r.official_portal_url]) {
      if (!url) continue;
      try {
        const host = new URL(url).host;
        hosts[host] = (hosts[host] ?? 0) + 1;
      } catch {
        hosts[`UNPARSEABLE:${url}`] = (hosts[`UNPARSEABLE:${url}`] ?? 0) + 1;
      }
    }
  }

  const withFieldSources = rows.filter((r) => isFilled(r.field_sources)).length;
  const restricted = rows.filter(
    (r) => Array.isArray(r.eligibility_flags?.restricted_to_nationalities),
  );

  console.log(`\nSTATUS ${JSON.stringify(statuses)}`);
  console.log(`FIELD_SOURCES populated on ${withFieldSources}/${n} rows`);
  console.log(`restricted_to_nationalities stated on ${restricted.length}/${n} rows`);
  console.log(`DISTINCT HOSTS ${Object.keys(hosts).length}`);

  writeEvidence("data-quality.json", {
    as_of: AS_OF,
    programmes: n,
    completeness,
    staleness: { as_stored: asStored, human_verified_only: humanChecked },
    deadlines: {
      set: withDeadline.length,
      past: past.length,
      open: future.length,
      none: n - withDeadline.length,
      past_rows: past.map((r) => ({
        id: r.id,
        title: r.title,
        deadline_date: r.deadline_date,
        days_ago: daysBetween(r.deadline_date, AS_OF),
        cycle_label: r.cycle_label,
      })),
    },
    verification_status: statuses,
    field_sources_populated: withFieldSources,
    nationality_restriction_stated: restricted.length,
    hosts,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      country: r.country,
      verification_status: r.verification_status,
      last_verified_at: r.last_verified_at,
      deadline_date: r.deadline_date,
      source_url: r.source_url,
      official_portal_url: r.official_portal_url,
      not_stated_count: (r.not_stated ?? []).length,
      restricted_to_nationalities: r.eligibility_flags?.restricted_to_nationalities ?? undefined,
    })),
  });
}

await main();
