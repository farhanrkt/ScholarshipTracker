-- ---------------------------------------------------------------------------
-- 016: "Not stated by the programme", and why every other blank is blank
--
-- TWO PROBLEMS, ONE CAUSE. The row could not distinguish a fact the funder does
-- not publish from a fact nothing ever looked for, and neither could the people
-- working on the pipeline.
--
-- For a STUDENT that is a worse blank than it looks. A card showing nothing
-- next to "Airfare" is not neutral: the reader has to decide whether the award
-- excludes flights or whether nobody checked, and there is no way to tell. One
-- of those is an answer worth planning around. Migration 013 fixed exactly this
-- for eligibility, using explicit nulls inside `eligibility_flags`; coverage is
-- defined by OMITTING silent lines and the scope columns are plain text, so
-- neither has anywhere to put the distinction. `not_stated` is that place, and
-- it is deliberately one list for every field rather than a third mechanism.
--
-- For an OPERATOR the same absence made "improve coverage" unfalsifiable. A
-- blank caused by a crawl that never fetched the benefits page and a blank
-- caused by a funder that publishes no stipend are identical in the database
-- and are fixed in completely different files. `gap_causes` records which,
-- per field, per reading — see scripts/extract/diagnosis.ts.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. What the pages were read for and do not state
-- ---------------------------------------------------------------------------

ALTER TABLE scholarships
    ADD COLUMN IF NOT EXISTS not_stated TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN scholarships.not_stated IS
    'Field keys the pipeline read these pages for and found unstated, e.g. '
    '{coverage.airfare,award_duration}. Renders as "Not stated by the '
    'programme", which is an ANSWER — distinct from a blank, which means nobody '
    'has looked. Only ever written from a reading that actually reached the '
    'relevant pages: see notStatedFields() in scripts/extract/diagnosis.ts, '
    'which admits only the `not-published` cause.';

-- Answering "which rows say nothing about the money" without a table scan.
CREATE INDEX IF NOT EXISTS scholarships_not_stated_idx
    ON scholarships USING GIN (not_stated);

-- ---------------------------------------------------------------------------
-- 2. Why each remaining blank is blank
-- ---------------------------------------------------------------------------

ALTER TABLE scholarship_extractions
    ADD COLUMN IF NOT EXISTS gap_causes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN scholarship_extractions.gap_causes IS
    'Per-field diagnosis of every slot this reading left empty: never-crawled, '
    'not-retrieved, model-silent, grounding-rejected, not-published. A property '
    'of the READING, not of the programme — which is why it stays here and is '
    'never proposed onto the row. The first three are pipeline bugs and are the '
    'backlog /admin/coverage ranks by; the last two are the pipeline working.';

-- ---------------------------------------------------------------------------
-- 3. apply_extraction(), carrying not_stated
--
-- REPLACES the version from 013 and is a superset of it. Everything below the
-- not_stated block is unchanged; re-applying 013 after this would regress.
-- ---------------------------------------------------------------------------

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
    -- Field keys this reading proved the pages do not state.
    unstated TEXT[];
    -- Keys this reading FILLED. A field cannot be both, and the value wins.
    answered TEXT[];
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

    unstated := CASE
        WHEN jsonb_typeof(ext.proposed -> 'not_stated') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(ext.proposed -> 'not_stated'))
        ELSE '{}'::TEXT[]
    END;

    /*
     * Everything this proposal actually put a value in.
     *
     * A reading can report a field unstated and — after a later pass, a second
     * source, or a merge — carry a value for it anyway. The value is the half
     * worth keeping, so it is subtracted from the silence list below rather
     * than the two being allowed to coexist on the row and contradict each
     * other on the card.
     */
    SELECT COALESCE(ARRAY(
               SELECT 'coverage.' || key
                 FROM jsonb_object_keys(
                          CASE WHEN jsonb_typeof(ext.proposed -> 'coverage_matrix') = 'object'
                               THEN ext.proposed -> 'coverage_matrix'
                               ELSE '{}'::jsonb END
                      ) AS key
               UNION ALL
               SELECT 'eligibility.' || key
                 FROM jsonb_object_keys(
                          CASE WHEN jsonb_typeof(ext.proposed -> 'eligibility_flags') = 'object'
                               THEN ext.proposed -> 'eligibility_flags'
                               ELSE '{}'::jsonb END
                      ) AS key
           ), '{}')
      INTO answered;

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

        /*
         * ADDITIVE, and then pruned by what is now known.
         *
         * Additive because a reading that did not reach the benefits page has
         * learned nothing about whether the airfare is stated, and clearing the
         * list would let a thin run erase a previous run's honest finding —
         * the same mistake the original `COALESCE(proposed -> 'timeline', …)`
         * made with timelines, where an empty array silently wiped a real one.
         *
         * Pruned because the moment any reading produces a VALUE for a field,
         * "the programme does not state this" is false and must stop being
         * displayed. That is why `answered` is subtracted here and not merely
         * excluded from `unstated`: the contradiction can arrive from an
         * earlier row state as easily as from this proposal.
         */
        not_stated = ARRAY(
            SELECT DISTINCT key
              FROM unnest(COALESCE(not_stated, '{}') || unstated) AS key
             WHERE key <> ALL (answered)
             ORDER BY key
        ),

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
    'Applies a staged proposal to its scholarship row. Object columns merge '
    'key-wise, array columns are replaced only when non-empty, '
    '`eligibility_silent` fills unanswered questions with explicit nulls at the '
    'LOWEST priority, and `not_stated` accumulates the facts the pages were read '
    'for and do not state — pruned whenever a value for one arrives. '
    'Supersedes migrations 011 and 013. See migration 016.';

