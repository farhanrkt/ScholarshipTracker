/**
 * How much of the catalogue is the same programme listed twice.
 *
 * Uses the app's own detector — `findDuplicates()` from src/lib/duplicates.ts,
 * the one behind /admin/duplicates — so the audit reports what a reviewer would
 * actually be shown, not a second opinion from a different algorithm.
 *
 *   node --env-file=.env.local scripts/audit/duplicates.ts
 */

import { findDuplicates, type DuplicateRow } from "../../src/lib/duplicates.ts";
import { AS_OF, pct, supabaseAdmin, writeEvidence } from "./lib.ts";

async function main() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("scholarships")
    .select(
      "id, title, country, official_portal_url, verification_status, is_profiled, deadline_date, created_at",
    );
  if (error) throw error;

  const rows = (data ?? []) as DuplicateRow[];
  const clusters = findDuplicates(rows);
  const duplicated = clusters.reduce((total, c) => total + c.rows.length, 0);
  const redundant = clusters.reduce((total, c) => total + c.rows.length - 1, 0);

  console.log(`\nDUPLICATES — ${rows.length} programmes, as of ${AS_OF}\n`);
  console.log(
    `${clusters.length} clusters covering ${duplicated} rows ` +
      `(${pct(duplicated, rows.length)} of the catalogue); ` +
      `${redundant} rows would disappear if every cluster collapsed to one.`,
  );

  for (const cluster of clusters) {
    console.log(`\n[${cluster.confidence}] keep: ${cluster.suggestedKeep.title}`);
    for (const row of cluster.rows) {
      const mark = row.id === cluster.suggestedKeep.id ? "*" : " ";
      console.log(
        `  ${mark} ${row.title.padEnd(62)} ${row.verification_status.padEnd(12)} ` +
          `${row.deadline_date ?? "no deadline"}`,
      );
    }
    for (const pair of cluster.pairs) {
      console.log(`      ${pair.confidence}: ${pair.reason}`);
    }
  }

  writeEvidence("duplicates.json", {
    as_of: AS_OF,
    programmes: rows.length,
    clusters: clusters.length,
    rows_in_clusters: duplicated,
    rows_removable_if_merged: redundant,
    detail: clusters.map((c) => ({
      confidence: c.confidence,
      suggested_keep: c.suggestedKeep.title,
      rows: c.rows.map((r) => ({
        id: r.id,
        title: r.title,
        verification_status: r.verification_status,
        deadline_date: r.deadline_date,
        official_portal_url: r.official_portal_url,
      })),
      pairs: c.pairs.map((p) => ({ a: p.a.title, b: p.b.title, confidence: p.confidence, reason: p.reason })),
    })),
  });
}

await main();
