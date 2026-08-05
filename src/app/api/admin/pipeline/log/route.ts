import { checkAdmin } from "@/components/admin/admin-gate";
import { createClient } from "@/lib/supabase/server";

/**
 * The log of a run, from wherever the reader got to.
 *
 * A tick returns the lines it produced, so the console usually never needs
 * this. It exists for the case the streaming design used to fail at outright:
 * reopening the page while a run is in progress, on a different device, or
 * after the tab that started it was closed. The log lives in the database, so
 * there is something to come back to.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One request cannot drag the whole log of a long run into memory. */
const PAGE = 500;

export async function GET(request: Request) {
  const check = await checkAdmin();
  if (!check.ok) return new Response("Reviewers only.", { status: 403 });

  const url = new URL(request.url);
  const jobId = url.searchParams.get("job");
  if (!jobId) return new Response("Expected ?job=<id>.", { status: 400 });

  const after = Number(url.searchParams.get("after") ?? -1);

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("pipeline_job_lines")
    .select("seq, line")
    .eq("job_id", jobId)
    .gt("seq", Number.isFinite(after) ? after : -1)
    .order("seq", { ascending: true })
    .limit(PAGE);

  if (error) return new Response(error.message, { status: 500 });

  const lines = data ?? [];

  return Response.json({
    lines: lines.map((row) => row.line),
    lastSeq: lines.length > 0 ? lines[lines.length - 1]!.seq : after,
    more: lines.length === PAGE,
  });
}
