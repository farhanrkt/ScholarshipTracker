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

/* -------------------------------------------------------------------------- */
/* Has anyone actually read this programme's details?                         */
/* -------------------------------------------------------------------------- */

function countEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

/**
 * True when something has read this programme's details off its official pages.
 *
 * A row promoted from discovery starts with empty coverage, empty eligibility
 * and no documents. That is indistinguishable, field by field, from a programme
 * that genuinely offers nothing — which is why several badges need to know the
 * difference before they open their mouths.
 */
export function hasProfileData(
  scholarship: Pick<
    Scholarship,
    "coverage_matrix" | "eligibility_flags" | "document_checklist"
  >,
): boolean {
  return (
    countEntries(scholarship.coverage_matrix) > 0 ||
    countEntries(scholarship.eligibility_flags) > 0 ||
    countEntries(scholarship.document_checklist) > 0
  );
}

export type CommitmentState = "obligation" | "none" | "unknown";

export interface CommitmentInfo {
  state: CommitmentState;
  label: string;
  detail: string;
}

/**
 * Post-study obligation: bonded, explicitly not bonded, or nobody knows.
 *
 * THE BUG THIS FIXES. A null `post_study_obligations` used to render "No bond"
 * — so every skeleton row from discovery advertised freedom nobody had checked,
 * and the dashboard showed "Chevening Scholarship · Post-study obligation" next
 * to "Chevening Scholarships · No bond": the same programme, opposite claims,
 * one of them invented.
 *
 * Null is not "no". It only becomes "no" once the row has been profiled at all,
 * because then the absence is a reading of the page rather than the absence of
 * a reading. A bond is a multi-year commitment to return home; claiming there
 * isn't one is the most expensive direction to be wrong in.
 */
export function describeCommitment(
  scholarship: Pick<
    Scholarship,
    | "post_study_obligations"
    | "coverage_matrix"
    | "eligibility_flags"
    | "document_checklist"
  >,
): CommitmentInfo {
  if (scholarship.post_study_obligations?.trim()) {
    return {
      state: "obligation",
      label: "Post-study obligation",
      detail: scholarship.post_study_obligations,
    };
  }

  if (hasProfileData(scholarship)) {
    return {
      state: "none",
      label: "No bond",
      detail: "The official pages state no return or service requirement.",
    };
  }

  return {
    state: "unknown",
    label: "Bond not stated",
    detail:
      "Nobody has read this programme's terms yet — check the official page before assuming there is no commitment.",
  };
}

/* -------------------------------------------------------------------------- */
/* Country names                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Legacy rows spell countries however the page that produced them did, so the
 * filter sidebar grew both "UK" and "United Kingdom" as separate facets.
 *
 * Discovery normalises on write now (scripts/discover/candidates.ts) and
 * migration 008 fixes the stored values, but display-time folding costs
 * nothing and keeps one badly-spelled row from splitting a facet again.
 * Anything outside the six targets is shown exactly as stored.
 */
const COUNTRY_DISPLAY: Record<string, string> = {
  "united kingdom": "UK",
  "great britain": "UK",
  britain: "UK",
  england: "UK",
  scotland: "UK",
  wales: "UK",
  "united states": "USA",
  "united states of america": "USA",
  us: "USA",
  america: "USA",
  "republic of korea": "South Korea",
  korea: "South Korea",
  "people's republic of china": "China",
  "mainland china": "China",
  // Not a country: a programme placing its recipients in several at once. The
  // stored value is a filter key; on a card it has to read like an answer.
  multiple: "Several countries",
  unknown: "Several countries",
};

export function displayCountry(country: string): string {
  return COUNTRY_DISPLAY[country.trim().toLowerCase()] ?? country;
}

/* -------------------------------------------------------------------------- */
/* Rendering guards                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The three guards every component needs before it renders extracted JSON.
 *
 * `src/lib/types/database.ts` describes what the columns are SUPPOSED to hold,
 * and TypeScript believes it, but nothing between Gemini and React enforces it:
 * `document_checklist` is `JSONB NOT NULL` with no shape constraint, a row
 * promoted from discovery starts as `[]`, a hand-seeded one can hold `{}`, and
 * a partial model response can leave a null inside an otherwise fine array.
 * Each of those reaches a component as a value whose type is a promise the
 * database never made.
 *
 * The consequence is not a bad number, it is a blank page: `.map` on a non-array
 * throws, a null element throws on property access, and an object rendered as a
 * React child throws "Objects are not valid as a React child". All three take
 * the whole route down, including the parts of it that were fine.
 */

/** Non-empty strings out of a value that is supposed to be `string[]`. */
export function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

/**
 * Object elements out of a value that is supposed to be an array of records.
 *
 * Drops nulls and primitives; keeps the type assertion at this one boundary so
 * callers can stay declarative.
 */
export function recordList<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is T => typeof item === "object" && item !== null,
  );
}

/** A value safe to render as text, or null if there is nothing to say. */
export function safeText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

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
