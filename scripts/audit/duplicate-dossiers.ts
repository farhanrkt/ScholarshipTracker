/**
 * The funder's own words for every row the duplicate detector grouped.
 *
 * `scripts/audit/duplicates.ts` reports what the detector THINKS; this fetches
 * the pages so a person can decide. The detector compares a title and a host
 * and says so plainly — it cannot know whether `Chevening SIDS Scholarship` is
 * a second name for the main award or a different award with its own
 * eligibility, and no string comparison ever will.
 *
 * Deciding that needs the page, so this writes one dossier per row and the
 * verdicts go in docs/duplicate-verdicts.md with a quote against each.
 *
 *   node --env-file=.env.local scripts/audit/duplicate-dossiers.ts [outDir]
 *
 * Read-only, and every fetch goes through `scripts/extract/page.ts`, so
 * robots.txt, the per-host delay and the declared UA all apply.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { fetchPage, HttpError } from "../extract/page.ts";
import { findDuplicates, type DuplicateRow } from "../../src/lib/duplicates.ts";
import { AS_OF, supabaseAdmin, writeEvidence } from "./lib.ts";

const OUT_DIR = process.argv[2] ?? `${AS_OF}-duplicate-pages`;

/** Short, stable, and sorts next to its cluster-mates. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}

async function main() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("scholarships")
    .select(
      "id, title, country, official_portal_url, verification_status, is_profiled, deadline_date, created_at",
    );
  if (error) throw error;

  const clusters = findDuplicates((data ?? []) as DuplicateRow[]);
  mkdirSync(OUT_DIR, { recursive: true });

  const fetched: Array<Record<string, unknown>> = [];

  for (const [index, cluster] of clusters.entries()) {
    console.log(`\n--- cluster ${index + 1} [${cluster.confidence}] ---`);

    for (const row of cluster.rows) {
      // Sequential on purpose: the fetch layer's delay is per host and every
      // row in a cluster shares one, so parallelism here would only queue.
      try {
        const page = await fetchPage(row.official_portal_url);
        // The evidence file records the NAME, not the path: the dossiers are
        // read once and thrown away, usually into a temp directory, and a
        // recorded absolute path would be a dangling reference by the time
        // anyone checked the JSON against the repo.
        const name = `${index + 1}-${slug(row.title)}.txt`;
        writeFileSync(
          `${OUT_DIR}/${name}`,
          [
            `title:  ${row.title}`,
            `id:     ${row.id}`,
            `url:    ${page.url}`,
            `sha256: ${page.sha256}`,
            `read:   ${page.fetchedAt}`,
            page.viaOcr ? "note:   text came from OCR" : "",
            "",
            page.text,
            "",
          ].join("\n"),
        );

        console.log(`  ok    ${row.title} → ${name} (${page.text.length} chars)`);
        fetched.push({
          cluster: index + 1,
          id: row.id,
          title: row.title,
          url: row.official_portal_url,
          final_url: page.url,
          sha256: page.sha256,
          chars: page.text.length,
          file: name,
        });
      } catch (caught) {
        const why =
          caught instanceof HttpError
            ? `HTTP ${caught.status}`
            : caught instanceof Error
              ? caught.message
              : String(caught);

        console.log(`  FAIL  ${row.title} — ${why}`);
        fetched.push({
          cluster: index + 1,
          id: row.id,
          title: row.title,
          url: row.official_portal_url,
          error: why,
        });
      }
    }
  }

  writeEvidence("duplicate-dossiers.json", {
    as_of: AS_OF,
    read_at: new Date().toISOString(),
    clusters: clusters.length,
    pages: fetched.length,
    failed: fetched.filter((page) => page.error).length,
    detail: fetched,
  });
}

await main();
