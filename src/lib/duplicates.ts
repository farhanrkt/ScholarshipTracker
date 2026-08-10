/**
 * Finding rows that are the same programme twice.
 *
 * Discovery dedupes on an exact normalised title, which catches
 * `Chevening Scholarship` / `Chevening Scholarships` and nothing else. The
 * catalogue accordingly grew 7 Chevening rows and 3 Humphrey rows, so a student
 * scrolling the dashboard meets the same award repeatedly and cannot tell which
 * entry to track.
 *
 * NOTHING HERE MERGES ANYTHING. It proposes; a reviewer decides. That is not
 * caution for its own sake — the hard cases are genuinely ambiguous and no
 * string comparison settles them. `Distinguished Humphrey Fellowship Program`
 * reads like a longer way of writing `Humphrey Fellowship Program` and is a
 * different award. `Chevening Scholarships in Australia` might be a variant
 * worth its own row or might not, and that is a product decision about what a
 * student is looking for, not a fact about the strings.
 *
 * So the job here is to put the plausible pairs in front of someone, ranked,
 * with the reason stated — and to be quiet about the rest.
 */

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The word that says what KIND of thing this is.
 *
 * Load-bearing, and the reason a naive token overlap fails here. Strip these as
 * noise — which is the obvious move, since every title contains one — and
 * `Chevening Fellowships` and `Chevening Scholarships` both reduce to
 * `chevening` and look like a certain duplicate. They are two different
 * programmes from one funder, with different eligibility and different money.
 *
 * So they are kept, and a disagreement between them is disqualifying.
 */
const TYPE_WORDS = [
  "fellowship",
  "scholarship",
  "studentship",
  "bursary",
  "grant",
  "award",
  "prize",
  "programme",
  "program",
];

/**
 * Words that appear in so many titles that sharing one means nothing.
 *
 * Note that the type words are NOT here: they are compared separately, above.
 */
const GENERIC = new Set([
  "the", "of", "for", "and", "in", "at", "to", "a", "an", "on",
  "international", "student", "students", "study", "studies",
  "graduate", "postgraduate", "undergraduate", "masters", "master",
  "phd", "doctoral", "global", "foundation", "university", "national",
  ...TYPE_WORDS,
]);

/** Lowercase alphanumeric words, de-pluralised the way discovery does it. */
export function tokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => (word.length > 3 ? word.replace(/s$/, "") : word));
}

/**
 * The same fingerprint discovery uses, so "already a duplicate by the existing
 * rule" and "certain" mean exactly the same thing in both places.
 */
export function fingerprint(title: string): string {
  return tokens(title).join(" ");
}

/** The words that actually name this programme rather than describe its shape. */
export function distinctive(title: string): Set<string> {
  return new Set(tokens(title).filter((word) => !GENERIC.has(word)));
}

/** Fellowship or scholarship? Null when the title does not say. */
export function programmeType(title: string): string | null {
  const words = new Set(tokens(title));
  return TYPE_WORDS.find((type) => words.has(type)) ?? null;
}

