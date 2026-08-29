-- ---------------------------------------------------------------------------
-- 017: make /admin/coverage cheap
--
-- The view from 016 was written for clarity and reads like it. Per scholarship
-- row it ran THREE correlated lookups into `scholarship_extractions`: one for
-- the newest `gap_causes`, one to find `max(created_at)`, and one more to count
-- the causes at that timestamp. The middle one is a subquery inside a subquery,
-- and the index it all landed on — `scholarship_extractions_scholarship_idx`,
-- on `(scholarship_id)` alone — could find the rows but not order them, so
-- every lookup ended in a sort.
--
-- One LATERAL join does the same work once per row, and a composite index lets
-- "newest extraction for this scholarship" be an index seek instead of a scan
-- and sort. Same output, same security posture.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

-- "The newest extraction for this scholarship", as one index seek.
--
-- DESC matters: the query always wants the newest, and an ascending index has
-- to be walked backwards or sorted. The existing single-column index stays —
-- it still serves the plain `scholarship_id` lookups the review pages make.
CREATE INDEX IF NOT EXISTS scholarship_extractions_latest_idx
    ON scholarship_extractions (scholarship_id, created_at DESC);

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

    -- Null when nothing has read this row, which the UI renders as "no
    -- diagnosis recorded" rather than as "nothing to fix".
    latest.gap_causes,

    -- Counted off the same row the causes came from, rather than by going back
    -- to the table with a second correlated query.
    COALESCE((
        SELECT count(*)
          FROM jsonb_each_text(COALESCE(latest.gap_causes, '{}'::jsonb)) AS c(field, cause)
         WHERE c.cause IN ('never-crawled', 'not-retrieved', 'model-silent')
    ), 0) AS recoverable
FROM scholarships s
LEFT JOIN LATERAL (
    SELECT e.gap_causes
      FROM scholarship_extractions e
     WHERE e.scholarship_id = s.id
     ORDER BY e.created_at DESC
     LIMIT 1
) AS latest ON TRUE;

COMMENT ON VIEW scholarship_completeness IS
    'How much of each row is filled, how much the funder does not publish, and '
    'how many blanks the last reading blamed on the pipeline. Order by '
    'recoverable DESC to get the backlog worth re-running. One LATERAL lookup '
    'per row against scholarship_extractions_latest_idx — see migration 017.';

GRANT SELECT ON scholarship_completeness TO authenticated;
