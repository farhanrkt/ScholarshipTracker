-- ScholarTrack :: migration 009
-- "Nobody has read this" is not the same as "there is nothing to read."
--
-- WHY THIS EXISTS. The "No bond" filter was `post_study_obligations IS NULL`,
-- which is true for two completely different rows:
--
--   a programme whose pages say there is no return requirement
--   a skeleton from discovery that nobody has read at all
--
-- So a student filtering for "no bond" — one of the heaviest commitments a
-- scholarship can carry, several years of your life owed to a government —
-- was shown unchecked rows as though they had been cleared. The badge on the
-- card had the same bug and is fixed in `describeCommitment`; this is the same
-- fix for the query behind it.
--
-- A STORED GENERATED COLUMN rather than a view or a filter expression: it is
-- computed by Postgres from the row itself, so it cannot drift from the data,
-- and it can be indexed, which a three-way JSONB comparison in a WHERE clause
-- cannot be usefully.

ALTER TABLE scholarships
    ADD COLUMN IF NOT EXISTS is_profiled BOOLEAN
    GENERATED ALWAYS AS (
        coverage_matrix    <> '{}'::jsonb
     OR eligibility_flags  <> '{}'::jsonb
     OR document_checklist <> '[]'::jsonb
    ) STORED;

COMMENT ON COLUMN scholarships.is_profiled IS
    'True once anything has read this programme''s coverage, eligibility or documents. Distinguishes "the pages say no" from "nobody has looked" — see migration 009.';

CREATE INDEX IF NOT EXISTS scholarships_is_profiled_idx
    ON scholarships (is_profiled);

-- Handy for spotting what still needs a crawl:
--   select title, source_url from scholarships where not is_profiled;