function host(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Pairing                                                                    */
/* -------------------------------------------------------------------------- */

export type DuplicateConfidence = "certain" | "likely" | "possible";

export interface DuplicateRow {
  id: string;
  title: string;
  country: string;
  official_portal_url: string;
  verification_status: string;
  is_profiled: boolean;
  deadline_date: string | null;
  created_at: string;
}

export interface DuplicatePair {
  a: DuplicateRow;
  b: DuplicateRow;
  confidence: DuplicateConfidence;
  /** Shown to the reviewer. Says what matched, not how sure a number is. */
  reason: string;
}

export interface DuplicateCluster {
  rows: DuplicateRow[];
  pairs: DuplicatePair[];
  /** The strongest pair in the cluster, for ordering the review queue. */
  confidence: DuplicateConfidence;
  /** The row a reviewer would most likely keep. Only a default. */
  suggestedKeep: DuplicateRow;
}

const RANK: Record<DuplicateConfidence, number> = {
  certain: 3,
  likely: 2,
  possible: 1,
};

function subset(small: Set<string>, large: Set<string>): boolean {
  if (small.size === 0 || small.size > large.size) return false;
  for (const word of small) if (!large.has(word)) return false;
  return true;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The comparison itself, over nothing but a name and an address.
 *
 * Split out from `comparePair` so discovery can ask the same question BEFORE
 * creating a row — which is where the duplicates come from in the first place.
 * Two implementations of "is this the same programme?" would drift, and the
 * drift would show up as rows the dashboard has and the merge page cannot see.
 */
export function compareProgrammes(
  a: { title: string; url: string },
  b: { title: string; url: string },
): { confidence: DuplicateConfidence; reason: string } | null {
  // A funder that runs both a fellowship and a scholarship runs two programmes.
  // Checked before anything else, because every rule below would match them.
  const typeA = programmeType(a.title);
  const typeB = programmeType(b.title);
  if (typeA && typeB && typeA !== typeB) return null;

  if (fingerprint(a.title) === fingerprint(b.title)) {
    return {
      confidence: "certain",
      reason: "identical titles once case and plurals are ignored",
    };
  }

  // Beyond an identical title, sharing a site is what makes two similar names
  // likely to be one programme rather than two funders using the same words.
  const hostA = host(a.url);
  const hostB = host(b.url);
  if (!hostA || hostA !== hostB) return null;

  const wordsA = distinctive(a.title);
  const wordsB = distinctive(b.title);
  if (wordsA.size === 0 || wordsB.size === 0) return null;

  if (subset(wordsA, wordsB) || subset(wordsB, wordsA)) {
    return {
      confidence: "likely",
      reason: "same site, and one title is the other plus a qualifier",
    };
  }

  if (overlap(wordsA, wordsB) >= 0.5) {
    return {
      confidence: "possible",
      reason: "same site and most of the same distinctive words",
    };
  }

  return null;
}

/** How alike two rows are, or null when they are not alike enough to ask. */
export function comparePair(
  a: DuplicateRow,
  b: DuplicateRow,
): { confidence: DuplicateConfidence; reason: string } | null {
  return compareProgrammes(
    { title: a.title, url: a.official_portal_url },
    { title: b.title, url: b.official_portal_url },
  );
}

/* -------------------------------------------------------------------------- */
/* Clustering                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which row a reviewer probably wants to keep.
 *
 * A default, not a decision — the UI lets them pick any row in the cluster.
 * Ordered by what would be lost by dropping it: a human's verification first,
 * then extracted depth, then a published deadline, then age.
 */
function preferKeep(rows: DuplicateRow[]): DuplicateRow {
  const score = (row: DuplicateRow) =>
    (row.verification_status === "verified" ? 1000 : 0) +
    (row.verification_status === "ai_extracted" ? 100 : 0) +
    (row.is_profiled ? 50 : 0) +
    (row.deadline_date ? 25 : 0);

  return [...rows].sort(
    (x, y) => score(y) - score(x) || x.created_at.localeCompare(y.created_at),
  )[0]!;
}

/**
 * Connected components over the pairs that scored.
 *
 * Transitive on purpose: three rows for one programme should reach a reviewer
 * as one decision, not as three pairs they have to reconcile in their head.
 */
export function findDuplicates(rows: DuplicateRow[]): DuplicateCluster[] {
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const verdict = comparePair(rows[i]!, rows[j]!);
      if (verdict) pairs.push({ a: rows[i]!, b: rows[j]!, ...verdict });
    }
  }

  const parent = new Map<string, string>(rows.map((row) => [row.id, row.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };

  for (const pair of pairs) parent.set(find(pair.a.id), find(pair.b.id));

  const grouped = new Map<string, DuplicateRow[]>();
  for (const row of rows) {
    const root = find(row.id);
    grouped.set(root, [...(grouped.get(root) ?? []), row]);
  }

  const clusters: DuplicateCluster[] = [];
  for (const [root, members] of grouped) {
    if (members.length < 2) continue;

    const own = pairs.filter((pair) => find(pair.a.id) === root);
    const confidence = own.reduce<DuplicateConfidence>(
      (best, pair) => (RANK[pair.confidence] > RANK[best] ? pair.confidence : best),
      "possible",
    );

    clusters.push({
      rows: [...members].sort((x, y) => x.title.localeCompare(y.title)),
      pairs: own,
      confidence,
      suggestedKeep: preferKeep(members),
    });
  }

  return clusters.sort(
    (x, y) => RANK[y.confidence] - RANK[x.confidence] || y.rows.length - x.rows.length,
  );
}
