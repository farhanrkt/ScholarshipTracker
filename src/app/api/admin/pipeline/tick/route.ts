import { checkAdmin } from "@/components/admin/admin-gate";
import { createClient } from "@/lib/supabase/server";
import { runTick, type JobRow } from "@/lib/pipeline/runner";

/**
 * One slice of a run.
 *
 * The console calls this repeatedly until the job reports `done`. Each call
 * claims the job, works until its budget runs out, saves the cursor and the
 * log, and returns — so a multi-minute crawl fits through a function with a
 * seconds-long ceiling, and closing the tab pauses the run instead of losing it.
 *
 * `maxDuration` is the ceiling the HOST enforces; `PIPELINE_TICK_MS` in the
 * runner is the lower budget this code holds itself to, so a unit that starts
 * near the end still gets to finish. If a deploy is rejected for exceeding the
 * plan's function limit, lower BOTH — this number and that one.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const check = await checkAdmin();
  if (!check.ok) return new Response("Reviewers only.", { status: 403 });

  let body: { jobId?: unknown };
  try {
    body = (await request.json()) as { jobId?: unknown };
  } catch {
    return new Response("Expected a JSON body.", { status: 400 });
  }

  const jobId = typeof body.jobId === "string" ? body.jobId : null;
  if (!jobId) return new Response("Expected a jobId.", { status: 400 });

  const supabase = await createClient();

  // Claiming is what stops two tabs — or a tab and a retry — working the same
  // job at once, which would crawl every site twice and stage every proposal
  // twice. A job whose heartbeat has gone quiet for five minutes was killed
  // mid-tick and is reclaimable; otherwise this returns nothing and we back off.
  const { data: claimed, error: claimError } = await supabase.rpc("claim_pipeline_tick", {
    job: jobId,
  });

  if (claimError) {
    if (/does not exist|schema cache/i.test(claimError.message)) {
      return new Response(
        "Apply supabase/migrations/012_pipeline_jobs.sql to run the pipeline from here.",
        { status: 501 },
      );
    }
    return new Response(claimError.message, { status: 500 });
  }

  const job = claimed as JobRow | null;

  if (!job?.id) {
    // Either someone else holds it, or it has already finished. Both are
    // "nothing for you to do", and the console re-reads the status to find out
    // which — so this is not an error.
    const { data: current } = await supabase
      .from("pipeline_jobs")
      .select("status, cursor, total, staged, failed, skipped, error")
      .eq("id", jobId)
      .maybeSingle();

    return Response.json({
      claimed: false,
      status: current?.status ?? "done",
      cursor: current?.cursor ?? 0,
      total: current?.total ?? 0,
      staged: current?.staged ?? 0,
      failed: current?.failed ?? 0,
      skipped: current?.skipped ?? 0,
      lines: [],
      error: current?.error ?? undefined,
    });
  }

  try {
    const result = await runTick(supabase, job);
    return Response.json({ claimed: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // A crash inside a tick must not leave the job `running` for five minutes
    // before anything can touch it again.
    await supabase
      .from("pipeline_jobs")
      .update({
        status: "failed",
        error: message,
        finished_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    return new Response(message, { status: 500 });
  }
}
