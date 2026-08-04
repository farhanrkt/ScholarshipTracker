/**
 * URLs that look like a student can APPLY for money to study.
 *
 * `scoreCandidate` is deliberately generous — it ranks links within a site we
 * have already decided to crawl, where a false positive costs one fetch. Judging
 * a whole SITE is a different question, and the first UK survey showed how
 * differently: it proposed
 *
 *   ravensbourne.ac.uk/bbc-motion-graphics-archive/bafta-alexander-korda-award-…
 *   rcgp.org.uk/about/awards/fellowship-awards-committee
 *   stmarys-belfast.ac.uk/study/bed-primary/…/fees-funding
 *
 * — a BBC archive page about a BAFTA, a professional body's internal awards
 * committee, and a course fee table. All three matched on "award" or "funding",
 * and all three would have become permanent seeds crawled on every run.
 *
 * So a site earns a seed only on URLs naming a thing a student applies for.
 * "award" and "funding" are not on this list precisely because they are what
 * produced every false positive above.
 */
const STUDENT_FUNDING = /(scholarship|bursary|bursaries|studentship|fellowship|financial-aid|financial_aid)/i;

/** Sections written for applicants rather than for members or staff. */
const APPLICANT_FACING = /\/(study|studies|admission|admissions|apply|prospective|international|student|students|postgraduate|undergraduate|graduate|fees|finance|funding|money)/i;

/** Sections a professional body keeps for its own members. */
const MEMBER_FACING = /\/(members?|membership|careers-and-training|about|governance|committee|council|news|archive|examinations?|cpd|training)\//i;

export function isStudentFunding(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (!STUDENT_FUNDING.test(path)) return false;
  if (MEMBER_FACING.test(path) && !APPLICANT_FACING.test(path)) return false;
  return true;
}
