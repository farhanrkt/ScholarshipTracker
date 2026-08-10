import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { describeJob, parseJobRequest } from "@/lib/pipeline/jobs";
import { planUnits, runTick, type JobRow } from "@/lib/pipeline/runner";

/**
 * The catalogue re-reading itself, on a schedule.
 *
 * WHY THIS EXISTS. Everything else in this pipeline is started by a person
 * clicking a button, and a scholarship tracker cannot work that way. Six of the
 * sixteen deadlines in the catalogue had already passed, and nothing was ever
 * going to notice: a row read in March whose deadline expired in May keeps
 * offering that date until somebody happens to re-run the crawler over it. The
 * app was a scraper with a dashboard, not a tracker.
 *
 * WHAT IT DOES NOT DO is apply anything. It stages proposals exactly like a
 * manual run, and they wait in `/admin/review` for a human. An automatic writer
 * of scholarship deadlines is the one thing this codebase has been built
 * throughout to avoid.
 *
 * WHAT IT RUNS AS, and this is the part that took a rewrite. Every other route
 * here runs as the signed-in admin, through the same RLS policies the review UI
 * uses, and `docs/deployment.md` makes a point of the service-role key never
 * reaching the deployed app — `grep -rn "SERVICE_ROLE" src/` should find only
 * comments. A cron has no session, and reaching for that key would have quietly
 * ended that guarantee for the sake of one endpoint.
 *
 * So it signs in as a real account instead: an ordinary Supabase user on the
 * `admins` allowlist, whose credentials live in the environment. RLS still
 * applies to every write, the run is attributable to a named actor in
 * `pipeline_jobs.created_by`, and revoking it is removing one row from the
 * allowlist rather than rotating a key that bypasses the entire schema.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * How many rows one scheduled run will re-read.
 *
 * Small on purpose. The point is a steady trickle that keeps the catalogue
 * honest, not a weekly stampede at every funder's website — and a free-tier
 * model quota is the other ceiling. At a dozen a day the whole catalogue turns
 * over comfortably inside the ninety-day staleness window.
 */
const ROWS_PER_RUN = Number(process.env.CRON_REFRESH_LIMIT) || 12;

/**
 * Stop starting new ticks with this much of the budget left.
 *
 * A tick holds itself to 210s and is only interruptible BETWEEN units, so
 * starting one with less than that remaining means the function is killed
 * mid-crawl and that unit's work is lost. Whatever is left simply waits for the
 * next scheduled run — the cursor is in Postgres.
 */
const TICK_HEADROOM_MS = 240_000;

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;

  // No secret configured means no scheduled refresh. Failing closed matters
  // here: this endpoint spends a model quota and hits other people's servers.
  if (!secret) return false;

  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

/**
 * A client bound to the refresh account's own session.
 *
 * The anon key plus a sign-in, exactly as a browser would do it — so every
 * statement this route runs is checked by the same policies that guard a human
 * admin. Returns a reason rather than throwing, because "the refresh account is
 * not configured" and "its password is wrong" want different fixes and a cron
 * failure nobody is watching should say which.
 */
async function signInAsRefreshAccount(): Promise<
  { ok: true; client: SupabaseClient } | { ok: false; reason: string }
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = process.env.CRON_SUPABASE_EMAIL;
  const password = process.env.CRON_SUPABASE_PASSWORD;

  if (!url || !key) {
    return { ok: false, reason: "Supabase is not configured for this deployment." };
  }
  if (!email || !password) {
    return {
      ok: false,
      reason:
        "The scheduled refresh needs CRON_SUPABASE_EMAIL and CRON_SUPABASE_PASSWORD — " +
        "a Supabase account on the `admins` allowlist. See docs/deployment.md.",
    };
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    return { ok: false, reason: `The refresh account could not sign in: ${error.message}` };
  }

  return { ok: true, client };
}

export async function GET(request: Request) {
  if (!authorised(request)) {
    return new Response("Not authorised.", { status: 401 });
  }

  const session = await signInAsRefreshAccount();
  if (!session.ok) return new Response(session.reason, { status: 501 });
  const supabase = session.client;

  // A run already in flight is not a failure. The unique index in migration 012
  // allows one live job at a time — on purpose, so two crawls never double the
  // request rate at the same funders — and a manual run in progress simply
  // means this week's refresh waits for the next tick of the schedule.
  const { data: live } = await supabase
    .from("pipeline_jobs")
    .select("id, kind, status")
    .in("status", ["queued", "running"])
    .maybeSingle();

  if (live) {
    return Response.json({
      skipped: true,
      reason: `A ${live.kind} run is already in flight.`,
    });
  }

  const parsed = parseJobRequest({
    job: "extract",
    dryRun: false,
    staleOnly: true,
    count: ROWS_PER_RUN,
    // Cheap first. Escalation is a manual decision about spending money, and
    // nobody is watching this run make it.
    escalate: false,
  });

  if (!parsed.ok) return new Response(parsed.error, { status: 500 });

  const plan = await planUnits(supabase, parsed.args);
  if (plan.units.length === 0) {
    return Response.json({ staged: 0, notes: plan.notes, nothingToDo: true });
  }

  const { data: job, error } = await supabase
    .from("pipeline_jobs")
    .insert({
      kind: "extract",
      args: { ...parsed.args },
      units: plan.units.map((unit) => ({ ...unit })),
      total: plan.units.length,
      status: "queued",
      created_by: process.env.CRON_SUPABASE_EMAIL ?? "scheduled refresh",
    })
    .select("*")
    .single();

  if (error) return new Response(error.message, { status: 500 });

  // Tick it here rather than leaving it queued for a browser to pick up: the
  // whole point is that nobody is watching.
  const startedAt = Date.now();
  let current = job as JobRow;
  let ticks = 0;

  while (
    (current.status === "queued" || current.status === "running") &&
    Date.now() - startedAt < TICK_HEADROOM_MS
  ) {
    const { data: claimed } = await supabase.rpc("claim_pipeline_tick", {
      job: current.id,
    });
    if (!claimed) break;

    const result = await runTick(supabase, claimed as JobRow);
    ticks++;
    current = { ...current, ...result } as JobRow;
    if (result.status !== "running") break;
  }

  return Response.json({
    job: current.id,
    description: describeJob(parsed.args),
    notes: plan.notes,
    ticks,
    status: current.status,
    staged: current.staged,
    failed: current.failed,
    skipped: current.skipped,
    cursor: current.cursor,
    total: current.total,
  });
}
