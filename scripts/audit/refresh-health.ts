/**
 * Is the weekly refresh alive?
 *
 * The audit's first finding was not that the scheduled refresh broke — it was
 * that it stopped nine weeks earlier and nothing said so. This is the query
 * that would have said so. Read-only; run it after switching the cron on to
 * confirm it worked, and on a schedule afterwards so silence is noticed.
 *
 * "Has anything run?" and "did the SCHEDULE run?" are asked separately, which
 * matters when the refresh account is also the admin's own account: a person
 * clicking the button in /admin would otherwise keep this green over a cron
 * that has been dead for months.
 *
 *   node --env-file=.env.local scripts/audit/refresh-health.ts
 *
 * Exits 1 when the refresh looks dead, so it can back an alert unchanged.
 */

import { SCHEDULED_BY, STALE_AFTER_DAYS } from "../../src/lib/pipeline/jobs.ts";
import { daysBetween, supabaseAdmin } from "./lib.ts";

/**
 * The cron is weekly, so one missed Monday is a blip and two is a failure.
 * Eight days rather than seven: a run that slips by a few hours should not
 * page anyone.
 */
const SILENT_AFTER_DAYS = 8;

async function main() {
  const supabase = supabaseAdmin();
  const now = new Date().toISOString();
  const problems: string[] = [];

  /* -- Has anything run? ---------------------------------------------- */

  const { data: jobs, error } = await supabase
    .from("pipeline_jobs")
    .select("id, kind, status, total, staged, failed, skipped, error, created_at, finished_at")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;

  const latest = jobs?.[0];
  console.log(`\nREFRESH HEALTH — ${now.slice(0, 16).replace("T", " ")}\n`);

  if (!latest) {
    problems.push("no pipeline job has ever been recorded");
    console.log("  jobs            none, ever");
  } else {
    const age = daysBetween(latest.created_at, now);
    console.log(
      `  last job        ${latest.created_at.slice(0, 10)} (${age}d ago) · ` +
        `${latest.kind} · ${latest.status} · staged ${latest.staged}/${latest.total}`,
    );
    if (latest.error) console.log(`                  error: ${String(latest.error).split("\n")[0].slice(0, 90)}`);
    if (age > SILENT_AFTER_DAYS) {
      problems.push(`nothing has run at all for ${age} days, scheduled or by hand`);
    }
  }

  const failedRecently = (jobs ?? []).filter(
    (job) => job.status === "failed" && daysBetween(job.created_at, now) <= SILENT_AFTER_DAYS,
  );
  if (failedRecently.length > 0) {
    problems.push(`${failedRecently.length} of the last ${jobs?.length} jobs failed`);
  }

  /* -- Did the schedule run, or did somebody press the button? --------- */

  // `SCHEDULED_BY` is the prefix the cron route writes into `created_by`, so
  // this asks the one question a job count cannot: is the thing that is
  // supposed to run unattended actually running?
  const { data: scheduled } = await supabase
    .from("pipeline_jobs")
    .select("created_at, status")
    .like("created_by", `${SCHEDULED_BY}%`)
    .order("created_at", { ascending: false })
    .limit(1);

  const lastScheduled = scheduled?.[0];
  if (!lastScheduled) {
    console.log("  last scheduled  never");
    problems.push(
      "no run has ever come from the schedule — see docs/deployment.md for the three variables it needs",
    );
  } else {
    const age = daysBetween(lastScheduled.created_at, now);
    console.log(
      `  last scheduled  ${lastScheduled.created_at.slice(0, 10)} (${age}d ago) · ${lastScheduled.status}`,
    );
    if (age > SILENT_AFTER_DAYS) {
      problems.push(
        `the schedule has not run for ${age} days (weekly cron; over ${SILENT_AFTER_DAYS} means it is not firing)`,
      );
    }
  }

  /* -- Is the catalogue actually moving? ------------------------------- */

  const { data: rows } = await supabase
    .from("scholarships")
    .select("id, title, last_verified_at, deadline_date, verification_status");

  const all = rows ?? [];
  const read30 = all.filter((r) => r.last_verified_at && daysBetween(r.last_verified_at, now) <= 30);
  const stale = all.filter(
    (r) => !r.last_verified_at || daysBetween(r.last_verified_at, now) > STALE_AFTER_DAYS,
  );
  const today = now.slice(0, 10);
  const expired = all.filter((r) => r.deadline_date && r.deadline_date < today);

  console.log(`  programmes      ${all.length}`);
  console.log(`  read ≤30d       ${read30.length}  (${Math.round((100 * read30.length) / all.length)}%)`);
  console.log(`  stale >${STALE_AFTER_DAYS}d     ${stale.length}`);
  console.log(`  deadline passed ${expired.length}`);

  if (read30.length === 0 && all.length > 0) {
    problems.push("not one programme has been re-read in the last 30 days");
  }

  /* -- Could the refresh sign in even if it fired? --------------------- */

  const { data: admins } = await supabase.from("admins").select("email, note");
  console.log(`  admins          ${admins?.length ?? 0} (${(admins ?? []).map((a) => a.note ?? "—").join(", ")})`);
  if ((admins?.length ?? 0) === 0) {
    problems.push("the admins allowlist is empty, so the refresh account cannot sign in");
  }

  /* -- Verdict ---------------------------------------------------------- */

  console.log();
  if (problems.length === 0) {
    console.log("  OK — the refresh is running and the catalogue is moving.\n");
    return;
  }
  console.log("  NOT HEALTHY:");
  for (const problem of problems) console.log(`    · ${problem}`);
  console.log();
  process.exitCode = 1;
}

await main();
