/**
 * ScholarTrack :: automated seed finding
 *
 *   npm run discover:find-seeds -- --country UK
 *   npm run discover:find-seeds -- --country China --limit 200
 *   npm run discover:find-seeds -- --country Japan --min 10
 *
 * Enumerates accredited institutions from ROR, reads each one's own sitemap,
 * and reports which of them actually carry programme pages — in the shape you
 * paste into `seeds.ts`.
 *
 * WHY THIS IS A REPORT AND NOT AN AUTOMATIC IMPORT. seeds.ts says to curate the
 * list by hand, and it is right: a seed is a commitment to crawl a site every
 * run, and the difference between a funding index and a course catalogue is a
 * judgement no yield count makes for you. What was actually painful was the
 * SEARCH — guessing URLs at a measured rate of about one usable seed per four
 * or five tried, with no way to know which institutions even publish a sitemap.
 * That part is mechanical, so this does that part.
 *
 * No API key and no web search: ROR is free, keyless and CC0, and every domain
 * it returns is an accredited body by construction — which is a better filter
 * than any search engine result page, not a worse one.
 *
 * Nothing here writes to the database.
 */

import { COUNTRY_CODES, fetchInstitutions, institutionHosts } from "./institutions.ts";
import { discoverFromSitemap } from "./sitemap.ts";
import { BLOCKED_SEEDS, SEEDS } from "./seeds.ts";
import { classifyAuthority } from "./authority.ts";
import { isStudentFunding } from "./student-funding.ts";

const argv = process.argv;
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const countryArg = option("country") ?? "UK";
const limit = Number(option("limit") ?? 60);
const minUrls = Number(option("min") ?? 5);

const countryCode = COUNTRY_CODES[countryArg] ?? countryArg.toUpperCase();

/** Hosts we already crawl or have already rejected — no point re-testing. */
const known = new Set<string>();
for (const url of [...SEEDS.map((seed) => seed.url), ...BLOCKED_SEEDS]) {
  try {
    known.add(new URL(url).hostname.replace(/^www\./, ""));
  } catch {
    // A malformed entry in the list is not this script's problem.
  }
}

async function main() {
  console.log(
    `\nFinding seeds for ${countryArg} (${countryCode}) · ${limit} institution(s) · keeping ${minUrls}+ programme URLs\n`,
  );

  const institutions = await fetchInstitutions(countryCode, {
    limit,
    onProgress: (line) => console.log(line),
  });

  const fresh = institutions.filter((institution) => !known.has(institution.host));
  console.log(
    `\n${institutions.length} institution(s), ${institutions.length - fresh.length} already seeded or blocked → probing ${fresh.length}\n`,
  );

  interface Hit {
    name: string;
    url: string;
    host: string;
    /** URLs that name something a student applies for. */
    urls: number;
    /** Everything the sitemap yielded, for context on how selective that was. */
    total: number;
    sample: string[];
  }

  const hits: Hit[] = [];
  let probed = 0;
  let noSitemap = 0;

  /**
   * Institutions are probed in parallel because they are DIFFERENT HOSTS.
   *
   * Politeness lives in the fetch layer and is per host, so one lane per
   * institution is exactly as polite as one lane in total — and sequentially,
   * a survey is dominated by dead sites burning three 30-second timeouts each
   * while every other institution waits behind them.
   */
  const lanes = Math.min(Math.max(Number(option("concurrency") ?? 8), 1), 16);
  let cursor = 0;

  const probe = async () => {
    for (;;) {
      const institution = fresh[cursor++];
      if (!institution) return;

      probed++;
      let found: string[] = [];
      try {
        found = await discoverFromSitemap(institution.url, {
          // Deliberately small: this is a survey of many sites, not a crawl of
          // one, and a site worth seeding shows it in its first sitemap or two.
          maxDocuments: 3,
          maxUrls: 120,
        });
      } catch {
        // Unreachable, robots-blocked, or no sitemap. All the same answer here.
      }

      // Judged on student-funding URLs only, not on everything that scored.
      const funding = found.filter(isStudentFunding);
      if (funding.length < minUrls) {
        noSitemap++;
        continue;
      }

      hits.push({
        name: institution.name,
        url: institution.url,
        host: institution.host,
        urls: funding.length,
        total: found.length,
        sample: funding.slice(0, 3),
      });

      console.log(
        `  ✓ ${String(funding.length).padStart(4)} of ${String(found.length).padEnd(4)} ${institution.name.slice(0, 44)}`,
      );
    }
  };

  await Promise.all(Array.from({ length: lanes }, probe));

  hits.sort((a, b) => b.urls - a.urls);

  console.log(
    `\n${hits.length} of ${probed} institutions carry programme pages (${noSitemap} had no usable sitemap).\n`,
  );

  if (hits.length === 0) {
    console.log(
      "Nothing to add. That is a real answer for some regions: major Chinese and\n" +
        "Korean universities largely do not publish sitemaps, and no amount of\n" +
        "enumeration changes what a server will not serve.\n",
    );
    return;
  }

  console.log("Paste-ready for scripts/discover/seeds.ts — CHECK EACH ONE FIRST:\n");
  // ROR membership IS the accreditation check, so the registry has to be passed
  // in — otherwise a real university on a plain .com (BPP) is reported as
  // `other`, and this tool contradicts the authority model it is built on.
  const knownInstitutions = institutionHosts(institutions);

  for (const hit of hits) {
    // Authority is reported because a seed that is not an institution is the
    // one mistake this tool could make at scale.
    const tier = classifyAuthority(hit.url, { knownInstitutions });
    console.log(`  {`);
    console.log(`    // ${hit.urls} student-funding URL(s) of ${hit.total} programme-shaped. ${tier}. Verified ${new Date().toISOString().slice(0, 10)}.`);
    // Three samples, not one: whether these are degree scholarships or a
    // professional body's internal awards is the judgement being asked of the
    // reader, and one URL is rarely enough to make it.
    for (const url of hit.sample) console.log(`    // e.g. ${url}`);
    console.log(`    url: ${JSON.stringify(hit.url)},`);
    console.log(`    label: ${JSON.stringify(hit.name.slice(0, 60))},`);
    console.log(`    followExternal: false,`);
    console.log(`    country: ${JSON.stringify(countryArg)},`);
    console.log(`  },`);
  }
  console.log("");
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
