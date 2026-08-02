/**
 * Standard envelope every Server Action returns. Actions never throw across the
 * network boundary -- they catch and report.
 */
export type ActionResult<T = undefined> =
  | { success: true; data?: T; error?: never }
  | { success: false; data?: never; error: string };

export function ok<T>(data?: T): ActionResult<T> {
  return { success: true, data };
}

export function fail<T = undefined>(error: string): ActionResult<T> {
  return { success: false, error };
}
