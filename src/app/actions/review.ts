"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/lib/types/actions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both actions run as the caller, so RLS is the real gate — a non-admin
 * reaching these gets a permission error from Postgres rather than a silent
 * success. The checks here are for a clear message, not for security.
 */

export async function applyExtraction(
  extractionId: string,
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(extractionId)) return fail("Invalid extraction id.");

    const supabase = await createClient();
    const { error } = await supabase.rpc("apply_extraction", {
      extraction_id: extractionId,
    });

    if (error) return fail(error.message);

    revalidatePath("/admin/review");
    revalidatePath("/dashboard");
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not apply it.");
  }
}

/**
 * Promoting a candidate creates a dateless, unverified skeleton — discovery
 * establishes that a programme exists, nothing more. Dates arrive later, from
 * extraction, with quotes attached.
 */
export async function promoteCandidate(
  candidateId: string,
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(candidateId)) return fail("Invalid candidate id.");

    const supabase = await createClient();
    const { error } = await supabase.rpc("promote_candidate", {
      candidate_id: candidateId,
    });

    if (error) return fail(error.message);

    revalidatePath("/admin/candidates");
    revalidatePath("/dashboard");
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not promote it.");
  }
}

export async function rejectCandidate(
  candidateId: string,
  why: string,
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(candidateId)) return fail("Invalid candidate id.");

    const supabase = await createClient();
    const { error } = await supabase.rpc("reject_candidate", {
      candidate_id: candidateId,
      why: why.trim() || null,
    });

    if (error) return fail(error.message);

    revalidatePath("/admin/candidates");
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not reject it.");
  }
}

/**
 * The last step the pipeline is not allowed to take: a person says the row is
 * right.
 *
 * `verified` is the only status that does not come from a machine. Extraction
 * lands rows at `ai_extracted` — every value quoted, nothing confirmed — and
 * until now there was no way to move one past that except by hand in SQL, which
 * is why a database of programmes had exactly one verified row. This is that
 * missing step, and it deliberately does two writes at once: the status AND the
 * date, because a `verified` row with a stale `last_verified_at` would render
 * as freshly checked forever.
 *
 * The RLS policy from migration 003 is the real gate — a non-admin's UPDATE is
 * refused by Postgres, not by this function.
 */
export async function markVerified(scholarshipId: string): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(scholarshipId)) return fail("Invalid scholarship id.");

    const supabase = await createClient();
    const { error } = await supabase
      .from("scholarships")
      .update({
        verification_status: "verified",
        last_verified_at: new Date().toISOString(),
      })
      .eq("id", scholarshipId);

    if (error) return fail(error.message);

    revalidatePath("/admin/verify");
    revalidatePath("/dashboard");
    revalidatePath("/my-tracker");
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not verify it.");
  }
}

/**
 * Takes a row back out of `verified` — because a human check expires.
 *
 * Where it lands depends on what is underneath it. A row an extraction has read
 * returns to `ai_extracted`: the quotes are still there and still true of the
 * page they came from, so calling it `unverified` would throw away real
 * provenance. A row nothing has read returns to `unverified`, and its
 * `last_verified_at` is cleared with it — leaving a date behind would render as
 * "checked on such-and-such" under a status that says nobody has.
 */
export async function markNeedsCheck(
  scholarshipId: string,
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(scholarshipId)) return fail("Invalid scholarship id.");

    const supabase = await createClient();

    const { data: row, error: readError } = await supabase
      .from("scholarships")
      .select("source_url")
      .eq("id", scholarshipId)
      .maybeSingle();

    if (readError) return fail(readError.message);
    if (!row) return fail("That scholarship no longer exists.");

    const wasExtracted = Boolean(row.source_url);

    const { error } = await supabase
      .from("scholarships")
      .update(
        wasExtracted
          ? { verification_status: "ai_extracted" }
          : { verification_status: "unverified", last_verified_at: null },
      )
      .eq("id", scholarshipId);

    if (error) return fail(error.message);

    revalidatePath("/admin/verify");
    revalidatePath("/dashboard");
    revalidatePath("/my-tracker");
    return ok();
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Could not change the status.",
    );
  }
}

export async function rejectExtraction(
  extractionId: string,
  why: string,
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(extractionId)) return fail("Invalid extraction id.");

    const supabase = await createClient();
    const { error } = await supabase.rpc("reject_extraction", {
      extraction_id: extractionId,
      why: why.trim() || null,
    });

    if (error) return fail(error.message);

    revalidatePath("/admin/review");
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not reject it.");
  }
}
