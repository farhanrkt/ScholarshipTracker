/**
 * Which of the major fully-funded programmes open to Indonesians do we hold?
 *
 * The candidate list is the one in the audit brief. Matching is on the
 * catalogue's own titles and source hosts, deliberately generous — a loose
 * match that turns out to be a different award is a better audit outcome than
 * silently reporting a gap that is not there.
 *
 *   node --env-file=.env.local scripts/audit/coverage.ts
 */

import { AS_OF, supabaseAdmin, writeEvidence } from "./lib.ts";

interface Candidate {
  name: string;
  /** Lowercase substrings; any one of them matching a title counts. */
  titleHints: string[];
  /** Host fragments that would also identify it. */
  hostHints?: string[];
}

const CANDIDATES: Candidate[] = [
  { name: "LPDP (Indonesia Endowment Fund for Education)", titleHints: ["lpdp"], hostHints: ["lpdp."] },
  { name: "Chevening", titleHints: ["chevening"], hostHints: ["chevening.org"] },
  { name: "Fulbright", titleHints: ["fulbright"], hostHints: ["fulbright"] },
  { name: "Australia Awards", titleHints: ["australia award"], hostHints: ["australiaawards"] },
  { name: "DAAD (Germany)", titleHints: ["daad"], hostHints: ["daad.de"] },
  { name: "MEXT (Japan)", titleHints: ["mext", "monbukagakusho"], hostHints: ["studyinjapan", "mext.go.jp"] },
  { name: "GKS / KGSP (Korea)", titleHints: ["global korea", "gks", "kgsp"], hostHints: ["studyinkorea"] },
  { name: "Erasmus Mundus", titleHints: ["erasmus"], hostHints: ["erasmus"] },
  { name: "Swedish Institute", titleHints: ["swedish institute"], hostHints: ["si.se"] },
  { name: "Commonwealth Scholarships", titleHints: ["commonwealth"], hostHints: ["cscuk"] },
  { name: "Gates Cambridge", titleHints: ["gates cambridge"], hostHints: ["gatescambridge.org"] },
  { name: "Rhodes", titleHints: ["rhodes"], hostHints: ["rhodeshouse"] },
  { name: "Stipendium Hungaricum", titleHints: ["stipendium hungaricum"], hostHints: ["stipendiumhungaricum"] },
  { name: "Türkiye Bursları", titleHints: ["türkiye", "turkiye burslari"], hostHints: ["turkiyeburslari"] },
  { name: "Chinese Government Scholarship (CSC)", titleHints: ["chinese government", "csc"], hostHints: ["campuschina", "csc.edu.cn"] },
  { name: "New Zealand Scholarships", titleHints: ["new zealand"], hostHints: ["mfat.govt.nz", "nzscholarships"] },
  { name: "Orange Knowledge Programme", titleHints: ["orange knowledge"], hostHints: ["nuffic"] },
  { name: "ADB-Japan Scholarship (JSP)", titleHints: ["adb-japan", "adb japan", "japan scholarship program"], hostHints: ["adb.org"] },
  { name: "Joint Japan/World Bank (JJ/WBGSP)", titleHints: ["world bank", "jj/wbgsp"], hostHints: ["worldbank.org"] },
  { name: "Taiwan ICDF", titleHints: ["taiwan", "icdf"], hostHints: ["icdf.org.tw"] },
  { name: "Clarendon (Oxford)", titleHints: ["clarendon"], hostHints: ["ox.ac.uk/clarendon"] },
];

async function main() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("scholarships")
    .select("id, title, country, source_url, official_portal_url, verification_status, deadline_date");
  if (error) throw error;
  const rows = data ?? [];

  const held: { candidate: string; rows: string[] }[] = [];
  const missing: string[] = [];

  for (const candidate of CANDIDATES) {
    const matches = rows.filter((row: any) => {
      const title = row.title.toLowerCase();
      if (candidate.titleHints.some((hint) => title.includes(hint))) return true;
      const urls = `${row.source_url ?? ""} ${row.official_portal_url ?? ""}`.toLowerCase();
      return (candidate.hostHints ?? []).some((hint) => urls.includes(hint));
    });
    if (matches.length > 0) held.push({ candidate: candidate.name, rows: matches.map((m: any) => m.title) });
    else missing.push(candidate.name);
  }

  console.log(`\nCOVERAGE — ${CANDIDATES.length} major programmes checked, as of ${AS_OF}\n`);
  console.log(`HELD (${held.length}):`);
  for (const h of held) console.log(`  ${h.candidate}\n      ${h.rows.join("\n      ")}`);
  console.log(`\nMISSING (${missing.length}):`);
  for (const m of missing) console.log(`  ${m}`);

  // What the catalogue holds that is NOT on the candidate list — the other
  // half of the coverage question, and the one that says what the crawler
  // actually brings home when nobody steers it.
  const matchedTitles = new Set(held.flatMap((h) => h.rows));
  const unlisted = rows.filter((r: any) => !matchedTitles.has(r.title));
  console.log(`\nIN THE CATALOGUE BUT NOT A MAJOR PROGRAMME (${unlisted.length} of ${rows.length}):`);
  for (const r of unlisted) console.log(`  ${r.country.padEnd(16)} ${r.title}`);

  writeEvidence("coverage.json", {
    as_of: AS_OF,
    candidates_checked: CANDIDATES.length,
    held: held.length,
    missing,
    held_detail: held,
    catalogue_rows_not_on_candidate_list: unlisted.map((r: any) => ({
      title: r.title,
      country: r.country,
      url: r.official_portal_url,
      verification_status: r.verification_status,
    })),
  });
}

await main();