-- ---------------------------------------------------------------------------
-- 4. Completeness as a worklist
--
-- The operator-facing half. Ranks the catalogue by how much of it is missing
-- and how much of that is OUR fault, which is the order to work in — a row
-- whose blanks are all `not-published` is finished, however empty it looks.
--
-- `security_invoker` IS LOAD-BEARING, and migration 012 declined to add a view
-- at all rather than get this wrong. A view is owned by whoever created it and,
-- without this setting, reads its underlying tables with the OWNER's rights —
-- which here would hand every authenticated visitor a window onto
-- `scholarship_extractions`, the table whose whole point is that it is deny-all
-- because it holds unreviewed model output.
--
-- With it, RLS is evaluated as the querying user: an admin sees the diagnosis,
-- and everyone else sees the scholarship columns they could already read with
-- `gap_causes` empty and `recoverable` zero. Silently degraded rather than
-- denied, which is right for a page that is admin-gated anyway.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW scholarship_completeness
WITH (security_invoker = true) AS
SELECT
    s.id,
    s.title,
    s.country,
    s.verification_status,
    s.official_portal_url,

    -- The 25 slots gaps.ts counts, computed the same way here so the dashboard
    -- and the run log cannot disagree about what "filled" means.
    (
        (
            SELECT count(*)
              FROM jsonb_object_keys(
                       CASE WHEN jsonb_typeof(s.coverage_matrix) = 'object'
                            THEN s.coverage_matrix ELSE '{}'::jsonb END
                   )
        )
      + (
            -- Mirrors profileGaps(): `notes` is prose rather than a fact slot,
            -- an explicit null is an ANSWER but not a filled slot, and an empty
            -- array is what "we did not find it" also looks like.
            SELECT count(*)
              FROM jsonb_each(
                       CASE WHEN jsonb_typeof(s.eligibility_flags) = 'object'
                            THEN s.eligibility_flags ELSE '{}'::jsonb END
                   ) AS f(key, value)
             WHERE f.key <> 'notes'
               AND jsonb_typeof(f.value) <> 'null'
               AND NOT (jsonb_typeof(f.value) = 'array'
                        AND jsonb_array_length(f.value) = 0)
        )
      + CASE WHEN jsonb_typeof(s.document_checklist) = 'array'
              AND jsonb_array_length(s.document_checklist) > 0 THEN 1 ELSE 0 END
      + CASE WHEN s.post_study_obligations IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN s.language_training_included IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN COALESCE(array_length(s.fields_of_study, 1), 0) > 0 THEN 1 ELSE 0 END
      + CASE WHEN s.award_duration IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN s.number_of_awards IS NOT NULL THEN 1 ELSE 0 END
    ) AS filled,

    25 AS total,
    COALESCE(array_length(s.not_stated, 1), 0) AS not_stated_count,

    -- The newest reading's diagnosis, which is what says whether the blanks are
    -- worth another run.
    (
        SELECT e.gap_causes
          FROM scholarship_extractions e
         WHERE e.scholarship_id = s.id
         ORDER BY e.created_at DESC
         LIMIT 1
    ) AS gap_causes,

    (
        SELECT count(*)
          FROM scholarship_extractions e,
               jsonb_each_text(e.gap_causes) AS c(field, cause)
         WHERE e.scholarship_id = s.id
           AND e.created_at = (
               SELECT max(created_at) FROM scholarship_extractions
                WHERE scholarship_id = s.id
           )
           AND c.cause IN ('never-crawled', 'not-retrieved', 'model-silent')
    ) AS recoverable
FROM scholarships s;

COMMENT ON VIEW scholarship_completeness IS
    'How much of each row is filled, how much the funder does not publish, and '
    'how many blanks the last reading blamed on the pipeline. Order by '
    'recoverable DESC to get the backlog worth re-running.';

GRANT SELECT ON scholarship_completeness TO authenticated;
