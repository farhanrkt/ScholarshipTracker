-- ScholarTrack :: migration 014
-- Folding two rows that are one programme back into one row.
--
-- WHY THIS EXISTS. Dedupe at discovery time is exact-match on a normalised
-- title, so the catalogue accumulated rows that are the same award under
-- different names: `Chevening Scholarship` and `Chevening Scholarships`;
-- `Humphrey Fellowship Program` and `Hubert H. Humphrey Fellowship Program`.
-- 37 rows, of which 7 were Chevening and 3 were Humphrey. A student scrolling
-- the dashboard sees the same programme three times and cannot tell which entry
-- is the one to track.
--
-- Deleting the extra row is not enough, and this is the whole reason a function
-- exists instead of a DELETE. The duplicate carries things that must survive:
--
--   * users tracking it, with their document checklists half ticked
--   * second sources discovery recorded against it
--   * the extraction history that explains where its values came from
--   * fields the survivor happens to be missing
--
-- SECURITY DEFINER, with an explicit admin check. It has to be: `user_targets`
-- is protected by an owner-only RLS policy, so no admin session can re-point
-- another person's saved programme, and `scholarships` has no DELETE policy at
-- all. The guard below is what replaces those policies, so it must be the first
-- thing the function does.

CREATE OR REPLACE FUNCTION merge_scholarships(keep_id UUID, drop_id UUID)
RETURNS scholarships
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    survivor scholarships;
    victim   scholarships;
    result   scholarships;
