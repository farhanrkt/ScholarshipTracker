import type {
  ChecklistProgress,
  DocumentChecklist,
  Scholarship,
} from "@/lib/types/database";

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Days after which a verified row is treated as stale. */
export const STALE_AFTER_DAYS = 90;

function toUtcDate(isoDate: string): Date {
  return new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
}

function todayUtcMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function daysFromToday(isoDate: string): number {
  return Math.round((toUtcDate(isoDate).getTime() - todayUtcMs()) / 86_400_000);
}

export function formatDate(isoDate: string): string {
  return DATE_FORMAT.format(toUtcDate(isoDate));
}

/* -------------------------------------------------------------------------- */
/* Application window                                                         */
/* -------------------------------------------------------------------------- */

export type WindowState =
  | "unknown" // no dates published (or not yet verified)
  | "not_open" // opens in the future
  | "open" // accepting applications now
  | "closed"; // deadline passed

export type WindowTone = "muted" | "info" | "open" | "soon" | "urgent";

export interface ApplicationWindow {
  state: WindowState;
  /** Primary label, e.g. "Closes 6 Oct 2026". */
  label: string;
  /** Secondary phrase, e.g. "in 65 days". Empty when there is nothing to say. */
  relative: string;
  tone: WindowTone;
  daysUntilClose: number | null;
}

/**
 * Describes the application window from opens/closes.
 *
 * A single deadline cannot express "opens 4 Aug, closes 6 Oct", and the absence
 * of a date is a first-class state here rather than something to paper over.
 */
export function describeWindow(
  scholarship: Pick<Scholarship, "opens_date" | "deadline_date">,
): ApplicationWindow {
  const { opens_date: opens, deadline_date: closes } = scholarship;

  if (!opens && !closes) {
    return {
      state: "unknown",
      label: "Dates not published",
      relative: "",
      tone: "muted",
      daysUntilClose: null,
    };
  }

  if (opens && daysFromToday(opens) > 0) {
    const days = daysFromToday(opens);
    return {
      state: "not_open",
      label: `Opens ${formatDate(opens)}`,
      relative: days === 1 ? "tomorrow" : `in ${days} days`,
      tone: "info",
      daysUntilClose: closes ? daysFromToday(closes) : null,
    };
  }

  if (!closes) {
    return {
      state: "open",
      label: "Open now",
      relative: "closing date not published",
      tone: "open",
      daysUntilClose: null,
    };
  }

  const days = daysFromToday(closes);

  if (days < 0) {
    return {
      state: "closed",
      label: `Closed ${formatDate(closes)}`,
      relative: `${Math.abs(days)} days ago`,
      tone: "muted",
      daysUntilClose: days,
    };
  }

  let relative: string;
  if (days === 0) relative = "today";
  else if (days === 1) relative = "tomorrow";
  else relative = `in ${days} days`;

  return {
    state: "open",
    label: `Closes ${formatDate(closes)}`,
    relative,
    tone: days <= 30 ? "urgent" : days <= 90 ? "soon" : "open",
    daysUntilClose: days,
  };
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

export type VerificationState =
  | "verified"
  | "ai_extracted"
  | "stale"
  | "unverified";

export interface VerificationInfo {
  state: VerificationState;
  label: string;
  /** Why the user should or should not trust this row. */
  detail: string;
}

/**
 * Staleness is derived here, never stored. A row goes stale either because
 * nobody has looked at it in a while, or because its deadline has passed and
 * the cycle has therefore rolled over.
 */
export function describeVerification(
  scholarship: Pick<
    Scholarship,
    "verification_status" | "last_verified_at" | "deadline_date"
  >,
): VerificationInfo {
  const { verification_status, last_verified_at, deadline_date } = scholarship;

  if (verification_status === "unverified" || !last_verified_at) {
    return {
      state: "unverified",
      label: "Not verified",
      detail:
        "Nobody has checked this against the official page yet. Treat the details as a starting point and confirm everything on the portal.",
    };
  }

  const daysSinceCheck = -daysFromToday(last_verified_at);

  // An AI extraction is quote-backed, not human-confirmed. Say so, and keep
  // saying so — it never ages into "verified".
  if (verification_status === "ai_extracted") {
    const rolledOver = deadline_date && daysFromToday(deadline_date) < 0;
    return {
      state: rolledOver ? "stale" : "ai_extracted",
      label: rolledOver ? "Cycle has rolled over" : "AI-extracted",
      detail: rolledOver
        ? `These dates were read off the official page on ${formatDate(last_verified_at)}, and the deadline has since passed. The next cycle's dates are probably out.`
        : `Read off the official page automatically on ${formatDate(last_verified_at)}, with every date backed by a quote from that page. No person has confirmed it — check the portal before you rely on it.`,
    };
  }

  if (deadline_date && daysFromToday(deadline_date) < 0) {
    return {
      state: "stale",
      label: "Cycle has rolled over",
      detail: `The deadline recorded here has passed, so the next cycle's dates are probably out. Last checked ${formatDate(last_verified_at)}.`,
    };
  }

  if (daysSinceCheck > STALE_AFTER_DAYS) {
    return {
      state: "stale",
      label: "May be out of date",
      detail: `Last checked ${formatDate(last_verified_at)}, ${daysSinceCheck} days ago. Re-confirm before you rely on it.`,
    };
  }

  return {
    state: "verified",
    label: `Verified ${formatDate(last_verified_at)}`,
    detail: "Read off the programme's own timeline page on this date.",
  };
}

/* -------------------------------------------------------------------------- */
/* Checklist                                                                  */
/* -------------------------------------------------------------------------- */

export interface ChecklistStats {
  completed: number;
  total: number;
  requiredCompleted: number;
  requiredTotal: number;
  percent: number;
}

export function summariseChecklist(
  checklist: DocumentChecklist | null | undefined,
  progress: ChecklistProgress | null | undefined,
): ChecklistStats {
  // JSONB columns are typed here but not enforced there: a row seeded by hand,
  // or promoted before extraction ever ran, can hold `{}` where the type
  // promises an array. Every consumer of this function renders a page, so a
  // `.filter is not a function` is a blank screen, not a bad number.
  const list = Array.isArray(checklist) ? checklist : [];
  const ticks = progress ?? {};

  const total = list.length;
  const completed = list.filter((doc) => ticks[doc.key]).length;
  const required = list.filter((doc) => doc.required);
  const requiredCompleted = required.filter((doc) => ticks[doc.key]).length;

  return {
    completed,
    total,
    requiredCompleted,
    requiredTotal: required.length,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}
