import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  assessRefresh,
  SILENT_AFTER_DAYS,
  type JobGlimpse,
  type RefreshFacts,
} from "./refresh-health.ts";

/**
 * This is the thing that decides whether anyone is told. It has two ways to
 * fail and only one of them is noisy: an alert that fires wrongly gets muted
 * within a month, and an alert that stays quiet wrongly is the outage it was
 * built for happening again. Every case below is one of those two.
 */

const NOW = "2026-11-07T09:00:00Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

function job(days: number, status = "done"): JobGlimpse {
  return { created_at: daysAgo(days), status };
}

/** A refresh that is working: ran yesterday, from the schedule, rows moving. */
function healthy(patch: Partial<RefreshFacts> = {}): RefreshFacts {
  return {
    signIn: { attempted: true, ok: true, reason: null },
    canSeeJobs: true,
    blindReason: null,
    recentJobs: [job(1), job(8), job(15)],
    lastScheduled: job(1),
    admins: 2,
    programmes: 43,
    readRecently: 12,
    ...patch,
  };
}

function problemsOf(patch: Partial<RefreshFacts> = {}): string[] {
  return assessRefresh(healthy(patch), NOW).problems;
}

describe("a refresh that is working", () => {
  test("says nothing", () => {
    const verdict = assessRefresh(healthy(), NOW);

    assert.equal(verdict.healthy, true);
    assert.deepEqual(verdict.problems, []);
  });

  test("a run that slipped by a few hours is not an outage", () => {
    // The whole reason the threshold is 8 and not 7. A cron that fires at
    // 06:00 and is read at 09:00 is eight days and three hours old on the
    // second Monday, and waking someone for that teaches them to ignore it.
    const verdict = assessRefresh(
      healthy({ recentJobs: [job(SILENT_AFTER_DAYS)], lastScheduled: job(SILENT_AFTER_DAYS) }),
      NOW,
    );

    assert.equal(verdict.healthy, true);
  });

  test("one day later it is an outage", () => {
    const verdict = assessRefresh(
      healthy({
        recentJobs: [job(SILENT_AFTER_DAYS + 1)],
        lastScheduled: job(SILENT_AFTER_DAYS + 1),
      }),
      NOW,
    );

    assert.equal(verdict.healthy, false);
    assert.match(verdict.problems.join(" "), /9 days/);
  });
});

describe("being blind is not the same as being told nothing is there", () => {
  /**
   * THE case. Every table here is behind RLS, so a session that has fallen off
   * the allowlist reads `pipeline_jobs` as zero rows rather than as an error.
   * Reporting that as "no pipeline job has ever been recorded" would be the
   * loudest possible claim about data the check cannot see.
   */
  test("an unreadable run record is reported as unreadable", () => {
    const problems = problemsOf({
      canSeeJobs: false,
      blindReason: "Confirmed, but this address is not in the admins table.",
      recentJobs: [],
      lastScheduled: null,
    });

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /invisible to this session, not empty/);
    assert.match(problems[0]!, /not in the admins table/);
  });

  test("and it does not also claim the pipeline never ran", () => {
    const problems = problemsOf({ canSeeJobs: false, recentJobs: [], lastScheduled: null });

    assert.ok(
      !problems.some((p) => /has ever been recorded|has ever come from the schedule/.test(p)),
      `a blind check must make no claim about the run record: ${problems.join(" / ")}`,
    );
  });

  test("what the public table says still counts, because RLS never hid it", () => {
    // `scholarships` is the public read path. Losing the admin session is no
    // reason to stop reporting that the catalogue has not moved in a month.
    const problems = problemsOf({
      canSeeJobs: false,
      recentJobs: [],
      lastScheduled: null,
      readRecently: 0,
    });

    assert.ok(problems.some((p) => /not one programme has been re-read/.test(p)));
  });
});

describe("the ways the refresh dies quietly", () => {
  test("jobs exist, but none of them came from the schedule", () => {
    // The real outage, exactly as it was found: twenty-three jobs, every one
    // started by a person clicking the button, none by the cron.
    const problems = problemsOf({ lastScheduled: null });

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /no run has ever come from the schedule/);
  });

  test("the schedule stopped while somebody kept pressing the button", () => {
    const problems = problemsOf({ recentJobs: [job(0)], lastScheduled: job(30) });

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /the schedule has not run for 30 days/);
  });

  test("credentials that exist and do not work are an outage on their own", () => {
    // Nothing in the run record is wrong yet — last Monday's run is still
    // there. Every Monday from here is a 501, and this is the only warning.
    const problems = problemsOf({
      signIn: { attempted: true, ok: false, reason: "The refresh account could not sign in: bad" },
    });

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /could not sign in/);
  });

  test("credentials nobody tried are not reported as broken", () => {
    // A laptop reading with the service-role key has no business claiming the
    // refresh account is fine OR broken. It did not ask.
    assert.deepEqual(
      problemsOf({ signIn: { attempted: false, ok: false, reason: null } }),
      [],
    );
  });

  test("recent failures are counted, old ones are not", () => {
    const problems = problemsOf({
      recentJobs: [job(1), job(2, "failed"), job(40, "failed")],
    });

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /1 of the last 3 jobs failed/);
  });

  test("an empty allowlist means the next run cannot sign in either", () => {
    const problems = problemsOf({ admins: 0 });

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /allowlist is empty/);
  });

  test("an allowlist nobody asked about says nothing", () => {
    assert.deepEqual(problemsOf({ admins: null }), []);
  });
});

describe("an empty catalogue", () => {
  test("is not reported as a stalled one", () => {
    // 0 of 0 rows read recently is 100% of nothing, not a frozen catalogue.
    // A fresh project would otherwise alert on its first day.
    assert.deepEqual(problemsOf({ programmes: 0, readRecently: 0 }), []);
  });
});
