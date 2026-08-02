/**
 * The two pipeline scripts, and the only arguments the web UI may give them.
 *
 * WHY A WHITELIST AND NOT A COMMAND STRING. This turns an HTTP request into a
 * process on the machine running the app. The moment any part of that command
 * is assembled from request data, an admin session becomes remote code
 * execution — and "admin only" is not a defence, it is one stolen cookie away
 * from being no defence at all.
 *
 * So: the script is chosen from a fixed map, every flag is a literal defined
 * here, and every value is parsed into a number or matched against a narrow
 * pattern before it is allowed near the argument list. Nothing is interpolated
 * into a string, and the child is spawned WITHOUT a shell, so quoting bugs
 * cannot become injection bugs either.
 */

export const JOBS = ["extract", "discover"] as const;
export type JobName = (typeof JOBS)[number];

export const JOB_SCRIPTS: Record<JobName, string> = {
  extract: "scripts/extract/run.ts",
  discover: "scripts/discover/run.ts",
};

/** Free-text filters. Deliberately narrow — programme names, not shell. */
const FILTER_PATTERN = /^[\p{L}\p{N} .,'&()/-]{1,60}$/u;

export interface JobRequest {
  job: JobName;
  dryRun: boolean;
  /** --title for extract, --seed for discover. */
  filter?: string;
  /** --limit for extract, --per-seed for discover. */
  count?: number;
  /** --pages for extract, --max-listing for discover. */
  depth?: number;
  /** extract only. */
  datesOnly?: boolean;
  escalate?: boolean;
}

export interface BuiltJob {
  args: string[];
  /** Human-readable command, for the log header. Never executed. */
  display: string;
}

function clamp(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function cleanFilter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // A value that looks like a flag is not exploitable — argv elements are never
  // re-split, so "--provider x" arrives at the script as one string and is read
  // as the title it was passed as. It is refused anyway: the day someone parses
  // these differently, this is the line that would have stopped it, and no real
  // programme name starts with a dash.
  if (trimmed.startsWith("-")) return null;

  return FILTER_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Turns a request into an argv array, or explains why it will not.
 *
 * Invalid input is REJECTED, never silently dropped: an operator who typed a
 * filter that failed the pattern would otherwise watch a full unfiltered run
 * start, which on the extract job means every unverified row in the database.
 */
export function buildJob(
  body: Record<string, unknown>,
): { ok: true; built: BuiltJob; job: JobName } | { ok: false; error: string } {
  const job = body.job;
  if (typeof job !== "string" || !(JOBS as readonly string[]).includes(job)) {
    return { ok: false, error: `Unknown job. Expected one of: ${JOBS.join(", ")}` };
  }
  const name = job as JobName;

  const args: string[] = [];

  // Dry run is the default in the UI, and staying opt-out here means a
  // malformed request writes nothing rather than everything.
  if (body.dryRun !== false) args.push("--dry-run");

  if (body.filter !== undefined && body.filter !== "") {
    const filter = cleanFilter(body.filter);
    if (!filter) {
      return {
        ok: false,
        error:
          "That filter contains characters this runner will not pass to a script. Use letters, numbers, spaces and . , ' & ( ) / -",
      };
    }
    args.push(name === "extract" ? "--title" : "--seed", filter);
  }

  if (body.count !== undefined && body.count !== "") {
    const count = clamp(body.count, 1, name === "extract" ? 200 : 100);
    if (count === null) return { ok: false, error: "Count must be a number." };
    args.push(name === "extract" ? "--limit" : "--per-seed", String(count));
  }

  if (body.depth !== undefined && body.depth !== "") {
    const depth = clamp(body.depth, 1, name === "extract" ? 40 : 30);
    if (depth === null) return { ok: false, error: "Depth must be a number." };
    args.push(name === "extract" ? "--pages" : "--max-listing", String(depth));
  }

  if (name === "extract") {
    if (body.datesOnly === true) args.push("--dates-only");
    if (body.escalate === true) args.push("--escalate");
  }

  return {
    ok: true,
    job: name,
    built: {
      args,
      display: `npm run ${name} -- ${args.join(" ")}`.trim(),
    },
  };
}
