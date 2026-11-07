/**
 * Is the weekly refresh alive?
 *
 * The audit's first finding was not that the scheduled refresh broke — it was
 * that it stopped nine weeks earlier and nothing said so. This is the query
 * that would have said so. Read-only, apart from the sign-in below.
 *
 *   node --env-file=.env.local scripts/audit/refresh-health.ts
 *
 * Exits 1 when the refresh looks dead, which is what makes it an alert:
 * .github/workflows/refresh-health.yml runs it daily and a non-zero exit is
 * what GitHub turns into mail. The rules it judges by live in
 * `src/lib/pipeline/refresh-health.ts`, where they are tested — deciding when
 * to wake somebody is not a thing to find out in production.
 *
 * WHICH CREDENTIAL. It prefers the refresh account's own, the ones the cron
 * uses, for two reasons. Signing in the same way the watched thing signs in
 * makes "the account has been disabled" a detectable failure instead of an
 * invisible one. And it means the daily check needs nothing stronger than an
 * ordinary allowlisted login — no service-role key in CI, where a key that
 * bypasses every policy in the schema has no business sitting. The key is
 * still accepted when it is the only thing present, as on a laptop.
 */

import { SCHEDULED_BY, STALE_AFTER_DAYS } from "../../src/lib/pipeline/jobs.ts";
import { signInAsRefreshAccount } from "../../src/lib/pipeline/refresh-account.ts";
import {
  assessRefresh,
  MOVING_WITHIN_DAYS,
  type JobGlimpse,
  type RefreshFacts,
} from "../../src/lib/pipeline/refresh-health.ts";
import { daysBetween, supabaseAdmin } from "./lib.ts";

/** One row of `why_not_admin()` — the schema's own session diagnostic (005). */
interface Standing {
  email_confirmed: boolean;
  on_allowlist: boolean;
  verdict: string;
}

