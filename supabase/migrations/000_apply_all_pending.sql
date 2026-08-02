-- ScholarTrack :: migrations 002 + 003 + 004, concatenated for a single run.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / OR REPLACE /
-- DROP POLICY IF EXISTS). Run this once in the Supabase SQL editor.
-- Prerequisite: schema.sql, and 001_application_window_and_provenance.sql if
-- your project predates the provenance work.
--
-- NOT THE LATEST STATE. This bundle stops at 004 and still contains the
-- dates-only apply_extraction(). Run 005, 006 and 007 after it, in order, or
-- you will re-install a function that silently discards coverage, eligibility
-- and document proposals.

-- ===========================================================================
-- 002_ai_extraction.sql
-- ===========================================================================
-- ScholarTrack :: migration 002
-- AI-assisted extraction, with a staging table and a third trust tier.
--
-- THE RULE THIS ENCODES: an AI extraction is a PROPOSAL, never a fact.
-- Model output lands in `scholarship_extractions` and only reaches
-- `scholarships` when a human applies it. Otherwise we would have rebuilt the
-- fabricated-deadline problem, at ten times the speed.

-- ---------------------------------------------------------------------------
-- 1. Third verification tier
-- ---------------------------------------------------------------------------
-- 'ai_extracted' sits between unverified and verified: a model read it off the
-- page and every value is backed by a verbatim quote that was checked against
-- the fetched text -- but no human has opened the portal. The UI says so.
ALTER TABLE scholarships
    DROP CONSTRAINT IF EXISTS scholarships_verification_status_check;
ALTER TABLE scholarships
    ADD CONSTRAINT scholarships_verification_status_check
    CHECK (verification_status IN ('unverified', 'ai_extracted', 'verified'));

-- ---------------------------------------------------------------------------
-- 2. Staging table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scholarship_extractions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scholarship_id UUID NOT NULL REFERENCES scholarships(id) ON DELETE CASCADE,

    -- Provenance of the extraction itself
    source_url TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    page_sha256 TEXT NOT NULL,      -- so a re-run can detect an unchanged page
    model TEXT NOT NULL,

    -- What the model proposes: same shape as the scholarships columns
    proposed JSONB NOT NULL,        -- { cycle_label, opens_date, deadline_date, timeline }

    -- Why it believes it. One entry per field:
    --   { quote, grounded, confidence }
    -- `grounded` is set by the pipeline, not the model: it is true only when the
    -- verbatim quote was found in the fetched page text.
    evidence JSONB NOT NULL,

    -- Fields whose quote could NOT be located in the page. Their values are
    -- nulled out before insert -- this column exists so the reviewer can see
    -- what the model claimed and the pipeline rejected.
    ungrounded_fields TEXT[] NOT NULL DEFAULT '{}',

    -- The model's own summary of what the page is about. If this does not match
    -- the scholarship title, the fetch probably landed on a redirect or a 404.
    page_subject TEXT,

    model_notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TIMESTAMPTZ,
    reviewer_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE scholarship_extractions
    DROP CONSTRAINT IF EXISTS scholarship_extractions_status_check;
ALTER TABLE scholarship_extractions
    ADD CONSTRAINT scholarship_extractions_status_check
    CHECK (status IN ('pending', 'applied', 'rejected'));

CREATE INDEX IF NOT EXISTS scholarship_extractions_pending_idx
    ON scholarship_extractions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS scholarship_extractions_scholarship_idx
    ON scholarship_extractions (scholarship_id);

-- ---------------------------------------------------------------------------
-- 3. RLS: nobody reaches this table with the anon key
-- ---------------------------------------------------------------------------
-- Enabled with NO policies, which is a deny-all. The extraction script uses the
-- service-role key (which bypasses RLS) and runs on your machine, never in the
-- browser. This table holds unreviewed model output -- it must not be readable
-- by the public app.
ALTER TABLE scholarship_extractions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. Review queue
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW extraction_review AS
SELECT
    e.id                AS extraction_id,
    s.title,
    s.country,
    e.proposed ->> 'cycle_label'   AS proposed_cycle,
    e.proposed ->> 'opens_date'    AS proposed_opens,
    e.proposed ->> 'deadline_date' AS proposed_deadline,
    e.evidence -> 'deadline_date' ->> 'quote' AS deadline_quote,
    e.evidence -> 'deadline_date' ->> 'confidence' AS deadline_confidence,
    e.ungrounded_fields,
    e.page_subject,
    e.model_notes,
    e.source_url,
    e.fetched_at
