import { NOT_STATED_LABEL, UNKNOWN_LABEL, safeText, textList } from "@/lib/format";
import type { EligibilityFlags } from "@/lib/types/database";

interface Row {
  label: string;
  value: string;
  /** true when the value is a hurdle the applicant has to clear. */
  demanding: boolean;
}

/**
 * Absent is not false.
 *
 * A row extracted from a page carries only the flags that page stated, so a
 * missing `requires_research_proposal` means nobody has read one way or the
 * other — printing "Not required" there would be inventing a fact in the
 * student's favour, which is the worst direction to be wrong in. Every branch
 * below therefore has three outcomes, not two.
 */
type Flags = Partial<EligibilityFlags> | null | undefined;

/**
 * The two kinds of blank, told apart at last.
 *
 * Every branch below already had three outcomes rather than two, and the third
 * printed the same six characters — "Not stated" — whether the pages had been
 * read and were silent or nobody had ever fetched them. The data has
 * distinguished those since migration 013 (an explicit null under a present key
 * means "asked, and the pages say nothing") and migration 016 extended it to
 * every other field; only the screen was still collapsing them.
 *
 * A key present with a null value is the strongest signal, because it is this
 * row's own record of having asked. `not_stated` is the same finding arriving
 * from the wider list. Anything else is genuinely unknown.
 */
function silenceOf(
  flags: Flags,
  notStated: Set<string>,
  key: keyof EligibilityFlags,
): string {
  const asked = flags !== null && flags !== undefined && key in flags;
  return asked || notStated.has(`eligibility.${key}`)
    ? NOT_STATED_LABEL
    : UNKNOWN_LABEL;
}

function describeBoolean(
  value: boolean | null | undefined,
  whenTrue: string,
  whenFalse: string,
  silence: string,
): Row["value"] {
  if (typeof value !== "boolean") return silence;
  return value ? whenTrue : whenFalse;
}

/**
 * Has anything read this programme's eligibility at all?
 *
 * Two rows below say something reassuring when their value is missing — "No age
 * cap", "Open to all nationalities" — and both are legitimate readings of a
 * page that WAS read and did not state a limit. Neither is a legitimate reading
 * of a row nobody has opened, where the honest answer is that we do not know.
 * `notes` alone does not count: it is commentary, not an answer to any of these
 * questions.
 */
function hasBeenRead(flags: Flags): boolean {
  return Object.keys(flags ?? {}).some((key) => key !== "notes");
}

function buildRows(flags: Flags, notStated: string[]): Row[] {
  const read = hasBeenRead(flags);
  const silent = new Set(notStated);
  const blank = (key: keyof EligibilityFlags) => silenceOf(flags, silent, key);
  // textList rather than a length check: the model occasionally returns objects
  // inside a list of strings, and those render as "[object Object]" — quieter
  // than a crash and just as wrong.
  const tests = textList(flags?.accepted_language_tests);
  const languageTests = tests.length > 0 ? tests.join(", ") : null;

  const scoreParts: string[] = [];
  if (typeof flags?.min_toefl_ibt === "number") {
    scoreParts.push(`TOEFL iBT ${flags.min_toefl_ibt}`);
  }
  if (typeof flags?.min_ielts === "number") {
    scoreParts.push(`IELTS ${flags.min_ielts}`);
  }

  const nationalities = textList(flags?.restricted_to_nationalities);
  const hasNationalities = nationalities.length > 0;

  return [
    {
      label: "Age limit",
      value:
        typeof flags?.max_age === "number"
          ? `${flags.max_age} years`
          : read
            ? "No age cap"
            : blank("max_age"),
      demanding: typeof flags?.max_age === "number",
    },
    {
      label: "Minimum GPA",
      value:
        typeof flags?.min_gpa_4_scale === "number"
          ? `${flags.min_gpa_4_scale.toFixed(1)} / 4.0`
          : blank("min_gpa_4_scale"),
      demanding:
        typeof flags?.min_gpa_4_scale === "number" && flags.min_gpa_4_scale >= 3.5,
    },
    {
      label: "Work experience",
      value:
        typeof flags?.min_work_experience_years !== "number"
          ? blank("min_work_experience_years")
          : flags.min_work_experience_years > 0
            ? `${flags.min_work_experience_years}+ years`
            : "None required",
      demanding:
        typeof flags?.min_work_experience_years === "number" &&
        flags.min_work_experience_years > 0,
    },
    {
      label: "Language test",
      value:
        typeof flags?.language_test_required !== "boolean"
          ? blank("language_test_required")
          : flags.language_test_required
            ? `Required${languageTests ? ` — ${languageTests}` : ""}`
            : "Not required",
      demanding: flags?.language_test_required === true,
    },
    {
      label: "Minimum scores",
      value:
        scoreParts.length > 0 ? scoreParts.join(" · ") : blank("min_ielts"),
      demanding: false,
    },
    {
      label: "Admission first",
      value: describeBoolean(
        flags?.requires_university_admission_first,
        "Need a university offer before applying",
        "Apply without an offer",
        blank("requires_university_admission_first"),
      ),
      demanding: flags?.requires_university_admission_first === true,
    },
    {
      label: "Nomination",
      value: describeBoolean(
        flags?.requires_government_nomination,
        "Embassy / government nomination required",
        "Apply directly",
        blank("requires_government_nomination"),
      ),
      demanding: flags?.requires_government_nomination === true,
    },
    {
      label: "Research proposal",
      value: describeBoolean(
        flags?.requires_research_proposal,
        "Required",
        "Not required",
        blank("requires_research_proposal"),
      ),
      demanding: flags?.requires_research_proposal === true,
    },
    {
      label: "Nationality",
      value: hasNationalities
        ? `Restricted to ${nationalities.join(", ")}`
        : read
          ? "Open to all nationalities"
          : blank("restricted_to_nationalities"),
      demanding: hasNationalities,
    },
  ];
}

export function EligibilityList({
  flags,
  notStated,
}: {
  flags: Flags;
  /** `scholarships.not_stated`. Absent on rows read before migration 016. */
  notStated?: string[] | null;
}) {
  const rows = buildRows(flags, Array.isArray(notStated) ? notStated : []);

  return (
    <div className="flex flex-col">
      <dl className="divide-y">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[9rem_1fr] gap-3 py-2 text-sm">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              className={
                row.demanding
                  ? "font-medium"
                  : row.value === NOT_STATED_LABEL || row.value === UNKNOWN_LABEL
                    ? "text-muted-foreground"
                    : undefined
              }
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {safeText(flags?.notes) && (
        <p className="bg-muted/60 text-muted-foreground mt-3 rounded-md p-3 text-xs leading-relaxed">
          {safeText(flags?.notes)}
        </p>
      )}
    </div>
  );
}