BEGIN
    IF NOT is_admin() THEN
        RAISE EXCEPTION 'Only reviewers can merge scholarships';
    END IF;

    IF keep_id = drop_id THEN
        RAISE EXCEPTION 'A row cannot be merged into itself';
    END IF;

    SELECT * INTO survivor FROM scholarships WHERE id = keep_id;
    IF survivor IS NULL THEN
        RAISE EXCEPTION 'No scholarship with id %', keep_id;
    END IF;

    SELECT * INTO victim FROM scholarships WHERE id = drop_id;
    IF victim IS NULL THEN
        RAISE EXCEPTION 'No scholarship with id %', drop_id;
    END IF;

    -- -----------------------------------------------------------------------
    -- 1. People
    -- -----------------------------------------------------------------------
    -- Someone tracking BOTH rows would violate UNIQUE(user_id, scholarship_id)
    -- if the duplicate were simply re-pointed, so those are combined first:
    -- the further-along status wins, and ticked checklist items are unioned
    -- with the survivor's — a ticked box is work someone actually did, and
    -- losing it to a housekeeping operation would be unforgivable.
    UPDATE user_targets AS keep_target
    SET status = CASE
            WHEN 'submitted' IN (keep_target.status, drop_target.status) THEN 'submitted'
            WHEN 'in_progress' IN (keep_target.status, drop_target.status) THEN 'in_progress'
            ELSE keep_target.status
        END,
        checklist_progress =
            COALESCE(drop_target.checklist_progress, '{}'::jsonb)
            || COALESCE(keep_target.checklist_progress, '{}'::jsonb)
    FROM user_targets AS drop_target
    WHERE keep_target.scholarship_id = keep_id
      AND drop_target.scholarship_id = drop_id
      AND drop_target.user_id = keep_target.user_id;

    DELETE FROM user_targets AS drop_target
    WHERE drop_target.scholarship_id = drop_id
      AND EXISTS (
          SELECT 1 FROM user_targets AS keep_target
          WHERE keep_target.scholarship_id = keep_id
            AND keep_target.user_id = drop_target.user_id
      );

    UPDATE user_targets SET scholarship_id = keep_id WHERE scholarship_id = drop_id;

    -- -----------------------------------------------------------------------
    -- 2. Provenance
    -- -----------------------------------------------------------------------
    -- The duplicate's own page is itself a second source for the survivor: two
    -- rows meant two entry URLs, and the one being dropped is a real page
    -- describing this programme.
    INSERT INTO scholarship_sources (scholarship_id, url, authority, found_via)
    VALUES (keep_id, victim.official_portal_url, 'funder', 'merged duplicate row')
    ON CONFLICT (scholarship_id, url) DO NOTHING;

    UPDATE scholarship_sources AS moving
    SET scholarship_id = keep_id
    WHERE moving.scholarship_id = drop_id
      AND NOT EXISTS (
          SELECT 1 FROM scholarship_sources AS existing
          WHERE existing.scholarship_id = keep_id AND existing.url = moving.url
      );

    DELETE FROM scholarship_sources WHERE scholarship_id = drop_id;

    UPDATE scholarship_extractions SET scholarship_id = keep_id WHERE scholarship_id = drop_id;
    UPDATE scholarship_candidates  SET scholarship_id = keep_id WHERE scholarship_id = drop_id;

    -- -----------------------------------------------------------------------
    -- 3. The row itself
    -- -----------------------------------------------------------------------
    -- The survivor wins every contest; the duplicate only fills holes. Merging
    -- values across two rows would invent a programme neither page describes,
    -- and the survivor is the one a reviewer chose to keep.
    UPDATE scholarships SET
        cycle_label   = COALESCE(cycle_label,   victim.cycle_label),
        opens_date    = COALESCE(opens_date,    victim.opens_date),
        deadline_date = COALESCE(deadline_date, victim.deadline_date),
        source_url    = COALESCE(source_url,    victim.source_url),

        timeline = CASE
            WHEN jsonb_array_length(COALESCE(timeline, '[]'::jsonb)) > 0
            THEN timeline ELSE victim.timeline
        END,
        document_checklist = CASE
            WHEN jsonb_array_length(COALESCE(document_checklist, '[]'::jsonb)) > 0
            THEN document_checklist ELSE victim.document_checklist
        END,
        degree_levels = CASE
            WHEN COALESCE(array_length(degree_levels, 1), 0) > 0
            THEN degree_levels ELSE victim.degree_levels
        END,
        fields_of_study = CASE
            WHEN COALESCE(array_length(fields_of_study, 1), 0) > 0
            THEN fields_of_study ELSE victim.fields_of_study
        END,

        coverage_matrix   = COALESCE(victim.coverage_matrix, '{}'::jsonb)
                            || COALESCE(coverage_matrix, '{}'::jsonb),
        eligibility_flags = COALESCE(victim.eligibility_flags, '{}'::jsonb)
                            || COALESCE(eligibility_flags, '{}'::jsonb),
        field_sources     = COALESCE(victim.field_sources, '{}'::jsonb)
                            || COALESCE(field_sources, '{}'::jsonb),

        post_study_obligations     = COALESCE(post_study_obligations, victim.post_study_obligations),
        award_duration             = COALESCE(award_duration, victim.award_duration),
        number_of_awards           = COALESCE(number_of_awards, victim.number_of_awards),
        language_training_included = COALESCE(language_training_included, victim.language_training_included),

        -- Trust is not inherited. A human checked ONE of these rows, and which
        -- one they checked is the fact being recorded — so the survivor keeps
        -- its own status unless the duplicate was the verified one.
        verification_status = CASE
            WHEN verification_status = 'verified' OR victim.verification_status = 'verified'
            THEN 'verified'
            WHEN verification_status = 'ai_extracted' OR victim.verification_status = 'ai_extracted'
            THEN 'ai_extracted'
            ELSE verification_status
        END,
        last_verified_at = GREATEST(last_verified_at, victim.last_verified_at)
    WHERE id = keep_id
    RETURNING * INTO result;

    DELETE FROM scholarships WHERE id = drop_id;

    RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION merge_scholarships(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_scholarships(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION merge_scholarships(UUID, UUID) IS
    'Folds a duplicate row into the one being kept: moves trackers (combining checklists), sources, extractions and candidates, fills the survivor''s empty fields from the duplicate, then deletes it. SECURITY DEFINER with an is_admin() guard because user_targets is owner-only and scholarships has no DELETE policy. See migration 014.';