FROM scholarship_extractions e
JOIN scholarships s ON s.id = e.scholarship_id
WHERE e.status = 'pending'
ORDER BY e.created_at DESC;

-- ---------------------------------------------------------------------------
-- 5. Promote a reviewed extraction
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (the default): this runs with the caller's privileges, so
-- RLS still applies. The anon key has no UPDATE policy on `scholarships`, which
-- means a browser client cannot promote anything even if it learned an id.
--
-- Lands the row at 'ai_extracted', NOT 'verified'. Promotion to 'verified' is a
-- separate act by someone who has opened the portal themselves.
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
        timeline      = COALESCE(ext.proposed -> 'timeline', timeline),
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

CREATE OR REPLACE FUNCTION reject_extraction(extraction_id UUID, why TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE scholarship_extractions
    SET status = 'rejected', reviewed_at = NOW(), reviewer_notes = why
    WHERE id = extraction_id AND status = 'pending';
$$;

-- ===========================================================================
-- 003_admin_review.sql
-- ===========================================================================
-- ScholarTrack :: migration 003
-- Admin review, enforced by the database rather than by page code.
--
-- The review UI must read `scholarship_extractions`, which is deny-all. The
-- tempting shortcut is to give the web app the service-role key. Don't: that key
-- bypasses EVERY policy, and one accidental import from a client component
-- would ship it to the browser.
--
-- Instead an allowlist table drives RLS. The app keeps using the anon key, the
-- rules live in Postgres, and "who may review" is data you can change with an
-- INSERT rather than a redeploy.

CREATE TABLE IF NOT EXISTS admins (
    email TEXT PRIMARY KEY,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- An admin may see the allowlist. Nobody else can read it at all, so the list
-- of privileged addresses is not an anonymous-readable target.
DROP POLICY IF EXISTS "Admins read the allowlist" ON admins;
CREATE POLICY "Admins read the allowlist"
    ON admins FOR SELECT
    TO authenticated
    USING (LOWER(email) = LOWER(auth.jwt() ->> 'email'));

-- --------------------------------------------------------------------------
-- Is the caller an admin?
--
-- SECURITY DEFINER so it can consult `admins` regardless of the caller's own
-- policies, with an empty search_path so a caller cannot shadow the table with
-- one of their own. Anonymous sessions carry no email claim, so they are out.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.admins
        WHERE LOWER(email) = LOWER(auth.jwt() ->> 'email')
    );
$$;

-- --------------------------------------------------------------------------
-- Review access
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins read extractions" ON scholarship_extractions;
CREATE POLICY "Admins read extractions"
    ON scholarship_extractions FOR SELECT
    TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admins resolve extractions" ON scholarship_extractions;
CREATE POLICY "Admins resolve extractions"
    ON scholarship_extractions FOR UPDATE
    TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

-- apply_extraction() is SECURITY INVOKER, so promoting a row needs the caller
-- to hold an UPDATE policy on `scholarships` as well. Only admins get one --
-- everyone else still cannot write to the table at all.
DROP POLICY IF EXISTS "Admins update scholarships" ON scholarships;
CREATE POLICY "Admins update scholarships"
    ON scholarships FOR UPDATE
    TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

-- --------------------------------------------------------------------------
-- Add yourself
-- --------------------------------------------------------------------------
-- Replace with the address you linked in the app, then sign in with it.
-- INSERT INTO admins (email, note) VALUES ('you@example.com', 'founder');

-- ===========================================================================
-- 004_discovery.sql
-- ===========================================================================
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

