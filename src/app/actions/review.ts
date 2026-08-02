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
