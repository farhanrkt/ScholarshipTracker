-- ScholarTrack :: migration 013
-- "The pages do not say" is an answer. The row had nowhere to put it.
--
-- WHY THIS EXISTS. `eligibility_flags` carried only the questions that got a
-- VALUE, so two completely different rows looked identical:
--
--   a programme whose eligibility page states no work-experience minimum
--   a skeleton from discovery that nobody has read at all
--
-- The "No work experience required" filter was `min_work_experience_years IS
-- NULL`, so it matched both — 23 of 37 rows, offered to a student as "open to
-- applicants straight out of university" on no evidence whatsoever — while
-- EXCLUDING the one row whose pages actually say none is needed, because a
-- stated 0 is not null. Wrong in both directions from the same missing
-- distinction. This is migration 009's problem again, one level down: 009 gave
-- the ROW an "has anything read this?" flag, and this gives the same to each
-- QUESTION on it.
--
-- HOW IT IS EXPRESSED. An explicit JSON null under the key. That makes the
-- column three-valued, which is what the UI has always claimed it was:
--
--   key absent          nobody asked
--   key present, null   asked; the pages state nothing
--   key present, value  the pages state this
--
-- In PostgREST, `->` tells the first apart from the other two and `->>` does
-- not. Queries that must not answer "unknown" as "no" have to use `->`.
--
-- WHY THE PROPOSAL CARRIES A LIST AND NOT THE NULLS THEMSELVES. `||` is
-- last-wins. Nulls arriving inside `proposed -> 'eligibility_flags'` would be
-- merged at the same priority as real values, so a run that failed to find the
-- age limit would ERASE the age limit a previous run had found. Sent as a list,
-- they can be merged underneath everything, where they can only fill a hole.

CREATE OR REPLACE FUNCTION apply_extraction(extraction_id UUID)
RETURNS scholarships
LANGUAGE plpgsql
AS $$
DECLARE
    ext scholarship_extractions;
    result scholarships;
    -- {"max_age": null, "min_ielts": null, ...} for the questions this reading
    -- asked and found no answer to.
    silent JSONB;
BEGIN
    SELECT * INTO ext FROM scholarship_extractions WHERE id = extraction_id;

    IF ext IS NULL THEN
        RAISE EXCEPTION 'No extraction with id %', extraction_id;
    END IF;

    IF ext.status <> 'pending' THEN
        RAISE EXCEPTION 'Extraction % is already %', extraction_id, ext.status;
    END IF;

    SELECT COALESCE(jsonb_object_agg(key, 'null'::jsonb), '{}'::jsonb)
      INTO silent
      FROM jsonb_array_elements_text(
               CASE
                   WHEN jsonb_typeof(ext.proposed -> 'eligibility_silent') = 'array'
                   THEN ext.proposed -> 'eligibility_silent'
                   ELSE '[]'::jsonb
               END
           ) AS key;

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

        -- THE ORDER IS THE POINT, and `||` is last-wins:
        --   silent    lowest  — only ever fills a key nothing else has
        --   existing  middle  — an earlier reading's findings survive
        --   proposed  highest — this reading's findings win
        eligibility_flags =
            silent
            || COALESCE(eligibility_flags, '{}'::jsonb)
            || CASE
                   WHEN jsonb_typeof(ext.proposed -> 'eligibility_flags') = 'object'
                   THEN ext.proposed -> 'eligibility_flags'
                   ELSE '{}'::jsonb
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

        field_sources = CASE
            WHEN jsonb_typeof(ext.proposed -> 'field_sources') = 'object'
            THEN COALESCE(field_sources, '{}'::jsonb) || (ext.proposed -> 'field_sources')
            ELSE field_sources
        END,

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
    'Applies a staged proposal to its scholarship row. Object columns merge key-wise, array columns are replaced only when non-empty, and `eligibility_silent` fills unanswered questions with explicit nulls at the LOWEST priority so a "not stated" can never overwrite a value an earlier reading found. See migration 013.';

-- `is_profiled` (migration 009) is GENERATED from `eligibility_flags <> '{}'`,
-- so a row that gains nothing but silence markers now reads as profiled — which
-- is correct: something did read it, and finding nothing is a finding.
COMMENT ON COLUMN scholarships.eligibility_flags IS
    'Three-valued per key: absent = nobody asked, JSON null = asked and the pages state nothing, value = the pages state this. Use `->` (not `->>`) in any query that must not answer "unknown" as "no". See migration 013.';
