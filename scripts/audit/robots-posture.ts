/**
 * Are we allowed to be reading these sites, and are we being polite about it?
 *
 * For every host the catalogue cites: what robots.txt says to our token, what
 * Crawl-delay it asks for, and what the crawler would actually do. The crawler
 * already enforces this at fetch time (scripts/extract/page.ts); this reports
 * it so the answer is on paper rather than only in the code path.
 *
 *   node --env-file=.env.local scripts/audit/robots-posture.ts
 */

import { crawlDelayFor, FETCH_DELAY_MS, isAllowed } from "../extract/page.ts";
import { AS_OF, supabaseAdmin, writeEvidence } from "./lib.ts";

async function main() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("scholarships")
    .select("title, source_url, official_portal_url");
  if (error) throw error;

  const byHost = new Map<string, { sample: string; programmes: Set<string> }>();
  for (const row of data ?? []) {
    for (const url of [row.source_url, row.official_portal_url]) {
      if (!url) continue;
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        continue;
      }
      const entry = byHost.get(host) ?? { sample: url, programmes: new Set<string>() };
      entry.programmes.add(row.title);
      byHost.set(host, entry);
    }
  }

  console.log(`\nCRAWL POSTURE — ${byHost.size} hosts, as of ${AS_OF}`);
  console.log(`Our floor between requests to one host: ${FETCH_DELAY_MS}ms\n`);

  const results = [];
  for (const [host, entry] of [...byHost].sort()) {
    let allowed: boolean | null = null;
    let declared: number | null = null;
    let note: string | undefined;
    try {
      allowed = await isAllowed(entry.sample);
      declared = await crawlDelayFor(entry.sample);
    } catch (cause) {
      note = cause instanceof Error ? cause.message : String(cause);
    }
    const effective = declared === null ? FETCH_DELAY_MS : Math.max(FETCH_DELAY_MS, declared);
    const honoured = declared === null ? "n/a" : effective >= declared ? "yes" : "NO";
    console.log(
      `  ${host.padEnd(34)} allowed=${String(allowed).padEnd(5)} ` +
        `crawl-delay=${String(declared ?? "—").padStart(5)}  we wait ${String(effective).padStart(5)}ms  ` +
        `honoured=${honoured}  (${entry.programmes.size} programmes)${note ? "  " + note.slice(0, 50) : ""}`,
    );
    results.push({
      host,
      sample_url: entry.sample,
      programmes: entry.programmes.size,
      allowed_for_our_token: allowed,
      declared_crawl_delay_ms: declared,
      our_effective_delay_ms: effective,
      honoured: honoured,
      note,
    });
  }

  const blocked = results.filter((r) => r.allowed_for_our_token === false);
  console.log(`\nHosts whose robots.txt disallows the page we cite: ${blocked.length}`);
  for (const b of blocked) console.log(`  ${b.host} — ${b.sample_url}`);

  writeEvidence("robots-posture.json", {
    as_of: AS_OF,
    our_user_agent:
      process.env.CRAWL_USER_AGENT ||
      "ScholarTrackBot/1.0 (scholarship deadline verification; +https://github.com/)",
    our_floor_delay_ms: FETCH_DELAY_MS,
    hosts: results,
  });
}

await main();
