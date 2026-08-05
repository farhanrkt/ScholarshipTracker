import { checkAdmin } from "@/components/admin/admin-gate";
import { createClient } from "@/lib/supabase/server";
import { describeJob, parseJobRequest } from "@/lib/pipeline/jobs";
import { planUnits } from "@/lib/pipeline/runner";

/**
 * Starting a run, and asking what is running.
 *
 * The old version of this file spawned `node scripts/extract/run.ts` and
 * streamed its stdout, which worked on exactly one machine — the developer's. A
 * serverless host has no repo to spawn from, a read-only filesystem, and a
 * timeout measured in seconds, so the deployed app could look at the data but
 * never gather it.
 *
 * A run is now a ROW: this route decides what the run will do, writes it down,
 * and returns immediately. `tick` does the work, in as many calls as it takes.
 * Nothing here holds a connection open for minutes, so it behaves identically
 * on a laptop and on Vercel — which is the entire point.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const check = await checkAdmin();
  if (!check.ok) return new Response("Reviewers only.", { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response("Expected a JSON body.", { status: 400 });
  }

  const parsed = parseJobRequest(body);
  if (!parsed.ok) return new Response(parsed.error, { status: 400 });

  const supabase = await createClient();

  let plan;
  try {
    plan = await planUnits(supabase, parsed.args);
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Could not plan the run.",
      { status: 500 },
    );
  }

  if (plan.units.length === 0) {
    return Response.json({
      empty: true,
      notes:
        plan.notes.length > 0
          ? plan.notes
          : ["Nothing matches — there is no work to do."],
    });
  }

  const { data, error } = await supabase
    .from("pipeline_jobs")
    .insert({
      kind: parsed.args.kind,
      // A JSONB column takes any object; the row type asks for an index
      // signature that a discriminated union deliberately does not have.
      args: { ...parsed.args },
      units: plan.units.map((unit) => ({ ...unit })),
      total: plan.units.length,
      status: "queued",
      created_by: check.email,
    })
    .select("id, kind, status, cursor, total, staged, failed, skipped")
    .single();

  if (error) {
    // The partial unique index in migration 012 is what refuses a second live
    // run. Two crawls at once would double the request rate at the same funders
    // and race each other through one free-tier quota.
    if (/duplicate key|unique/i.test(error.message)) {
      return new Response(
        "A run is already in flight. Wait for it to finish, or cancel it first.",
        { status: 409 },
      );
    }
    if (/does not exist|schema cache/i.test(error.message)) {
      return new Response(
        "The pipeline_jobs table is missing. Apply supabase/migrations/012_pipeline_jobs.sql in the Supabase SQL editor.",
        { status: 501 },
      );
    }
    return new Response(error.message, { status: 500 });
  }

  return Response.json({
    job: data,
    description: describeJob(parsed.args),
    notes: plan.notes,
  });
}

/** What is running now, and what ran before it. */
export async function GET() {
  const check = await checkAdmin();
  if (!check.ok) return new Response("Reviewers only.", { status: 403 });

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("pipeline_jobs")
    .select(
      "id, kind, status, args, cursor, total, staged, failed, skipped, error, created_by, created_at, started_at, finished_at",
    )
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    // Almost always the missing migration. Say which one rather than showing a
    // PostgREST error to someone who has no reason to recognise it.
    return Response.json({
      available: false,
      reason: /does not exist|schema cache/i.test(error.message)
        ? "Apply supabase/migrations/012_pipeline_jobs.sql to run the pipeline from here."
        : error.message,
      jobs: [],
      live: null,
    });
  }

  const jobs = data ?? [];
  return Response.json({
    available: true,
    live:
      jobs.find((job) => job.status === "queued" || job.status === "running") ?? null,
    jobs,
  });
}
