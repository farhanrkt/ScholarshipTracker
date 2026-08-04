import {
  CalendarClock,
  CircleHelp,
  Handshake,
  Languages,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  describeCommitment,
  describeVerification,
  describeWindow,
  type CommitmentState,
  type VerificationState,
  type WindowTone,
} from "@/lib/format";
import type { Scholarship } from "@/lib/types/database";
import { cn } from "@/lib/utils";

const WINDOW_STYLES: Record<WindowTone, string> = {
  muted: "border-transparent bg-muted text-muted-foreground",
  info: "border-transparent bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  open: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  soon: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  urgent:
    "border-transparent bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
};

/** Opens/closes window. Renders "Dates not published" rather than inventing one. */
export function WindowBadge({
  scholarship,
}: {
  scholarship: Pick<Scholarship, "opens_date" | "deadline_date">;
}) {
  const window = describeWindow(scholarship);

  return (
    <Badge className={cn("gap-1 font-medium", WINDOW_STYLES[window.tone])}>
      {window.state === "unknown" ? (
        <CircleHelp className="size-3" />
      ) : (
        <CalendarClock className="size-3" />
      )}
      {window.label}
      {window.relative && <span className="opacity-70">· {window.relative}</span>}
    </Badge>
  );
}

const VERIFICATION_STYLES: Record<VerificationState, string> = {
  verified:
    "border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-200",
  ai_extracted:
    "border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-200",
  stale:
    "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-200",
  unverified: "border-dashed text-muted-foreground",
};

const VERIFICATION_ICONS: Record<VerificationState, typeof ShieldCheck> = {
  verified: ShieldCheck,
  ai_extracted: Sparkles,
  stale: ShieldAlert,
  unverified: ShieldQuestion,
};

/**
 * Says out loud whether anyone has checked this row. The old UI printed a
 * "last verified" date that was auto-stamped at insert — a provenance claim the
 * data had not earned.
 */
export function VerificationBadge({
  scholarship,
}: {
  scholarship: Pick<
    Scholarship,
    "verification_status" | "last_verified_at" | "deadline_date"
  >;
}) {
  const info = describeVerification(scholarship);
  const Icon = VERIFICATION_ICONS[info.state];

  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-normal", VERIFICATION_STYLES[info.state])}
      title={info.detail}
    >
      <Icon className="size-3" />
      {info.label}
    </Badge>
  );
}

const COMMITMENT_STYLES: Record<CommitmentState, string> = {
  obligation:
    "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-200",
  none: "border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-200",
  unknown: "border-dashed text-muted-foreground",
};

const COMMITMENT_ICONS: Record<CommitmentState, typeof ShieldCheck> = {
  obligation: Handshake,
  none: ShieldCheck,
  unknown: CircleHelp,
};

/**
 * Language training + post-study obligations.
 *
 * Both are three-valued and neither defaults to the reassuring answer — see
 * `describeCommitment`. The language badge stays absent unless the pages say
 * it is included, because "language training not stated" on every card is
 * noise, while a wrongly-green "No bond" is a false promise.
 */
export function CommitmentBadges({
  scholarship,
}: {
  scholarship: Pick<
    Scholarship,
    | "language_training_included"
    | "post_study_obligations"
    | "coverage_matrix"
    | "eligibility_flags"
    | "document_checklist"
  >;
}) {
  const commitment = describeCommitment(scholarship);
  const Icon = COMMITMENT_ICONS[commitment.state];

  return (
    <>
      {scholarship.language_training_included && (
        <Badge variant="secondary" className="gap-1">
          <Languages className="size-3" />
          Language training included
        </Badge>
      )}

      <Badge
        variant="outline"
        className={cn("gap-1", COMMITMENT_STYLES[commitment.state])}
        title={commitment.detail}
      >
        <Icon className="size-3" />
        {commitment.label}
      </Badge>
    </>
  );
}
