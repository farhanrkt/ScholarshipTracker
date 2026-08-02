-- ScholarTrack :: migration 001
-- Application windows + honest provenance.
--
-- Run this once against an existing project. New projects get the same shape
-- from schema.sql and do not need it.
--
-- WHY:
--  1. A single `deadline_date` cannot express "opens 4 Aug, closes 6 Oct", nor
--     the intermediate stages (references, offer deadline, interviews).
--  2. `last_verified_at DEFAULT NOW()` stamped every row as verified at insert
--     time. That is a provenance claim the data never earned, and the UI was
--     printing it as fact.
--  3. `deadline_date NOT NULL` forced whoever loaded a row to invent a date
--     when the real one was unknown or unannounced.

-- --------------------------------------------------------------------------
-- 1. Application window
-- --------------------------------------------------------------------------
ALTER TABLE scholarships
    ADD COLUMN IF NOT EXISTS opens_date DATE,
    ADD COLUMN IF NOT EXISTS cycle_label TEXT,
    ADD COLUMN IF NOT EXISTS timeline JSONB NOT NULL DEFAULT '[]'::jsonb;

-- "Not published yet" is a legitimate answer.
ALTER TABLE scholarships ALTER COLUMN deadline_date DROP NOT NULL;

-- --------------------------------------------------------------------------
-- 2. Provenance
-- --------------------------------------------------------------------------
ALTER TABLE scholarships
    ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified',
    -- The exact page a human read. `official_portal_url` is the front door;
    -- this is the timeline/deadline page the dates actually came from.
    ADD COLUMN IF NOT EXISTS source_url TEXT;

ALTER TABLE scholarships
    DROP CONSTRAINT IF EXISTS scholarships_verification_status_check;
ALTER TABLE scholarships
    ADD CONSTRAINT scholarships_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified'));

-- No default: a row that was never checked must read NULL, not "today".
ALTER TABLE scholarships ALTER COLUMN last_verified_at DROP DEFAULT;

-- Every existing row was auto-stamped and means nothing. Reset it, and drop the
-- fabricated deadlines with it -- a blank field is honest, a wrong date is not.
UPDATE scholarships
SET last_verified_at    = NULL,
    verification_status = 'unverified',
    deadline_date       = NULL,
    opens_date          = NULL;

-- --------------------------------------------------------------------------
-- 3. Staleness is DERIVED, never stored
-- --------------------------------------------------------------------------
-- A stored 'stale' flag goes wrong the moment nobody updates it. This view is
-- the re-verification worklist: anything unverified, past its deadline (the
-- cycle has rolled over), or unchecked for 90+ days.
CREATE OR REPLACE VIEW scholarships_needing_review AS
SELECT
    id,
    title,
    country,
    cycle_label,
    deadline_date,
    last_verified_at,
    verification_status,
    COALESCE(source_url, official_portal_url) AS check_url,
    CASE
        WHEN verification_status = 'unverified' THEN 'never verified'
        WHEN deadline_date IS NOT NULL AND deadline_date < CURRENT_DATE THEN 'deadline passed, cycle likely rolled over'
        WHEN last_verified_at IS NULL THEN 'no verification date recorded'
        ELSE 'not checked in 90+ days'
    END AS reason
FROM scholarships
WHERE verification_status = 'unverified'
   OR last_verified_at IS NULL
   OR last_verified_at < NOW() - INTERVAL '90 days'
   OR (deadline_date IS NOT NULL AND deadline_date < CURRENT_DATE)
ORDER BY deadline_date NULLS FIRST;

CREATE INDEX IF NOT EXISTS scholarships_opens_idx ON scholarships (opens_date);
CREATE INDEX IF NOT EXISTS scholarships_verification_idx ON scholarships (verification_status);
