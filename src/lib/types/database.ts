/**
 * Strict types for the ScholarTrack Postgres schema.
 *
 * The JSONB columns are the heart of the product -- they are what make granular
 * filtering possible -- so they get explicit shapes rather than `any`/`Json`.
 */

/* -------------------------------------------------------------------------- */
/* Enumerated domains                                                         */
/* -------------------------------------------------------------------------- */

export const COUNTRIES = [
  "USA",
  "UK",
  "China",
  "Japan",
  "South Korea",
  "Singapore",
] as const;
export type Country = (typeof COUNTRIES)[number];

export const DEGREE_LEVELS = ["Bachelors", "Masters", "PhD"] as const;
export type DegreeLevel = (typeof DEGREE_LEVELS)[number];

export const TARGET_STATUSES = ["saved", "in_progress", "submitted"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export const TARGET_STATUS_LABELS: Record<TargetStatus, string> = {
  saved: "Saved",
  in_progress: "In progress",
  submitted: "Submitted",
};

/* -------------------------------------------------------------------------- */
/* JSONB: coverage_matrix                                                     */
/* -------------------------------------------------------------------------- */

export const COVERAGE_KEYS = [
  "tuition",
  "monthly_stipend",
  "airfare",
  "accommodation",
  "health_insurance",
  "settling_in_allowance",
  "research_grant",
  "visa_fees",
] as const;
export type CoverageKey = (typeof COVERAGE_KEYS)[number];

export const COVERAGE_LABELS: Record<CoverageKey, string> = {
  tuition: "Tuition",
  monthly_stipend: "Monthly stipend",
  airfare: "Airfare",
  accommodation: "Accommodation",
  health_insurance: "Health insurance",
  settling_in_allowance: "Settling-in allowance",
  research_grant: "Research / thesis grant",
  visa_fees: "Visa fees",
};

export interface CoverageItem {
  covered: boolean;
  /** Human-readable qualifier, e.g. "JPY 143,000 per month". */
  detail?: string | null;
}

/**
 * Partial on purpose: a row only needs to declare the lines it knows about, and
 * a missing key renders as "not stated" rather than "not covered".
 */
export type CoverageMatrix = Partial<Record<CoverageKey, CoverageItem>>;

/* -------------------------------------------------------------------------- */
/* JSONB: eligibility_flags                                                   */
/* -------------------------------------------------------------------------- */

export interface EligibilityFlags {
  /** null = no age cap. */
  max_age: number | null;
  /** Normalised to a 4.0 scale. null = not published. */
  min_gpa_4_scale: number | null;
  /** null = no work experience required -- this is the flag the filter keys off. */
  min_work_experience_years: number | null;
  language_test_required: boolean;
  accepted_language_tests: string[];
  min_toefl_ibt: number | null;
  min_ielts: number | null;
  requires_university_admission_first: boolean;
  requires_government_nomination: boolean;
  requires_research_proposal: boolean;
  /** null = open to all nationalities. */
  restricted_to_nationalities: string[] | null;
  notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/* JSONB: document_checklist / checklist_progress                             */
/* -------------------------------------------------------------------------- */

export interface ChecklistDocument {
  /** Stable slug -- this is the key written into `checklist_progress`. */
  key: string;
  label: string;
  required: boolean;
  notes?: string | null;
}

export type DocumentChecklist = ChecklistDocument[];

/** Maps `ChecklistDocument["key"]` -> whether the user has ticked it off. */
export type ChecklistProgress = Record<string, boolean>;

/* -------------------------------------------------------------------------- */
/* JSONB: timeline                                                            */
/* -------------------------------------------------------------------------- */

export interface TimelineStage {
  key: string;
  label: string;
  /** ISO date, or null when the programme has announced the stage but not the date. */
  date: string | null;
  note?: string | null;
}

export type Timeline = TimelineStage[];

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Three stored states, ordered by trust:
 *  - `unverified`   — nobody and nothing has checked this row.
 *  - `ai_extracted` — a model read it off the official page and every value is
 *                     backed by a verbatim quote that was found in that page.
 *                     No human has opened the portal.
 *  - `verified`     — a human read the official page.
 *
 * "Stale" is deliberately NOT stored: it is DERIVED at render time from
 * `last_verified_at` and the deadline, because a stored staleness flag goes
 * wrong the moment nobody updates it.
 */
export const VERIFICATION_STATUSES = [
  "unverified",
  "ai_extracted",
  "verified",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Table rows                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Row types are `type` aliases rather than `interface`s on purpose: postgrest-js
 * constrains every Row to `Record<string, unknown>`, and only type aliases get
 * an implicit index signature. An interface here silently degrades the whole
 * client to `never`.
 */
export type Scholarship = {
  id: string;
  title: string;
  country: Country;
  degree_levels: DegreeLevel[];
  coverage_matrix: CoverageMatrix;
  eligibility_flags: EligibilityFlags;
  document_checklist: DocumentChecklist;
  post_study_obligations: string | null;
  language_training_included: boolean;
  official_portal_url: string;

  /* Scope of the award (migration 010).

     `fields_of_study` empty means OPEN TO ANY SUBJECT, not "unknown" — the
     column is a restriction list, and extraction only ever adds to it. The
     other two are free text held verbatim from the page: "up to 3 years",
     "approximately 1,500 annually". Null until something has read them. */
  fields_of_study: string[];
  award_duration: string | null;
  number_of_awards: string | null;

  /**
   * Per-field provenance (migration 011). Empty until something cross-verifies
   * the row; an absent key means "never checked", not "checked and agreed".
   */
  field_sources: FieldSources;

  /* Application window. All nullable — "not announced yet" is a real answer,
     and forcing a value here is what produced fabricated deadlines. */
  opens_date: string | null;
  deadline_date: string | null;
  cycle_label: string | null;
  timeline: Timeline;

  /* Provenance. `last_verified_at` is null until a human actually checks. */
  verification_status: VerificationStatus;
  source_url: string | null;
  last_verified_at: string | null;

  /**
   * Generated by Postgres (migration 009): true once anything has read this
   * programme's coverage, eligibility or documents.
   *
   * Read-only — it is `GENERATED ALWAYS`, so writing it is an error. It exists
   * because "the pages say there is no bond" and "nobody has looked" are
   * different answers that a null column cannot tell apart.
   */
  is_profiled: boolean;

  created_at: string;
};

export type UserTarget = {
  id: string;
  user_id: string;
  scholarship_id: string;
  status: TargetStatus;
  checklist_progress: ChecklistProgress;
  created_at: string;
  updated_at: string;
};

/** Shape returned by the `/my-tracker` join. */
export type UserTargetWithScholarship = UserTarget & {
  scholarship: Scholarship;
};

/* -------------------------------------------------------------------------- */
/* AI extraction staging                                                      */
/* -------------------------------------------------------------------------- */

export const EXTRACTION_STATUSES = ["pending", "applied", "rejected"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/**
 * How much a source is worth trusting about a programme (migration 011).
 *
 * `funder` is the programme's own organisation; `official` a government or
 * academic body that is not the funder; `other` everything else. Grounding
 * proves a source said something — this is what says whether to believe it.
 */
export const AUTHORITIES = ["funder", "official", "other"] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const AUTHORITY_LABELS: Record<Authority, string> = {
  funder: "the programme's own site",
  official: "a university or government source",
  other: "a third-party source",
};

export interface SourceRef {
  url: string;
  authority: Authority;
}

export interface ConflictRef extends SourceRef {
  /** What this source claimed instead. */
  value: string;
}

/** Where one field's value came from, who agreed, and who did not. */
export interface FieldSource {
  authority: Authority;
  source_url: string | null;
  corroborated_by?: SourceRef[];
  conflicts?: ConflictRef[];
}

/**
 * Per-field provenance for a row.
 *
 * An ABSENT key means the field was never cross-verified, which is a different
 * statement from "one source agreed" — and the UI has to keep them apart, or
 * "not checked" starts reading as "checked and fine".
 */
export type FieldSources = Record<string, FieldSource>;

/** One field's claim, plus whether its quote was found on the page. */
export interface FieldEvidence {
  quote: string | null;
  /** Set by the pipeline, never by the model. */
  grounded: boolean;
  confidence: "high" | "medium" | "low";
  /** The page whose text contained the quote. */
  source_url: string | null;
  /** Tier of that page. Absent on extractions predating migration 011. */
  authority?: Authority;
  corroborated_by?: SourceRef[];
  conflicts?: ConflictRef[];
}

/**
 * What an extraction proposes for a scholarship row.
 *
 * The cycle fields are always present; the rest arrive only when the profile
 * half of the extraction produced something that survived grounding, which is
 * why they are optional. `apply_extraction()` merges the object fields key-wise
 * and replaces the array fields only when non-empty — so an absent key here
 * means "the pages did not say", never "set this to nothing".
 */
export interface ProposedUpdate {
  cycle_label: string | null;
  opens_date: string | null;
  deadline_date: string | null;
  timeline: Timeline;

  coverage_matrix?: CoverageMatrix;
  /** Partial: only the flags the pages actually stated. */
  eligibility_flags?: Partial<EligibilityFlags>;
  document_checklist?: DocumentChecklist;
  post_study_obligations?: string | null;
  language_training_included?: boolean | null;
  fields_of_study?: string[];
  award_duration?: string | null;
  number_of_awards?: string | null;
  field_sources?: FieldSources;
}

/**
 * A page on another site that describes a programme we track.
 *
 * Discovery used to meet these and discard them: a classified page whose
 * programme name matches an existing row was counted a `duplicate` and dropped.
 * That is exactly a second source, and it was thrown away for want of anywhere
 * to put it.
 */
export type ScholarshipSource = {
  id: string;
  scholarship_id: string;
  url: string;
  authority: Authority;
  found_via: string | null;
  discovered_at: string;
  last_checked_at: string | null;
  /** Set by a human when a source proves useless, so re-discovery cannot undo it. */
  muted: boolean;
  muted_reason: string | null;
};

export type ScholarshipExtraction = {
  id: string;
  scholarship_id: string;
  source_url: string;
  fetched_at: string;
  page_sha256: string;
  model: string;
  proposed: ProposedUpdate;
  evidence: Record<string, FieldEvidence>;
  /** Values the model claimed that grounding threw away. */
  ungrounded_fields: string[];
  /** Values kept, but qualified by the page — the reviewer must look. */
  caveats: string[];
  page_subject: string | null;
  model_notes: string | null;
  status: ExtractionStatus;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  created_at: string;
};

export type Admin = {
  email: string;
  note: string | null;
  created_at: string;
};

/* -------------------------------------------------------------------------- */
/* Discovery staging                                                          */
/* -------------------------------------------------------------------------- */

export const CANDIDATE_STATUSES = ["pending", "promoted", "rejected"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * A programme discovery found that we have no row for yet.
 *
 * Note the absence of any date field — discovery is not allowed to write dates.
 * Promoting one creates a dateless skeleton that goes through extraction like
 * everything else.
 */
export type ScholarshipCandidate = {
  id: string;
  url: string;
  found_via: string;
  fetched_at: string;
  model: string;
  programme_name: string;
  funder: string | null;
  host_country: string | null;
  degree_levels: DegreeLevel[];
  is_fully_funded: boolean | null;
  open_to_international: boolean | null;
  confidence: "high" | "medium" | "low";
  summary: string | null;
  status: CandidateStatus;
  scholarship_id: string | null;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  created_at: string;
};

/* -------------------------------------------------------------------------- */
/* Supabase client generic                                                    */
/* -------------------------------------------------------------------------- */

export type Database = {
  public: {
    Tables: {
      scholarships: {
        Row: Scholarship;
        // Everything nullable or DB-defaulted is optional on insert.
        // `is_profiled` is GENERATED ALWAYS: Postgres rejects any attempt to
        // write it, so it is absent from both Insert and Update by design.
        Insert: Pick<
          Scholarship,
          | "title"
          | "country"
          | "degree_levels"
          | "coverage_matrix"
          | "eligibility_flags"
          | "document_checklist"
          | "official_portal_url"
        > &
          Partial<
            Omit<
              Scholarship,
              | "title"
              | "country"
              | "degree_levels"
              | "coverage_matrix"
              | "eligibility_flags"
              | "document_checklist"
              | "official_portal_url"
              | "is_profiled"
            >
          >;
        Update: Partial<Omit<Scholarship, "is_profiled">>;
        Relationships: [];
      };
      user_targets: {
        Row: UserTarget;
        Insert: Pick<UserTarget, "user_id" | "scholarship_id"> &
          Partial<
            Pick<
              UserTarget,
              "id" | "status" | "checklist_progress" | "created_at" | "updated_at"
            >
          >;
        Update: Partial<Omit<UserTarget, "id" | "user_id">>;
        Relationships: [
          {
            foreignKeyName: "user_targets_scholarship_id_fkey";
            columns: ["scholarship_id"];
            isOneToOne: false;
            referencedRelation: "scholarships";
            referencedColumns: ["id"];
          },
        ];
      };
      scholarship_extractions: {
        Row: ScholarshipExtraction;
        Insert: Omit<
          ScholarshipExtraction,
          "id" | "status" | "reviewed_at" | "reviewer_notes" | "created_at"
        > &
          Partial<
            Pick<
              ScholarshipExtraction,
              "id" | "status" | "reviewed_at" | "reviewer_notes" | "created_at"
            >
          >;
        Update: Partial<Omit<ScholarshipExtraction, "id">>;
        Relationships: [
          {
            foreignKeyName: "scholarship_extractions_scholarship_id_fkey";
            columns: ["scholarship_id"];
            isOneToOne: false;
            referencedRelation: "scholarships";
            referencedColumns: ["id"];
          },
        ];
      };
      admins: {
        Row: Admin;
        Insert: Pick<Admin, "email"> & Partial<Admin>;
        Update: Partial<Admin>;
        Relationships: [];
      };
      scholarship_sources: {
        Row: ScholarshipSource;
        Insert: Pick<ScholarshipSource, "scholarship_id" | "url" | "authority"> &
          Partial<ScholarshipSource>;
        Update: Partial<ScholarshipSource>;
        Relationships: [
          {
            foreignKeyName: "scholarship_sources_scholarship_id_fkey";
            columns: ["scholarship_id"];
            isOneToOne: false;
            referencedRelation: "scholarships";
            referencedColumns: ["id"];
          },
        ];
      };
      scholarship_candidates: {
        Row: ScholarshipCandidate;
        Insert: Pick<
          ScholarshipCandidate,
          "url" | "found_via" | "fetched_at" | "model" | "programme_name"
        > &
          Partial<ScholarshipCandidate>;
        Update: Partial<ScholarshipCandidate>;
        Relationships: [];
      };
    };
    // `{ [_ in never]: never }` and not `Record<string, never>`: the latter
    // carries a string index signature, and postgrest-js intersects Views into
    // Tables — which would collapse every table type to `never`.
    Views: { [_ in never]: never };
    Functions: {
      is_admin: { Args: Record<string, never>; Returns: boolean };
      why_not_admin: {
        Args: Record<string, never>;
        Returns: Array<{
          user_id: string;
          email: string | null;
          email_confirmed: boolean;
          on_allowlist: boolean;
          verdict: string;
        }>;
      };
      apply_extraction: { Args: { extraction_id: string }; Returns: Scholarship };
      reject_extraction: {
        Args: { extraction_id: string; why?: string | null };
        Returns: undefined;
      };
      promote_candidate: { Args: { candidate_id: string }; Returns: Scholarship };
      reject_candidate: {
        Args: { candidate_id: string; why?: string | null };
        Returns: undefined;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
