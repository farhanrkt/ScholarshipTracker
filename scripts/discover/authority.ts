/**
 * How much a source is worth trusting about a programme.
 *
 * Everything the pipeline reads is grounded — a value survives only if its
 * quote is verbatim on a page we fetched. That proves the SOURCE SAID IT. It
 * does not prove the source was right, and those are different questions the
 * moment more than one site describes the same award.
 *
 * A funder's own page saying "the deadline is 6 October" is the fact. A
 * commercial scholarship blog saying "the deadline is 12 October" is a claim
 * about the fact, usually copied from last year's page. Both ground perfectly.
 * Authority is what tells them apart.
 *
 * Three tiers, ordered:
 *
 *   funder    the programme's own domain — the only source that can be wrong
 *             about its own deadline and still be the deadline
 *   official  a government or academic body that is not the funder: a ministry,
 *             or the university that hosts the award
 *   other     everything else — aggregators, blogs, content farms
 *
 * Deliberately coarse. A finer ranking would imply a precision we cannot
 * justify, and the only decisions that hang off this are "may this value be
 * written" and "who wins a disagreement".
 */

export const AUTHORITIES = ["funder", "official", "other"] as const;
export type Authority = (typeof AUTHORITIES)[number];

/** Higher wins a conflict. */
export const AUTHORITY_RANK: Record<Authority, number> = {
  funder: 3,
  official: 2,
  other: 1,
};

export const AUTHORITY_LABELS: Record<Authority, string> = {
  funder: "The programme's own site",
  official: "Government or university source",
  other: "Third-party source",
};

/* -------------------------------------------------------------------------- */
/* Public suffixes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Two-label suffixes we care about, so `registrableDomain` does not treat
 * `ac.uk` or `edu.sg` as if they were somebody's domain.
 *
 * Not a full Public Suffix List: this is used for two things only — comparing
 * two hosts for "same organisation", and academic/government detection — and
 * for both, the six target countries plus the common global suffixes are the
 * whole of what matters. A missing entry degrades to treating a longer host as
 * distinct, which is the safe direction.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "ac.uk", "gov.uk", "org.uk", "co.uk", "sch.uk", "nhs.uk",
  "ac.jp", "go.jp", "or.jp", "co.jp", "ne.jp", "ed.jp",
  "ac.kr", "go.kr", "or.kr", "co.kr", "re.kr",
  "edu.cn", "gov.cn", "org.cn", "com.cn", "ac.cn", "net.cn",
  "edu.sg", "gov.sg", "org.sg", "com.sg",
  "edu.au", "gov.au", "org.au", "com.au",
  "edu.hk", "gov.hk", "edu.tw", "gov.tw", "edu.my", "gov.my",
  "edu.in", "gov.in", "ac.in", "edu.pk", "ac.nz", "govt.nz",
]);

/**
 * Suffixes that mean "an accredited institution or an arm of a state".
 *
 * These are registry-controlled: you cannot buy a `.ac.uk` or a `.edu` without
 * being an accredited body, which is exactly the property that makes them
 * usable as an authority signal at all. `.org` is NOT here — anyone can buy one,
 * and both real funders and content farms do.
 */
const OFFICIAL_SUFFIXES = [
  "gov", "edu", "mil", "int",
  "ac.uk", "gov.uk", "nhs.uk", "sch.uk",
  "ac.jp", "go.jp", "ed.jp",
  "ac.kr", "go.kr", "re.kr",
  "edu.cn", "gov.cn", "ac.cn",
  "edu.sg", "gov.sg",
  "edu.au", "gov.au",
  "edu.hk", "gov.hk", "edu.tw", "gov.tw", "edu.my", "gov.my",
  "edu.in", "gov.in", "ac.in", "edu.pk", "ac.nz", "govt.nz",
  "gouv.fr", "gc.ca",
];

/**
 * Real funders whose domain says nothing about them.
 *
 * Every entry is a body that runs a programme in this database from a plain
 * `.org` or `.com`. Without this list they would rank alongside the blogs that
 * write about them, and their own words would be treated as second-hand.
 *
 * ADD ONLY FUNDERS AND RECOGNISED INSTITUTIONS. This list is a promotion, and
 * one wrong entry lets an aggregator establish facts.
 */
