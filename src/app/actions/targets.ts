"use server";

import { revalidatePath } from "next/cache";

import { createClient, getCurrentUserId } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/lib/types/actions";
import {
  TARGET_STATUSES,
  type ChecklistProgress,
  type TargetStatus,
} from "@/lib/types/database";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function revalidate() {
  revalidatePath("/dashboard");
  revalidatePath("/my-tracker");
}

/** Start tracking a scholarship against the caller's (possibly ghost) account. */
export async function trackScholarship(
  scholarshipId: string,
): Promise<ActionResult<{ trackedAt: string }>> {
  try {
    if (!UUID_PATTERN.test(scholarshipId)) {
      return fail("That scholarship id is not valid.");
    }

    const userId = await getCurrentUserId();
    if (!userId) {
      return fail("We could not start a session for you. Please reload the page.");
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("user_targets")
      .upsert(
        { user_id: userId, scholarship_id: scholarshipId, status: "saved" },
        { onConflict: "user_id,scholarship_id", ignoreDuplicates: true },
      )
      .select("created_at")
      .maybeSingle();

    if (error) return fail(error.message);

    revalidate();
    return ok({ trackedAt: data?.created_at ?? new Date().toISOString() });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not track this scholarship.");
  }
}

export async function untrackScholarship(
  scholarshipId: string,
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(scholarshipId)) {
      return fail("That scholarship id is not valid.");
    }

    const userId = await getCurrentUserId();
    if (!userId) return fail("No active session. Please reload the page.");

    const supabase = await createClient();
    const { error } = await supabase
      .from("user_targets")
      .delete()
      .eq("user_id", userId)
      .eq("scholarship_id", scholarshipId);

    if (error) return fail(error.message);

    revalidate();
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not untrack this scholarship.");
  }
}

export async function updateTargetStatus(
  targetId: string,
  status: TargetStatus,
): Promise<ActionResult> {
  try {
    if (!UUID_PATTERN.test(targetId)) return fail("That target id is not valid.");
    if (!TARGET_STATUSES.includes(status)) return fail(`Unknown status "${status}".`);

    const userId = await getCurrentUserId();
    if (!userId) return fail("No active session. Please reload the page.");

    const supabase = await createClient();
    const { error } = await supabase
      .from("user_targets")
      .update({ status })
      .eq("id", targetId)
      .eq("user_id", userId);

    if (error) return fail(error.message);

    revalidate();
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not update the status.");
  }
}

/**
 * Flip one document in `checklist_progress`.
 *
 * Read-modify-write on the JSONB blob, scoped by `user_id` so RLS and the
 * predicate agree. The UI is optimistic, so this only has to be correct, not fast.
 */
export async function toggleChecklistItem(
  targetId: string,
  documentKey: string,
  checked: boolean,
): Promise<ActionResult<ChecklistProgress>> {
  try {
    if (!UUID_PATTERN.test(targetId)) return fail("That target id is not valid.");
    if (!documentKey.trim()) return fail("Missing document key.");

    const userId = await getCurrentUserId();
    if (!userId) return fail("No active session. Please reload the page.");

    const supabase = await createClient();

    const { data: existing, error: readError } = await supabase
      .from("user_targets")
      .select("checklist_progress")
      .eq("id", targetId)
      .eq("user_id", userId)
      .single();

    if (readError) return fail(readError.message);

    const nextProgress: ChecklistProgress = {
      ...(existing?.checklist_progress ?? {}),
      [documentKey]: checked,
    };

    const { error: writeError } = await supabase
      .from("user_targets")
      .update({ checklist_progress: nextProgress })
      .eq("id", targetId)
      .eq("user_id", userId);

    if (writeError) return fail(writeError.message);

    revalidatePath("/my-tracker");
    return ok(nextProgress);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not save your checklist.");
  }
}
