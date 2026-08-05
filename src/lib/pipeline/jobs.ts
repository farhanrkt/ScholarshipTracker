/**
 * What the web UI is allowed to ask the pipeline to do.
 *
 * WHY A WHITELIST. This used to turn an HTTP request into a process on the
 * machine, where an unchecked value would have been remote code execution one
 * stolen cookie away. That runner is gone — the pipeline now runs in-process on
 * whatever host the app is on — but the reasoning survives the change: request
 * data still reaches a crawler that fetches URLs, spends a paid quota, and
 * writes rows. So every field is parsed into a number, a boolean, or a value
 * matched against a narrow pattern, and anything else is REJECTED rather than
 * quietly dropped.
 *
 * Rejected, not dropped, because an operator who typed a filter that failed the
 * pattern would otherwise watch a full unfiltered run start — which on extract
 * means every unverified row in the database.
 */

export const JOBS = ["extract", "discover"] as const;
export type JobName = (typeof JOBS)[number];

/** Free-text filters. Deliberately narrow — programme names, not shell. */
const FILTER_PATTERN = /^[\p{L}\p{N} .,'&()/-]{1,60}$/u;

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface ExtractArgs {
  kind: "extract";
  dryRun: boolean;
  /** Substring match on the programme title. */
  title: string | null;
  limit: number;
  pages: number;
  datesOnly: boolean;
  escalate: boolean;
  verify: boolean;
  force: boolean;
  fixUrls: boolean;
}

export interface DiscoverArgs {
  kind: "discover";
  dryRun: boolean;
  /** Substring match on the seed label. */
  seed: string | null;
  perSeed: number;
  maxListing: number;
  minConfidence: ConfidenceLevel;
  useSitemap: boolean;
}

export type JobArgs = ExtractArgs | DiscoverArgs;

export type ParseResult =
  | { ok: true; args: JobArgs }
  | { ok: false; error: string };

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** `=== true`, never truthiness: a JSON body carrying "false" must stay off. */
function bool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === true;
}

function cleanFilter(value: unknown): string | null | false {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (!trimmed) return null;

  // No real programme name starts with a dash. Nothing re-splits these into
  // arguments any more, but a value shaped like a flag is a sign the caller
  // thinks it is writing a command line, and guessing is worse than refusing.
  if (trimmed.startsWith("-")) return false;

  return FILTER_PATTERN.test(trimmed) ? trimmed : false;
}

const FILTER_REFUSED =
  "That filter contains characters this runner will not accept. Use letters, numbers, spaces and . , ' & ( ) / -";

export function parseJobRequest(body: Record<string, unknown>): ParseResult {
  const kind = body.job;
  if (typeof kind !== "string" || !(JOBS as readonly string[]).includes(kind)) {
    return { ok: false, error: `Unknown job. Expected one of: ${JOBS.join(", ")}` };
  }

  // Dry run is the default, and staying opt-OUT means a malformed request
  // writes nothing rather than everything.
  const dryRun = body.dryRun !== false;

  const filter = cleanFilter(body.filter);
  if (filter === false) return { ok: false, error: FILTER_REFUSED };

  if (kind === "extract") {
    const limit = clamp(body.count, 1, 200, 50);
    const pages = clamp(body.depth, 1, 40, 20);
    if (Number.isNaN(limit) || Number.isNaN(pages)) {
      return { ok: false, error: "Count and depth must be numbers." };
    }

    return {
      ok: true,
      args: {
        kind: "extract",
        dryRun,
        title: filter,
        limit,
        pages,
        datesOnly: bool(body.datesOnly),
        escalate: bool(body.escalate),
        verify: bool(body.verify),
        force: bool(body.force),
        // The only toggle that defaults ON: leaving a dead URL in place means
        // the row fails identically on every future run.
        fixUrls: body.fixUrls !== false,
      },
    };
  }

  const perSeed = clamp(body.count, 1, 100, 20);
  const maxListing = clamp(body.depth, 1, 30, 8);
  if (Number.isNaN(perSeed) || Number.isNaN(maxListing)) {
    return { ok: false, error: "Count and depth must be numbers." };
  }

  const confidence = body.minConfidence;
  const minConfidence: ConfidenceLevel =
    typeof confidence === "string" &&
    (CONFIDENCE_LEVELS as readonly string[]).includes(confidence)
      ? (confidence as ConfidenceLevel)
      : "low";

  return {
    ok: true,
    args: {
      kind: "discover",
      dryRun,
      seed: filter,
      perSeed,
      maxListing,
      minConfidence,
      useSitemap: body.useSitemap !== false,
    },
  };
}

/** One line describing what a job was asked to do, for the console header. */
export function describeJob(args: JobArgs): string {
  const parts: string[] = [args.kind];

  if (args.kind === "extract") {
    if (args.title) parts.push(`title~"${args.title}"`);
    parts.push(`limit ${args.limit}`, `pages ${args.pages}`);
    if (args.datesOnly) parts.push("dates only");
    if (args.escalate) parts.push("escalate");
    if (args.verify) parts.push("cross-verify");
    if (args.force) parts.push("forced");
    if (!args.fixUrls) parts.push("no URL repair");
  } else {
    if (args.seed) parts.push(`seed~"${args.seed}"`);
    parts.push(`per-seed ${args.perSeed}`, `listings ${args.maxListing}`);
    if (args.minConfidence !== "low") parts.push(`min ${args.minConfidence}`);
    if (!args.useSitemap) parts.push("no sitemap");
  }

  if (args.dryRun) parts.push("DRY RUN");
  return parts.join(" · ");
}