const OFFICIAL_DOMAINS = new Set([
  "chevening.org",
  "cscuk.fcdo.gov.uk",
  "rotary.org",
  "pdsoros.org",
  "gatescambridge.org",
  "knight-hennessy.stanford.edu",
  "schwarzmanscholars.org",
  "iie.org",
  "humphreyfellowship.org",
  "fulbrightonline.org",
  "jasso.go.jp",
  "studyinjapan.go.jp",
  "studyinkorea.go.kr",
  "a-star.edu.sg",
  "daad.de",
  "britishcouncil.org",
  "commonwealthscholarships.gov.uk",
  "acu.ac.uk",
]);

/**
 * Domains that are never a source of record, whatever they look like.
 *
 * Scholarship aggregators republish funders' terms, rarely date-stamp them, and
 * routinely carry last cycle's deadline as though it were this one's. They are
 * not dishonest, they are stale — which reaches a student the same way.
 *
 * Kept even though `other` is already the default, because some of these sit on
 * suffixes that would otherwise promote them, and because naming them makes the
 * rejection auditable rather than incidental.
 */
const NEVER_OFFICIAL = new Set([
  "chinesescholarshipcouncil.com",
  "scholarship-positions.com",
  "scholarshipsads.com",
  "scholars4dev.com",
  "opportunitydesk.org",
  "scholarshipdb.net",
  "wemakescholars.com",
  "scholarshiproar.com",
  "afterschoolafrica.com",
  "studyabroadaides.com",
]);

/* -------------------------------------------------------------------------- */
/* Host arithmetic                                                            */
/* -------------------------------------------------------------------------- */

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True when `host` is `suffix` or sits under it, on a label boundary. */
function endsWithLabel(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * The part of a host that identifies the ORGANISATION.
 *
 * `oga.snu.ac.kr` and `www.snu.ac.kr` are both `snu.ac.kr`; `chevening.org` and
 * `apply.chevening.org` are both `chevening.org`. Used to decide whether a page
 * belongs to the programme's own funder, which must not be defeated by a
 * subdomain.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");

  const lastTwo = labels.slice(-2).join(".");
  const take = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** Do two URLs belong to the same organisation? */
export function sameOrganisation(a: string, b: string): boolean {
  const hostA = hostOf(a);
  const hostB = hostOf(b);
  if (!hostA || !hostB) return false;
  return registrableDomain(hostA) === registrableDomain(hostB);
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

export interface AuthorityOptions {
  /**
   * The programme's own site — normally the row's `official_portal_url`.
   * A page under the same organisation is the funder speaking about itself.
   */
  funderUrl?: string | null;
  /**
   * Hosts known to be accredited institutions, e.g. loaded from ROR.
   *
   * Injected rather than fetched so this stays a pure function: the caller
   * decides whether to spend a network call, and tests never need one.
   */
  knownInstitutions?: ReadonlySet<string>;
}

/**
 * What tier is this URL?
 *
 * Order matters. The denylist is checked before every promotion, so a domain we
 * have judged unreliable cannot be rescued by a suffix, a curated entry, or an
 * institution registry.
 */
export function classifyAuthority(
  url: string,
  options: AuthorityOptions = {},
): Authority {
  const host = hostOf(url);
  if (!host) return "other";

  const domain = registrableDomain(host);
  if (NEVER_OFFICIAL.has(domain) || NEVER_OFFICIAL.has(host)) return "other";

  if (options.funderUrl && sameOrganisation(url, options.funderUrl)) {
    return "funder";
  }

  if (OFFICIAL_DOMAINS.has(domain) || OFFICIAL_DOMAINS.has(host)) return "official";
  if (options.knownInstitutions?.has(domain) || options.knownInstitutions?.has(host)) {
    return "official";
  }
  if (OFFICIAL_SUFFIXES.some((suffix) => endsWithLabel(host, suffix))) {
    return "official";
  }

  return "other";
}

/** The stronger of two tiers. */
export function strongerAuthority(a: Authority, b: Authority): Authority {
  return AUTHORITY_RANK[a] >= AUTHORITY_RANK[b] ? a : b;
}
