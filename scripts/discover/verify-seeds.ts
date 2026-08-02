/**
 * ScholarTrack :: seed verification
 *
 *   npm run discover:verify                        # check every seed in seeds.ts
 *   npm run discover:verify -- https://a https://b # check candidate URLs first
 *
 * seeds.ts asks for every entry to be verified by fetching it and counting
 * programme-shaped links. This is that check, made repeatable — a seed measured
 * by eye, or with a heuristic that is not the crawler's, is a seed measured
 * wrong.
 *
 * No model calls and no database: this is fetching and counting only, so it is
 * safe to run against a long list of maybes while curating.
 */

import { countProgrammeLinks, findPaginationLinks, scoreCandidate } from "./candidates.ts";
import { SEEDS } from "./seeds.ts";
import { extractLinks, fetchPage, FETCH_DELAY_MS } from "../extract/page.ts";

const urls = process.argv.slice(2).filter((argument) => /^https?:\/\//.test(argument));
const targets = urls.length > 0 ? urls : SEEDS.map((seed) => seed.url);

interface Row {
  url: string;
  ok: boolean;
  detail: string;
}

const rows: Row[] = [];

for (const [index, url] of targets.entries()) {
  try {
    const page = await fetchPage(url);
    const links = extractLinks(page, { sameOriginOnly: false });
    const sameOrigin = extractLinks(page, { sameOriginOnly: true });
    const programmeShaped = countProgrammeLinks(links);
    const pagers = findPaginationLinks(page, links);

    const top = links
      .map((link) => ({ ...link, score: scoreCandidate(link.label, link.url) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((link) => `${link.score} ${link.url}`);

    rows.push({
      url,
      // A seed earns its slot by yielding programmes, not by responding.
      ok: programmeShaped >= 5,
      detail:
        `${page.text.length.toLocaleString()} chars · ${links.length} links ` +
        `(${sameOrigin.length} same-origin) · ${programmeShaped} programme-shaped · ` +
        `${pagers.length} pager(s)`,
    });

    console.log(`\n${programmeShaped >= 5 ? "✓" : "·"} ${url}`);
    console.log(`    ${rows.at(-1)!.detail}`);
    if (pagers.length > 0) console.log(`    next: ${pagers.slice(0, 3).join(", ")}`);
    for (const line of top) console.log(`    top: ${line}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rows.push({ url, ok: false, detail: message });
    console.log(`\n✗ ${url}`);
    console.log(`    ${message}`);
  }

  if (index < targets.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
  }
}

const usable = rows.filter((row) => row.ok);
console.log(
  `\n${usable.length}/${rows.length} usable (5+ programme-shaped links).\n`,
);
