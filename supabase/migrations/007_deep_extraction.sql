-- ScholarTrack :: migration 007
-- Let an extraction carry more than dates.
--
-- WHY THIS EXISTS. Extraction could already read a programme's coverage,
-- eligibility and document list -- and had nowhere to put them.
-- apply_extraction() copied four keys (cycle_label, opens_date, deadline_date,
-- timeline) and dropped everything else on the floor, while promote_candidate()
-- creates every discovered row with '{}' coverage, '{}' eligibility and '[]'
-- documents. Between the two, a row could never become anything but a title and
-- a deadline. That was the whole of the "shallow data" problem: not the model,
-- not the crawler, this function.
--
-- The staging table needs no change -- `proposed` is JSONB and the pipeline now
-- writes more keys into it. What changes is which of those keys survive review.

-- ---------------------------------------------------------------------------
-- 1. Apply the deep fields too
-- ---------------------------------------------------------------------------
-- MERGE, NEVER REPLACE, for the two object columns. `||` is a key-wise merge:
-- an extraction that learned the stipend does not erase the tuition line a
-- previous one established. A key the extraction did not propose is a key the
-- page was silent about, and silence must not overwrite knowledge.
--
-- The two array columns cannot merge meaningfully -- a timeline or a checklist
-- is an ordered whole -- so they are replaced when non-empty and left alone
-- when empty. Note the empty case is a FIX: `COALESCE(proposed -> 'timeline',
-- timeline)` kept a proposed `[]`, because an empty JSON array is not SQL NULL,
-- so an extraction that found no timeline silently wiped one already there.
--
-- One consequence worth stating out loud: document_checklist keys are the ids
-- in user_targets.checklist_progress. Replacing the list can orphan a user's
-- ticked boxes for documents whose slug changed. That is the price of ever
-- correcting a checklist, and it is why the reviewer sees the proposal first.
CREATE OR REPLACE FUNCTION apply_extraction(extraction_id UUID)
RETURNS scholarships
LANGUAGE plpgsql
AS $$
DECLARE
    ext scholarship_extractions;
    result scholarships;
BEGIN
    SELECT * INTO ext FROM scholarship_extractions WHERE id = extraction_id;

    IF ext IS NULL THEN
        RAISE EXCEPTION 'No extraction with id %', extraction_id;
    END IF;

    IF ext.status <> 'pending' THEN
        RAISE EXCEPTION 'Extraction % is already %', extraction_id, ext.status;
    END IF;

    UPDATE scholarships SET
        cycle_label   = COALESCE(ext.proposed ->> 'cycle_label', cycle_label),
        opens_date    = COALESCE((ext.proposed ->> 'opens_date')::DATE, opens_date),
        deadline_date = COALESCE((ext.proposed ->> 'deadline_date')::DATE, deadline_date),

        timeline = CASE
            WHEN jsonb_typeof(ext.proposed -> 'timeline') = 'array'
             AND jsonb_array_length(ext.proposed -> 'timeline') > 0
            THEN ext.proposed -> 'timeline'
            ELSE timeline
        END,

        coverage_matrix = CASE
            WHEN jsonb_typeof(ext.proposed -> 'coverage_matrix') = 'object'
            THEN COALESCE(coverage_matrix, '{}'::jsonb) || (ext.proposed -> 'coverage_matrix')
            ELSE coverage_matrix
        END,

        eligibility_flags = CASE
            WHEN jsonb_typeof(ext.proposed -> 'eligibility_flags') = 'object'
            THEN COALESCE(eligibility_flags, '{}'::jsonb) || (ext.proposed -> 'eligibility_flags')
            ELSE eligibility_flags
        END,

        document_checklist = CASE
            WHEN jsonb_typeof(ext.proposed -> 'document_checklist') = 'array'
             AND jsonb_array_length(ext.proposed -> 'document_checklist') > 0
            THEN ext.proposed -> 'document_checklist'
            ELSE document_checklist
        END,

        post_study_obligations = COALESCE(
            NULLIF(ext.proposed ->> 'post_study_obligations', ''),
            post_study_obligations
        ),

        language_training_included = COALESCE(
            (ext.proposed ->> 'language_training_included')::BOOLEAN,
            language_training_included
        ),

        source_url    = ext.source_url,
        verification_status = 'ai_extracted',
        last_verified_at    = ext.fetched_at
    WHERE id = ext.scholarship_id
    RETURNING * INTO result;

    UPDATE scholarship_extractions
    SET status = 'applied', reviewed_at = NOW()
    WHERE id = extraction_id;

    RETURN result;
END;
$$;

COMMENT ON FUNCTION apply_extraction(UUID) IS
    'Promotes a reviewed extraction onto its scholarship row. Object columns merge key-wise; array columns are replaced only when the proposal is non-empty. Lands at ai_extracted, never verified.';

-- ---------------------------------------------------------------------------
-- 2. Show the reviewer what is on offer
-- ---------------------------------------------------------------------------
-- Counts, not contents: the queue view is for triage, and the full proposal is
-- one join away. Without these a reviewer cannot tell a dates-only extraction
-- from one that also carries a stipend and a checklist -- which is now the
-- difference that decides whether applying it is worth the click.
DROP VIEW IF EXISTS extraction_review;
CREATE VIEW extraction_review AS
SELECT
    e.id                AS extraction_id,
    s.title,
    s.country,
    e.proposed ->> 'cycle_label'   AS proposed_cycle,
    e.proposed ->> 'opens_date'    AS proposed_opens,
    e.proposed ->> 'deadline_date' AS proposed_deadline,
    e.evidence -> 'deadline_date' ->> 'quote' AS deadline_quote,
    e.evidence -> 'deadline_date' ->> 'confidence' AS deadline_confidence,

    CASE WHEN jsonb_typeof(e.proposed -> 'timeline') = 'array'
         THEN jsonb_array_length(e.proposed -> 'timeline') ELSE 0 END
        AS proposed_stages,
    CASE WHEN jsonb_typeof(e.proposed -> 'coverage_matrix') = 'object'
         THEN (SELECT count(*) FROM jsonb_object_keys(e.proposed -> 'coverage_matrix'))
         ELSE 0 END
        AS proposed_coverage_lines,
    CASE WHEN jsonb_typeof(e.proposed -> 'eligibility_flags') = 'object'
         THEN (SELECT count(*) FROM jsonb_object_keys(e.proposed -> 'eligibility_flags'))
         ELSE 0 END
        AS proposed_eligibility_fields,
    CASE WHEN jsonb_typeof(e.proposed -> 'document_checklist') = 'array'
         THEN jsonb_array_length(e.proposed -> 'document_checklist') ELSE 0 END
        AS proposed_documents,

    e.ungrounded_fields,
    e.caveats,
    e.page_subject,
    e.model_notes,
    e.source_url,
    e.fetched_at
FROM scholarship_extractions e
JOIN scholarships s ON s.id = e.scholarship_id
WHERE e.status = 'pending'
ORDER BY e.created_at DESC;
