/**
 * Shared plumbing for the Phase 1 audit scripts (docs/audit-2026-10-30.md).
 *
 * These scripts only ever read. Nothing here inserts, updates, deletes or calls
 * an RPC, because the audit ran against the live project and a measurement that
 * changes what it measures is not a measurement.
 *
 * Run them the way the other scripts in this repo are run:
 *
 *   node --env-file=.env.local scripts/audit/<script>.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** The day the audit was taken. Fixed so re-runs are comparable, not "today". */
export const AS_OF = "2026-10-30";

export const EVIDENCE_DIR = `docs/audit-${AS_OF}`;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing ${name}. Add it to .env.local — see .env.example.\n`);
    process.exit(1);
  }
  return value;
}

/**
 * The service-role key, as `scripts/extract/run.ts` uses it.
 *
 * Needed because `scholarship_extractions` is deny-all to the public API and
 * the quote-drift measurement has to read its `evidence` column.
 */
export function supabaseAdmin(): SupabaseClient {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

/** The anon key — the same public read path an external agent uses. */
export function supabaseAnon(): SupabaseClient {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } },
  );
}

export function writeEvidence(name: string, data: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = `${EVIDENCE_DIR}/${name}`;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\nwrote ${path}`);
}

/** Whole days between two dates, positive when `later` is after `earlier`. */
export function daysBetween(earlier: string | Date, later: string | Date): number {
  const a = new Date(earlier).getTime();
  const b = new Date(later).getTime();
  return Math.floor((b - a) / 86_400_000);
}

export function pct(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((100 * part) / whole).toFixed(0)}%`;
}

/**
 * Wilson score interval, which is what a proportion from 20 observations needs.
 * The normal approximation gives nonsense at the ends — 20/20 is not "100%,
 * ±0" — and the audit reports accuracy per field off samples that small.
 */
export function wilson(successes: number, trials: number, z = 1.96): [number, number] {
  if (trials === 0) return [0, 1];
  const p = successes / trials;
  const d = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}
