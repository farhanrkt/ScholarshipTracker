import { checkAdmin } from "@/components/admin/admin-gate";
import { createClient } from "@/lib/supabase/server";

/**
 * Stop a run.
 *
 * Cancelling sets the status and nothing else: the tick in flight notices
 * before it starts its next batch and stops there. It does not try to interrupt
 * work already underway, because a crawl mid-programme has pages fetched and a
 * model call outstanding, and abandoning it saves nothing while losing the
 * proposal it was about to stage.
 *
 * Everything already staged stays staged. A cancelled run is a run that stopped
 * early, not one that is rolled back — the proposals it made are as reviewable
 * as any other.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const { error } = await supabase
    .from("pipeline_jobs")
    .update({ status: "cancelled", finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["queued", "running"]);

  if (error) return new Response(error.message, { status: 500 });

  return Response.json({ cancelled: true });
}
