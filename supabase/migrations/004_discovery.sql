-- ScholarTrack :: migration 004
-- Discovery staging.
--
-- Discovery answers "does this programme exist and is it relevant?" — a
-- different question from extraction's "what are its dates?", so it gets its
-- own staging table and its own review step.
--
-- Note what is NOT here: no grounding. Classification is a judgement, not a
-- fact copied off a page, and a wrong one costs a wasted fetch rather than a
-- wrong date on someone's calendar. Dates are never taken from this stage —
-- a promoted candidate starts with NO dates and goes through extraction like
-- everything else.

CREATE TABLE IF NOT EXISTS scholarship_candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Where we found it
    url TEXT NOT NULL,
    found_via TEXT NOT NULL,        -- the seed index page that linked to it
    fetched_at TIMESTAMPTZ NOT NULL,
    model TEXT NOT NULL,

    -- What the classifier thinks it is
    programme_name TEXT NOT NULL,
    funder TEXT,
    host_country TEXT,
    degree_levels TEXT[] NOT NULL DEFAULT '{}',
    is_fully_funded BOOLEAN,
    open_to_international BOOLEAN,
    confidence TEXT NOT NULL,
    summary TEXT,

    -- Review
    status TEXT NOT NULL DEFAULT 'pending',
    scholarship_id UUID REFERENCES scholarships(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    reviewer_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Cheap dedupe: the same page must not queue twice.
    UNIQUE (url)
);

ALTER TABLE scholarship_candidates
    DROP CONSTRAINT IF EXISTS scholarship_candidates_status_check;
ALTER TABLE scholarship_candidates
    ADD CONSTRAINT scholarship_candidates_status_check
    CHECK (status IN ('pending', 'promoted', 'rejected'));

ALTER TABLE scholarship_candidates
    DROP CONSTRAINT IF EXISTS scholarship_candidates_confidence_check;
ALTER TABLE scholarship_candidates
    ADD CONSTRAINT scholarship_candidates_confidence_check
    CHECK (confidence IN ('high', 'medium', 'low'));

CREATE INDEX IF NOT EXISTS scholarship_candidates_pending_idx
    ON scholarship_candidates (status, confidence, created_at DESC);

-- Deny-all by default; admins get in through the policies below.
ALTER TABLE scholarship_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read candidates" ON scholarship_candidates;
CREATE POLICY "Admins read candidates"
    ON scholarship_candidates FOR SELECT
    TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admins resolve candidates" ON scholarship_candidates;
CREATE POLICY "Admins resolve candidates"
    ON scholarship_candidates FOR UPDATE
    TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

-- Promoting inserts into `scholarships`, so admins need an INSERT policy there.
DROP POLICY IF EXISTS "Admins insert scholarships" ON scholarships;
CREATE POLICY "Admins insert scholarships"
    ON scholarships FOR INSERT
    TO authenticated
    WITH CHECK (is_admin());

-- --------------------------------------------------------------------------
-- Promote a candidate into a real (but dateless, unverified) scholarship row
-- --------------------------------------------------------------------------
-- Deliberately creates a SKELETON: no dates, no coverage, no eligibility, and
-- verification_status 'unverified'. Discovery establishes that a programme
-- exists; extraction and a human fill in what is true about it.
CREATE OR REPLACE FUNCTION promote_candidate(candidate_id UUID)
RETURNS scholarships
LANGUAGE plpgsql
AS $$
DECLARE
    cand scholarship_candidates;
    created scholarships;
BEGIN
    SELECT * INTO cand FROM scholarship_candidates WHERE id = candidate_id;

    IF cand IS NULL THEN
        RAISE EXCEPTION 'No candidate with id %', candidate_id;
    END IF;
    IF cand.status <> 'pending' THEN
        RAISE EXCEPTION 'Candidate % is already %', candidate_id, cand.status;
    END IF;

    INSERT INTO scholarships (
        title, country, degree_levels,
        coverage_matrix, eligibility_flags, document_checklist,
        official_portal_url, source_url,
        verification_status
    ) VALUES (
        cand.programme_name,
        COALESCE(cand.host_country, 'Unknown'),
        CASE WHEN cardinality(cand.degree_levels) > 0
             THEN cand.degree_levels
             ELSE ARRAY['Masters'] END,
        '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
        cand.url, cand.url,
        'unverified'
    )
    RETURNING * INTO created;

    UPDATE scholarship_candidates
    SET status = 'promoted', scholarship_id = created.id, reviewed_at = NOW()
    WHERE id = candidate_id;

    RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION reject_candidate(candidate_id UUID, why TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE scholarship_candidates
    SET status = 'rejected', reviewed_at = NOW(), reviewer_notes = why
    WHERE id = candidate_id AND status = 'pending';
$$;
