/**
 * Does the evidence still say what we stored?
 *
 * Every value in the catalogue was kept because a quote was found on a page.
 * This re-fetches that page today and re-runs the project's own matcher —
 * `findQuote()` from scripts/extract/quote.ts, against `normalise()`d text from
 * scripts/extract/page.ts — over every grounded quote in every extraction.
 *
 * No model is called. This is a string search, which is the whole point: the
 * rule is checkable without asking anything to be clever.
 *
 * A quote can stop matching for three different reasons and they are not the
 * same finding:
 *
 *   gone        the page no longer contains it. Either the funder changed the
 *               page (the value may now be wrong) or the quote was never
 *               reproducible (the control failed).
 *   downgraded  it matched exactly when stored and only loosely now, or the
 *               reverse. Wording moved; the fact probably stands.
 *   unreachable the page 404s, is blocked by robots.txt, or is a shell we
 *               cannot read today. Says nothing about the quote.
 *
 *   node --env-file=.env.local scripts/audit/quote-drift.ts
 */

import { fetchPage, normalise } from "../extract/page.ts";
import { findQuote, type QuotePage } from "../extract/quote.ts";
import { AS_OF, pct, supabaseAdmin, writeEvidence } from "./lib.ts";

interface Check {
  extraction_id: string;
  scholarship_id: string;
  scholarship_title: string;
  field: string;
  stored_match: string | null;
  page_url: string;
  verdict: "exact" | "loose" | "gone" | "unreachable";
  reason?: string;
  quote_chars: number;
}

async function main() {
  const supabase = supabaseAdmin();

  const [{ data: extractions, error }, { data: scholarships }] = await Promise.all([
    supabase
      .from("scholarship_extractions")
      .select("id, scholarship_id, source_url, fetched_at, page_sha256, status, evidence")
      .order("created_at", { ascending: true }),
    supabase.from("scholarships").select("id, title"),
  ]);
  if (error) throw error;

  const titles = new Map((scholarships ?? []).map((s: any) => [s.id, s.title]));
  const rows = extractions ?? [];
  console.log(`\nRe-checking ${rows.length} extractions, as of ${AS_OF}\n`);

  // One fetch per distinct page, shared across every quote that cites it. The
  // fetch layer already caches per-run and holds one request per host per
  // 800ms; this map just keeps the failures too, so a dead page is reported
  // once rather than retried per quote.
  const pages = new Map<string, QuotePage | { error: string }>();

  async function pageFor(url: string): Promise<QuotePage | { error: string }> {
    const seen = pages.get(url);
    if (seen) return seen;
    let result: QuotePage | { error: string };
    try {
      const fetched = await fetchPage(url);
      result = {
        url: fetched.url,
        text: normalise(fetched.text),
        ...(fetched.viaOcr ? { viaOcr: true } : {}),
      };
      console.log(`  fetched ${url} (${fetched.text.length} chars)`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      result = { error: message };
      console.log(`  UNREACHABLE ${url} — ${message.slice(0, 90)}`);
    }
    pages.set(url, result);
    return result;
  }

  const checks: Check[] = [];
  const pageChanged: Record<string, boolean> = {};

  for (const ext of rows) {
    const evidence = (ext.evidence ?? {}) as Record<string, any>;
    const grounded = Object.entries(evidence).filter(
      ([, e]) => e && e.grounded === true && typeof e.quote === "string" && e.quote.length > 0,
    );
    if (grounded.length === 0) continue;

    for (const [field, e] of grounded) {
      const url = e.source_url ?? ext.source_url;
      if (!url) continue;
      const page = await pageFor(url);

      if ("error" in page) {
        checks.push({
          extraction_id: ext.id,
          scholarship_id: ext.scholarship_id,
          scholarship_title: titles.get(ext.scholarship_id) ?? "(row deleted)",
          field,
          stored_match: e.match ?? null,
          page_url: url,
          verdict: "unreachable",
          reason: page.error.slice(0, 200),
          quote_chars: e.quote.length,
        });
        continue;
      }

      const match = findQuote([page], e.quote);
      checks.push({
        extraction_id: ext.id,
        scholarship_id: ext.scholarship_id,
        scholarship_title: titles.get(ext.scholarship_id) ?? "(row deleted)",
        field,
        stored_match: e.match ?? null,
        page_url: url,
        verdict: match ? (match.exact ? "exact" : "loose") : "gone",
        quote_chars: e.quote.length,
      });
    }

    // Did the page change at all since the extraction was taken?
    const page = pages.get(ext.source_url);
    if (page && !("error" in page)) pageChanged[ext.source_url] ??= true;
  }

  /* ---------------------------------------------------------------------- */
  /* Report                                                                 */
  /* ---------------------------------------------------------------------- */

  const checkable = checks.filter((c) => c.verdict !== "unreachable");
  const tally = (list: Check[], v: Check["verdict"]) => list.filter((c) => c.verdict === v).length;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`QUOTES CHECKED     ${checks.length} across ${pages.size} distinct pages`);
  console.log(`  unreachable      ${tally(checks, "unreachable")} (page gone or blocked — no verdict)`);
  console.log(`  still on page    ${tally(checks, "exact") + tally(checks, "loose")} of ${checkable.length} checkable  ${pct(tally(checks, "exact") + tally(checks, "loose"), checkable.length)}`);
  console.log(`    exact          ${tally(checks, "exact")}`);
  console.log(`    loose only     ${tally(checks, "loose")}`);
  console.log(`  GONE             ${tally(checks, "gone")}  ${pct(tally(checks, "gone"), checkable.length)}`);

  const byField: Record<string, Record<string, number>> = {};
  for (const c of checks) {
    byField[c.field] ??= { exact: 0, loose: 0, gone: 0, unreachable: 0 };
    byField[c.field][c.verdict] += 1;
  }
  console.log("\nBY FIELD                       exact  loose   gone  unreachable");
  for (const [field, t] of Object.entries(byField).sort((a, b) => b[1].gone - a[1].gone)) {
    console.log(
      `  ${field.padEnd(28)} ${String(t.exact).padStart(5)} ${String(t.loose).padStart(6)} ` +
        `${String(t.gone).padStart(6)} ${String(t.unreachable).padStart(12)}`,
    );
  }

  const downgraded = checks.filter((c) => c.stored_match === "exact" && c.verdict === "loose");
  console.log(`\nStored exact, now loose only: ${downgraded.length}`);

  const gone = checks.filter((c) => c.verdict === "gone");
  if (gone.length > 0) {
    console.log("\nQUOTES NO LONGER ON THEIR PAGE");
    for (const c of gone.slice(0, 40)) {
      console.log(`  ${c.scholarship_title} · ${c.field} · ${c.page_url}`);
    }
    if (gone.length > 40) console.log(`  … and ${gone.length - 40} more`);
  }

  writeEvidence("quote-drift.json", {
    as_of: AS_OF,
    method:
      "Each grounded quote in scholarship_extractions.evidence re-checked with findQuote() " +
      "against a fresh fetch of the page it cites. No model involved.",
    extractions: rows.length,
    distinct_pages: pages.size,
    totals: {
      checked: checks.length,
      checkable: checkable.length,
      exact: tally(checks, "exact"),
      loose: tally(checks, "loose"),
      gone: tally(checks, "gone"),
      unreachable: tally(checks, "unreachable"),
      stored_exact_now_loose: downgraded.length,
    },
    by_field: byField,
    checks,
  });
}

await main();
