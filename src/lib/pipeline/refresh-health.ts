/**
 * Deciding whether the weekly refresh is still alive.
 *
 * The audit's first finding was not that the scheduled refresh broke — it was
 * that it stopped nine weeks earlier and nothing said so. This is the judgement
 * an alert runs on, kept apart from the queries that feed it so the rules can
 * be tested: when to wake somebody is not a thing to find out in production.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE is that an empty answer and a forbidden
 * one are not the same answer. Every table here is behind RLS, so a session
 * that is not on the `admins` allowlist reads `pipeline_jobs` as zero rows, not
 * as an error. A check that cannot tell those apart reports "no pipeline job
 * has ever been recorded" at the exact moment it has gone blind — the loudest
 * possible alert for the one thing that is not wrong. So blindness is its own
 * verdict and it suppresses every claim that depends on seeing the run record.
 */

/**
 * The cron is weekly, so one missed Monday is a blip and two is a failure.
 * Eight days rather than seven: a run that slips by a few hours should not
 * wake anyone.
 *
 * This is the SENSITIVITY. How often the check runs is a separate question —
 * see .github/workflows/refresh-health.yml — and conflating the two is how a
 * weekly check of an 8-day rule ends up taking a fortnight to notice.
 */
export const SILENT_AFTER_DAYS = 8;

/** Rows re-read inside this many days is the "is the catalogue moving" test. */
export const MOVING_WITHIN_DAYS = 30;

/** Just enough of a `pipeline_jobs` row to judge it by. */
export interface JobGlimpse {
  created_at: string;
  status: string;
}

export interface RefreshFacts {
  /**
   * What happened when we tried the refresh account's own credentials.
   *
   * `attempted: false` means this environment holds none to try — true of a
   * laptop reading with the service-role key, and a finding in itself nowhere
   * except the deployment that is supposed to have them.
   */
  signIn: { attempted: boolean; ok: boolean; reason: string | null };
  /** False when this session cannot read `pipeline_jobs` at all. */
  canSeeJobs: boolean;
  /** The database's own account of why, from `why_not_admin()`. */
  blindReason: string | null;
  /** Newest first. */
  recentJobs: JobGlimpse[];
  /** Newest run whose `created_by` says the schedule started it. */
  lastScheduled: JobGlimpse | null;
  /** Rows on the `admins` allowlist, or null when it was not asked for. */
  admins: number | null;
  programmes: number;
  readRecently: number;
}

export interface RefreshAssessment {
  healthy: boolean;
  problems: string[];
}

/**
 * Whole days between two instants.
 *
 * Local rather than `format.ts`'s date helpers on purpose: those round a
 * calendar date to UTC midnight because a deadline is a day, while these are
 * timestamps and an age of "0 days" has to mean the job ran within the hour.
 */
function daysBetween(earlier: string, later: string | Date): number {
  return Math.floor((new Date(later).getTime() - new Date(earlier).getTime()) / 86_400_000);
}

export function assessRefresh(facts: RefreshFacts, now: string | Date): RefreshAssessment {
  const problems: string[] = [];

  // Credentials that exist and do not work are a dead refresh, whatever the
  // run record says: every Monday from here on returns 501 and writes nothing.
  if (facts.signIn.attempted && !facts.signIn.ok) {
    problems.push(facts.signIn.reason ?? "the refresh account could not sign in");
  }

  if (!facts.canSeeJobs) {
    problems.push(
      "the run record is invisible to this session, not empty — nothing below it can be " +
        `concluded${facts.blindReason ? `. ${facts.blindReason}` : ""}`,
    );
  } else {
    const latest = facts.recentJobs[0];

    if (!latest) {
      problems.push("no pipeline job has ever been recorded");
    } else {
      const age = daysBetween(latest.created_at, now);
      if (age > SILENT_AFTER_DAYS) {
        problems.push(`nothing has run at all for ${age} days, scheduled or by hand`);
      }
    }

    const failedRecently = facts.recentJobs.filter(
      (job) => job.status === "failed" && daysBetween(job.created_at, now) <= SILENT_AFTER_DAYS,
    );
    if (failedRecently.length > 0) {
      problems.push(`${failedRecently.length} of the last ${facts.recentJobs.length} jobs failed`);
    }

    // The question a job count cannot answer. A sole admin whose own account
    // also drives the cron would otherwise keep this green by clicking the
    // button in /admin — which is how twenty-three jobs hid a dead schedule.
    if (!facts.lastScheduled) {
      problems.push(
        "no run has ever come from the schedule — see docs/deployment.md for the three " +
          "variables it needs",
      );
    } else {
      const age = daysBetween(facts.lastScheduled.created_at, now);
      if (age > SILENT_AFTER_DAYS) {
        problems.push(
          `the schedule has not run for ${age} days (weekly cron; over ` +
            `${SILENT_AFTER_DAYS} means it is not firing)`,
        );
      }
    }
  }

  // Reads the public table, so this survives being blind to the run record —
  // and it is the finding that actually reaches a student: a catalogue nobody
  // has re-read is a catalogue of last season's deadlines.
  if (facts.programmes > 0 && facts.readRecently === 0) {
    problems.push(
      `not one programme has been re-read in the last ${MOVING_WITHIN_DAYS} days`,
    );
  }

  if (facts.admins === 0) {
    problems.push("the admins allowlist is empty, so the refresh account cannot sign in");
  }

  return { healthy: problems.length === 0, problems };
}
