import {
  AUTHORITY_RANK,
  type Authority,
} from "../discover/authority.ts";
import { normalise } from "./page.ts";

/**
 * Deciding what to believe when several sources describe one programme.
 *
 * Grounding answers "did this source say it". It cannot answer "was the source
 * right", and those stop being the same question the moment a second site
 * describes the same award. A university's page saying Chevening closes on 12
 * October grounds exactly as well as chevening.org saying 6 October: both
 * quotes are really on their pages, and one of them is last year's.
 *
 * So reconciliation is about SOURCES, not about text. Two rules do the work:
 *
 *   1. The funder wins. A programme's own site is definitionally right about
 *      its own deadline — if it is wrong, it is still what an applicant will be
 *      held to.
 *   2. Disagreement is never silently resolved. The losing value is recorded
 *      with its URL and tier, so a reviewer sees that sources differ rather
 *      than seeing a number with false confidence behind it.
 *
 * What this deliberately does NOT do is average, vote, or let weight of numbers
 * beat authority. Ten aggregators copying each other's stale deadline is one
 * mistake ten times, and treating it as ten confirmations is exactly how a
 * student ends up planning around a date nobody published.
 */

export interface SourcedValue<T> {
  value: T;
  /** Verbatim page text backing it. Already grounded before it gets here. */
  quote: string | null;
  sourceUrl: string;
  authority: Authority;
}

export interface SourceRef {
  url: string;
  authority: Authority;
}

export interface ConflictRef extends SourceRef {
  /** What this source claimed instead, rendered for a human. */
  value: string;
}

export interface Reconciled<T> {
  /** The value to write, or null when no source offered one. */
  value: T | null;
  quote: string | null;
  /** Tier of the source the value came from. Null when there is no value. */
  authority: Authority | null;
  sourceUrl: string | null;
  /** Other sources that independently said the same thing. */
  corroboratedBy: SourceRef[];
  /** Sources that said something different. Never silently discarded. */
  conflicts: ConflictRef[];
}

const EMPTY: Reconciled<never> = {
  value: null,
  quote: null,
  authority: null,
  sourceUrl: null,
  corroboratedBy: [],
  conflicts: [],
};

/**
 * Default sameness: the normalisation grounding already uses.
 *
 * Comparing "6 October 2026" with "6 october 2026" as different claims would
 * manufacture conflicts out of capitalisation, and a spurious conflict costs a
 * reviewer's attention just as surely as a real one.
 */
function defaultSame<T>(a: T, b: T): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return normalise(a) === normalise(b);
  }
  return a === b;
}

function render(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export interface ReconcileOptions<T> {
  /** Are two claims the same claim? Defaults to grounded normalisation. */
  same?: (a: T, b: T) => boolean;
}

/**
 * One field, many sources, one answer plus its provenance.
 *
 * Sources may arrive in any order and any number, including none.
 */
export function reconcileField<T>(
  claims: ReadonlyArray<SourcedValue<T>>,
  options: ReconcileOptions<T> = {},
): Reconciled<T> {
  const same = options.same ?? defaultSame;
  const offered = claims.filter((claim) => claim.value !== null && claim.value !== undefined);

  if (offered.length === 0) return { ...EMPTY };

  /**
   * Group identical claims, keeping each group's strongest source.
   *
   * Grouping BEFORE ranking is what makes corroboration mean anything: three
   * universities agreeing is one claim with three sources, not three claims.
   */
  interface Group {
    value: T;
    best: SourcedValue<T>;
    sources: SourcedValue<T>[];
  }

  const groups: Group[] = [];
  for (const claim of offered) {
    const group = groups.find((candidate) => same(candidate.value, claim.value));
    if (group) {
      group.sources.push(claim);
      if (AUTHORITY_RANK[claim.authority] > AUTHORITY_RANK[group.best.authority]) {
        group.best = claim;
      }
    } else {
      groups.push({ value: claim.value, best: claim, sources: [claim] });
    }
  }

  // Authority first, then corroboration, then stable order. Corroboration is
  // only ever a TIE-BREAK — it can separate two equally authoritative sources
  // and it can never lift a weaker tier above a stronger one.
  groups.sort((a, b) => {
    const byAuthority =
      AUTHORITY_RANK[b.best.authority] - AUTHORITY_RANK[a.best.authority];
    if (byAuthority !== 0) return byAuthority;
    return b.sources.length - a.sources.length;
  });

  const [winner, ...losers] = groups as [Group, ...Group[]];

  const corroboratedBy = winner.sources
    .filter((source) => source.sourceUrl !== winner.best.sourceUrl)
    .map((source) => ({ url: source.sourceUrl, authority: source.authority }));

  const conflicts: ConflictRef[] = [];
  for (const loser of losers) {
    for (const source of loser.sources) {
      conflicts.push({
        url: source.sourceUrl,
        authority: source.authority,
        value: render(source.value),
      });
    }
  }

  return {
    value: winner.best.value,
    quote: winner.best.quote,
    authority: winner.best.authority,
    sourceUrl: winner.best.sourceUrl,
    corroboratedBy,
    conflicts,
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A reviewer-facing line for a field whose sources disagree.
 *
 * Written as a caveat rather than an error because the value is still the best
 * available reading — the point is that somebody should look, not that the
 * pipeline failed.
 */
export function describeConflict(
  field: string,
  reconciled: Reconciled<unknown>,
): string | null {
  if (reconciled.conflicts.length === 0) return null;

  const others = reconciled.conflicts
    .map((conflict) => `"${conflict.value}" (${conflict.authority}, ${conflict.url})`)
    .join("; ");

  return (
    `${field}: sources disagree. Kept "${render(reconciled.value)}" from the ` +
    `${reconciled.authority} source ${reconciled.sourceUrl}. Also seen: ${others}`
  );
}

/** True when a value rests only on sources weaker than the funder's own site. */
export function isSecondHand(reconciled: Reconciled<unknown>): boolean {
  return reconciled.value !== null && reconciled.authority !== "funder";
}