async function main() {
  const now = new Date().toISOString();
  console.log(`\nREFRESH HEALTH — ${now.slice(0, 16).replace("T", " ")}\n`);

  /* -- Who are we reading as? ------------------------------------------ */

  const refresh = await signInAsRefreshAccount();
  let signIn: RefreshFacts["signIn"];
  let canSeeJobs: boolean;
  let blindReason: string | null = null;
  let supabase;

  if (refresh.ok) {
    supabase = refresh.client;
    signIn = { attempted: true, ok: true, reason: null };
    console.log(`  reading as      the refresh account (${refresh.email})`);

    // Ask the database what it makes of this session before trusting a count
    // from it. Under RLS a session that has fallen off the allowlist reads
    // every table here as zero rows, and zero rows is the same shape as a
    // pipeline that has never run.
    const { data, error } = await supabase.rpc("why_not_admin");
    const standing = (data as Standing[] | null)?.[0];
    if (error) {
      canSeeJobs = false;
      blindReason = `why_not_admin() failed: ${error.message}`;
    } else if (!standing) {
      canSeeJobs = false;
      blindReason = "why_not_admin() returned no row for this session.";
    } else {
      canSeeJobs = standing.email_confirmed && standing.on_allowlist;
      blindReason = canSeeJobs ? null : standing.verdict;
    }
    console.log(`  standing        ${blindReason ?? "admin — the run record is readable"}`);
  } else if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = supabaseAdmin();
    canSeeJobs = true; // the service-role key is not subject to a policy
    signIn = refresh.configured
      ? { attempted: true, ok: false, reason: refresh.reason }
      : { attempted: false, ok: false, reason: null };
    console.log("  reading as      the service-role key");
    console.log(
      `  refresh login   ${refresh.configured ? `FAILED — ${refresh.reason}` : "not configured here, so not checked"}`,
    );
  } else {
    console.error(
      `\n  Nothing to read with. Set CRON_SUPABASE_EMAIL and CRON_SUPABASE_PASSWORD\n` +
        `  (the refresh account, preferred) or SUPABASE_SERVICE_ROLE_KEY.\n` +
        `  ${refresh.reason}\n`,
    );
    process.exitCode = 1;
    return;
  }

  /* -- Has anything run? ------------------------------------------------ */

  const { data: jobs } = await supabase
    .from("pipeline_jobs")
    .select("id, kind, status, total, staged, error, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  const recentJobs: JobGlimpse[] = (jobs ?? []).map((j) => ({
    created_at: j.created_at,
    status: j.status,
  }));
  const latest = jobs?.[0];

  if (!canSeeJobs) {
    console.log("  last job        unreadable from here");
  } else if (!latest) {
    console.log("  last job        none, ever");
  } else {
    console.log(
      `  last job        ${latest.created_at.slice(0, 10)} ` +
        `(${daysBetween(latest.created_at, now)}d ago) · ${latest.kind} · ${latest.status} · ` +
        `staged ${latest.staged}/${latest.total}`,
    );
    // First line only, clipped: this output is published by a workflow on a
    // public repository, and a provider's error string is not ours to widen.
    if (latest.error) {
      console.log(`                  error: ${String(latest.error).split("\n")[0].slice(0, 90)}`);
    }
  }

  /* -- Did the schedule run, or did somebody press the button? ---------- */

  // `SCHEDULED_BY` is the prefix the cron route writes into `created_by`, so
  // this asks the one question a job count cannot: is the thing that is
  // supposed to run unattended actually running?
  const { data: scheduled } = await supabase
    .from("pipeline_jobs")
    .select("created_at, status")
    .like("created_by", `${SCHEDULED_BY}%`)
    .order("created_at", { ascending: false })
    .limit(1);

  const lastScheduled = (scheduled?.[0] as JobGlimpse | undefined) ?? null;
  console.log(
    `  last scheduled  ${
      !canSeeJobs
        ? "unreadable from here"
        : lastScheduled
          ? `${lastScheduled.created_at.slice(0, 10)} (${daysBetween(lastScheduled.created_at, now)}d ago) · ${lastScheduled.status}`
          : "never"
    }`,
  );

  /* -- Is the catalogue actually moving? -------------------------------- */

  // The public read path, so this answer survives losing the admin session.
  const { data: rows } = await supabase
    .from("scholarships")
    .select("id, last_verified_at, deadline_date");

  const all = rows ?? [];
  const readRecently = all.filter(
    (r) => r.last_verified_at && daysBetween(r.last_verified_at, now) <= MOVING_WITHIN_DAYS,
  ).length;
  const stale = all.filter(
    (r) => !r.last_verified_at || daysBetween(r.last_verified_at, now) > STALE_AFTER_DAYS,
  ).length;
  const today = now.slice(0, 10);
  const expired = all.filter((r) => r.deadline_date && r.deadline_date < today).length;

  console.log(`  programmes      ${all.length}`);
  console.log(
    `  read ≤${MOVING_WITHIN_DAYS}d       ${readRecently}` +
      `  (${all.length === 0 ? "—" : Math.round((100 * readRecently) / all.length)}%)`,
  );
  console.log(`  stale >${STALE_AFTER_DAYS}d     ${stale}`);
  console.log(`  deadline passed ${expired}`);

  /* -- Could the refresh sign in even if it fired? ---------------------- */

  // Count only. A note on the allowlist is somebody's description of a person,
  // and this report is printed into a public workflow log.
  const { data: admins } = await supabase.from("admins").select("email");
  const adminCount = canSeeJobs ? (admins?.length ?? 0) : null;
  console.log(`  admins          ${adminCount ?? "unreadable from here"}`);

  /* -- Verdict ----------------------------------------------------------- */

  const facts: RefreshFacts = {
    signIn,
    canSeeJobs,
    blindReason,
    recentJobs,
    lastScheduled,
    admins: adminCount,
    programmes: all.length,
    readRecently,
  };
  const { healthy, problems } = assessRefresh(facts, now);

  console.log();
  if (healthy) {
    console.log("  OK — the refresh is running and the catalogue is moving.\n");
    return;
  }
  console.log("  NOT HEALTHY:");
  for (const problem of problems) console.log(`    · ${problem}`);
  console.log();
  process.exitCode = 1;
}

await main();
