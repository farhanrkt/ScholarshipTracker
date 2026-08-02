import { createClient, getCurrentUserId } from "@/lib/supabase/server";
import type { UserTargetWithScholarship } from "@/lib/types/database";

/** Scholarship ids the current user already tracks -- used to light up the dashboard. */
export async function fetchTrackedScholarshipIds(): Promise<Set<string>> {
  const userId = await getCurrentUserId();
  if (!userId) return new Set();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_targets")
    .select("scholarship_id")
    .eq("user_id", userId);

  if (error || !data) return new Set();

  return new Set(data.map((row) => row.scholarship_id));
}

export async function fetchUserTargets(): Promise<UserTargetWithScholarship[]> {
  const userId = await getCurrentUserId();
  if (!userId) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_targets")
    .select("*, scholarship:scholarships(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load your tracker: ${error.message}`);
  }

  // Rows whose scholarship was deleted underneath us are dropped rather than
  // rendered as an empty card.
  return (data ?? []).filter((row) => Boolean(row.scholarship)) as UserTargetWithScholarship[];
}
