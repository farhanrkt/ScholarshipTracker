import type { FieldSource, FieldSources } from "@/lib/types/database";

/**
 * Reading per-field provenance out of a JSONB column that promises nothing.
 *
 * Pure, and in `lib` rather than beside the component that renders it, for two
 * reasons: the node test runner cannot load JSX, and a value that decides
 * whether a student sees "sources disagree" deserves tests more than the markup
 * around it does.
 *
 * Every malformed shape degrades to `null` — say nothing — because the
 * alternative on a page is a blank route, and the alternative in prose is
 * printing "From undefined" next to a deadline.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readFieldSource(
  sources: FieldSources | null | undefined,
  field: string,
): FieldSource | null {
  if (!isRecord(sources)) return null;

  const entry = sources[field];
  if (!isRecord(entry)) return null;

  const authority = entry.authority;
  if (authority !== "funder" && authority !== "official" && authority !== "other") {
    return null;
  }

  return {
    authority,
    source_url: typeof entry.source_url === "string" ? entry.source_url : null,
    corroborated_by: Array.isArray(entry.corroborated_by)
      ? (entry.corroborated_by as FieldSource["corroborated_by"])
      : [],
    conflicts: Array.isArray(entry.conflicts)
      ? (entry.conflicts as FieldSource["conflicts"])
      : [],
  };
}
