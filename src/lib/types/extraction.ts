import type { Scholarship, ScholarshipExtraction } from "./database";

export type { FieldEvidence, ProposedUpdate } from "./database";

/** Shape returned by the review page's join. */
export type PendingExtraction = Pick<
  ScholarshipExtraction,
  | "id"
  | "source_url"
  | "fetched_at"
  | "model"
  | "proposed"
  | "evidence"
  | "ungrounded_fields"
  | "caveats"
  | "page_subject"
  | "model_notes"
> & {
  scholarship: Pick<
    Scholarship,
    | "id"
    | "title"
    | "country"
    | "cycle_label"
    | "opens_date"
    | "deadline_date"
    | "verification_status"
  >;
};
