/**
 * Accredited institutions, from the Research Organization Registry.
 *
 * WHY THIS EXISTS INSTEAD OF A SEARCH ENGINE. The seed list is the ceiling on
 * everything discovery can find, and curating it by hand has measured returns
 * of roughly one usable seed per four or five URLs guessed. The obvious fix is
 * a web search, and it has two problems: it needs a keyed, metered API, and it
 * returns the open web — which for the query "scholarship for international
 * students" is overwhelmingly aggregators and content farms, exactly the
 * sources this project refuses to treat as facts.
 *
 * ROR is a better fit than a search engine, not a worse one. It is free, needs
 * no key, is CC0, and lists ~20,000 accredited education and funding bodies
 * across the six target countries — every one of them an institution by
 * construction. So instead of searching the web and filtering out the junk, we
 * enumerate the institutions and read their own sites. That is the same
 * discipline the hand-curated seeds follow, applied at a scale nobody can
 * curate by hand.
 *
 * It is a source of DOMAINS, never of facts. Every URL it leads to goes through
 * the same funnel as any other candidate — scoreCandidate, prefilter,
 * classifier, crawl, and grounding.
 *
 * A SECOND USE: membership is an authority signal. A host ROR knows is an
 * accredited body, which classifies it `official` even when its domain says
 * nothing — see `knownInstitutions` in authority.ts.
 */

const ROR_API = "https://api.ror.org/v2/organizations";

/** ROR types worth reading. `funder` catches ministries and foundations. */
export const INSTITUTION_TYPES = ["education", "funder"] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

/** ISO-3166 alpha-2 for the six target countries. */
export const COUNTRY_CODES: Record<string, string> = {
  USA: "US",
  UK: "GB",
  China: "CN",
  Japan: "JP",
  "South Korea": "KR",
  Singapore: "SG",
};

export interface Institution {
  name: string;
  /** Homepage as ROR records it. */
  url: string;
  host: string;
  type: InstitutionType;
}

interface RorOrganisation {
  names?: Array<{ value?: string; types?: string[] }>;
  links?: Array<{ type?: string; value?: string }>;
  types?: string[];
}

interface RorPage {
  number_of_results?: number;
  items?: RorOrganisation[];
}

/**
 * Names that mean "this body might fund an international student's degree".
 *
 * ROR returns organisations in no useful order — the first page for South Korea
 * was a children's rights society and two provincial colleges — so this ranks
 * the pool. It only REORDERS and never excludes, because plenty of real funders
 * are institutes, ministries and foundations.
 *
 * THE TRAP IS THE WORD "COLLEGE". A first version preferred it, and the UK run
 * duly surfaced the Royal College of Obstetricians (50 award pages) and the
 * Royal College of Surgeons of Edinburgh (11) above actual universities. Those
 * are real awards on real institutional sites — travel fellowships and
 * professorships for the college's own medical trainees — and none of them is a
 * scholarship an international student can apply to for a degree. They would
 * have been seeded, crawled every run, and rejected one page at a time by the
 * classifier.
 *
 * So: degree-awarding bodies up, professional and learned societies down.
 */
const DEGREE_AWARDING =
  /\b(universit|institute of technology|polytechnic|graduate school)/i;

/** Bodies that award to their own members and professions, not to applicants. */
const PROFESSIONAL_BODY =
  /\b(royal college|college of (surgeons|physicians|obstetric|nurs|midwi|radiolog|psychiatr|patholog|anaesthet|general practitioner|emergency|ophthalmolog|paediatric)|academy of medical|learned society|professional (body|association)|society of|association of|federation of|chamber of|council of|guild)\b/i;

/** Hospitals, museums, charities: institutional, but not somewhere you study. */
const NOT_A_PLACE_TO_STUDY =
  /\b(hospital|nhs|clinic|museum|gallery|archive|library trust|children'?s|charity|foundation trust)\b/i;

export function rankInstitutionName(name: string): number {
  let score = 0;
  if (DEGREE_AWARDING.test(name)) score += 3;
  // "college" and "school" only count when nothing above has flagged the name.
  else if (/\b(college|school|academy)\b/i.test(name)) score += 1;

  if (PROFESSIONAL_BODY.test(name)) score -= 4;
  if (NOT_A_PLACE_TO_STUDY.test(name)) score -= 3;

  return score;
}

function hostFrom(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * One page of institutions for a country.
 *
 * ROR paginates at 20 per page and caps `page` well above anything we need.
 * Failures return empty rather than throwing: a discovery run must not die
 * because a third-party registry had a bad minute.
 */
async function fetchPage(
  countryCode: string,
  type: InstitutionType,
  page: number,
): Promise<RorPage> {
  const url =
    `${ROR_API}?filter=country.country_code:${encodeURIComponent(countryCode)},types:${type}` +
    `&page=${page}`;

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return {};
    return (await response.json()) as RorPage;
  } catch {
    return {};
  }
}

export interface InstitutionOptions {
  /** Institutions returned, after ranking. */
  limit?: number;
  /** Which ROR types to include. */
  types?: readonly InstitutionType[];
  onProgress?: (line: string) => void;
}

/**
 * Institutions for one country, degree-awarding bodies first.
 *
 * De-duplicated by host: ROR lists faculties and campuses separately, and a
 * dozen entries can share one website. Crawling that site twelve times finds
 * the same pages twelve times.
 */
export async function fetchInstitutions(
  countryCode: string,
  options: InstitutionOptions = {},
): Promise<Institution[]> {
  const limit = options.limit ?? 100;
  const types = options.types ?? INSTITUTION_TYPES;
  const say = options.onProgress ?? (() => {});

  const byHost = new Map<string, Institution>();

  for (const type of types) {
    // Enough pages to rank from, without walking a registry of thousands: the
    // preference sort only helps if it has a pool to sort.
    const maxPages = Math.max(2, Math.ceil((limit * 2) / 20));

    for (let page = 1; page <= maxPages; page++) {
      const body = await fetchPage(countryCode, type, page);
      const items = body.items ?? [];
      if (items.length === 0) break;

      for (const org of items) {
        const name = org.names?.find((entry) => entry.value)?.value;
        const website = org.links?.find((link) => link.type === "website")?.value;
        if (!name || !website) continue;

        const host = hostFrom(website);
        if (!host || byHost.has(host)) continue;

        byHost.set(host, { name, url: website, host, type });
      }

      if (page === 1) {
        say(`    ROR ${countryCode}/${type}: ${body.number_of_results ?? "?"} organisation(s)`);
      }
    }
  }

  return [...byHost.values()]
    .sort((a, b) => rankInstitutionName(b.name) - rankInstitutionName(a.name))
    .slice(0, limit);
}

/**
 * Hosts to treat as accredited, for `classifyAuthority`.
 *
 * Both the bare host and its registrable domain, so a page on a subdomain the
 * registry did not name still resolves to the institution.
 */
export function institutionHosts(institutions: Institution[]): Set<string> {
  const hosts = new Set<string>();
  for (const institution of institutions) {
    hosts.add(institution.host);
  }
  return hosts;
}
