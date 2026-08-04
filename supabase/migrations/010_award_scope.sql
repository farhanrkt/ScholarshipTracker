-- ScholarTrack :: migration 010
-- Three facts a student weighs first, which the pipeline could read and had
-- nowhere to store.
--
-- WHY THESE THREE. Coverage answers "what does it pay", eligibility answers
-- "can I apply", documents answer "what do I need". None of them answers the
-- questions that actually order a shortlist:
--
--   How long is it funded for?        award_duration
--   How many do they give out?        number_of_awards
--   Is my subject even eligible?      fields_of_study
--
-- The last one is the sharpest: a fully-funded PhD award restricted to
-- engineering is not a near-miss for a law applicant, it is noise, and until
-- now nothing in the row could say so.
--
-- TEXT, NOT NUMBERS, for duration and count. Pages write "up to three years, or
-- four where the programme requires it" and "approximately 1,500 awards
-- annually". Forcing those into an integer means choosing a number the page did
-- not state, which is the one thing this pipeline is built not to do. They are
-- stored as published and grounded like a stipend figure: every digit in the
-- value has to appear in the quote backing it.
--
-- fields_of_study is TEXT[] rather than free text because it is the one of the
-- three worth FILTERING on, and an array can be indexed for that.

ALTER TABLE scholarships
    ADD COLUMN IF NOT EXISTS fields_of_study  TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS award_duration   TEXT,
    ADD COLUMN IF NOT EXISTS number_of_awards TEXT;

COMMENT ON COLUMN scholarships.fields_of_study IS
    'Subject areas the award is RESTRICTED to. Empty means open to any subject — never "unknown". See migration 010.';
COMMENT ON COLUMN scholarships.award_duration IS
    'How long funding lasts, exactly as the official page words it. Null until read.';
COMMENT ON COLUMN scholarships.number_of_awards IS
    'How many awards are offered, exactly as the official page words it. Null until read.';

-- Mirrors scholarships_degree_levels_idx. The filter sidebar does not use this
-- yet -- a facet is noise until rows actually carry subjects, and they will not
-- until extractions have run against the new schema. The index is created now
-- because it is the natural home for that filter and costs nothing on a table
-- this size, not because something is already querying it.
CREATE INDEX IF NOT EXISTS scholarships_fields_of_study_idx
    ON scholarships USING GIN (fields_of_study);

-- ---------------------------------------------------------------------------
-- Carry them through review
-- ---------------------------------------------------------------------------
-- Same rules as migration 007, for the same reasons: text fields COALESCE so
-- silence never erases knowledge, and the array is replaced only when the
-- proposal is non-empty.
--
-- Note what an empty `fields_of_study` proposal means and why it must NOT be
-- written: the model returns [] both for "open to every subject" and for "these
-- pages did not discuss subject restrictions". Those are different facts and
-- the column cannot tell them apart, so an empty proposal is treated as the
-- second and left alone. A restriction is only ever added, never cleared, by
-- extraction — clearing one is a human's call.
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

        fields_of_study = CASE
            WHEN jsonb_typeof(ext.proposed -> 'fields_of_study') = 'array'
             AND jsonb_array_length(ext.proposed -> 'fields_of_study') > 0
            THEN ARRAY(
                SELECT jsonb_array_elements_text(ext.proposed -> 'fields_of_study')
            )
            ELSE fields_of_study
        END,

        award_duration = COALESCE(
            NULLIF(ext.proposed ->> 'award_duration', ''),
            award_duration
        ),

        number_of_awards = COALESCE(
            NULLIF(ext.proposed ->> 'number_of_awards', ''),
            number_of_awards
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
-- Surface them in the triage view
-- ---------------------------------------------------------------------------
-- The view exists so a reviewer can tell a dates-only extraction from a rich
-- one without opening it. These three are cheap to show and change that
-- judgement, so they are shown as values rather than counts.
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

    e.proposed ->> 'award_duration'   AS proposed_duration,
    e.proposed ->> 'number_of_awards' AS proposed_award_count,
    CASE WHEN jsonb_typeof(e.proposed -> 'fields_of_study') = 'array'
         THEN jsonb_array_length(e.proposed -> 'fields_of_study') ELSE 0 END
        AS proposed_study_fields,

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
