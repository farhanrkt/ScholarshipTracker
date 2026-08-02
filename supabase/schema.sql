-- ScholarTrack :: schema
-- Run this in the Supabase SQL editor (Dashboard -> SQL -> New query).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- TABLE 1: Scholarships
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scholarships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    country TEXT NOT NULL, -- Target focus: USA, UK, China, Japan, South Korea, Singapore
    degree_levels TEXT[] NOT NULL,
    coverage_matrix JSONB NOT NULL,
    eligibility_flags JSONB NOT NULL,
    document_checklist JSONB NOT NULL,
    post_study_obligations TEXT,
    language_training_included BOOLEAN DEFAULT false,
    official_portal_url TEXT NOT NULL,

    -- Application window. All nullable: "not announced yet" is a real answer,
    -- and a NOT NULL here would force whoever loads a row to invent a date.
    opens_date DATE,
    deadline_date DATE,
    cycle_label TEXT,           -- e.g. "2027/28 intake" -- stops cycle confusion
    timeline JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Provenance. Deliberately NOT defaulted: an unchecked row must read NULL,
    -- never "verified today".
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    source_url TEXT,            -- the exact page the dates were read from
    last_verified_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE scholarships
    DROP CONSTRAINT IF EXISTS scholarships_verification_status_check;
ALTER TABLE scholarships
    ADD CONSTRAINT scholarships_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified'));

-- ---------------------------------------------------------------------------
-- TABLE 2: User Tracking (Connects Users to Scholarships)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_targets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL, -- Comes from Supabase Auth
    scholarship_id UUID NOT NULL REFERENCES scholarships(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'saved', -- 'saved', 'in_progress', 'submitted'
    checklist_progress JSONB DEFAULT '{}', -- Tracks boolean state of individual documents
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, scholarship_id)
);

ALTER TABLE user_targets
    DROP CONSTRAINT IF EXISTS user_targets_status_check;
ALTER TABLE user_targets
    ADD CONSTRAINT user_targets_status_check
    CHECK (status IN ('saved', 'in_progress', 'submitted'));

-- ---------------------------------------------------------------------------
-- Indexes tuned for the dashboard's filter surface
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS scholarships_country_idx ON scholarships (country);
CREATE INDEX IF NOT EXISTS scholarships_deadline_idx ON scholarships (deadline_date);
CREATE INDEX IF NOT EXISTS scholarships_opens_idx ON scholarships (opens_date);
CREATE INDEX IF NOT EXISTS scholarships_verification_idx ON scholarships (verification_status);
CREATE INDEX IF NOT EXISTS scholarships_degree_levels_idx ON scholarships USING GIN (degree_levels);
CREATE INDEX IF NOT EXISTS scholarships_eligibility_idx ON scholarships USING GIN (eligibility_flags);
CREATE INDEX IF NOT EXISTS scholarships_coverage_idx ON scholarships USING GIN (coverage_matrix);
CREATE INDEX IF NOT EXISTS user_targets_user_idx ON user_targets (user_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_targets_set_updated_at ON user_targets;
CREATE TRIGGER user_targets_set_updated_at
    BEFORE UPDATE ON user_targets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Re-verification worklist
-- Staleness is DERIVED, never stored: a stored flag goes wrong the moment
-- nobody updates it.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Row Level Security
-- The anon key ships to the browser, so RLS is what actually protects the data.
-- Anonymous (ghost) users authenticate for real, so auth.uid() is populated and
-- the `authenticated` role covers them exactly like email users.
-- ---------------------------------------------------------------------------
ALTER TABLE scholarships ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_targets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Scholarships are readable by everyone" ON scholarships;
CREATE POLICY "Scholarships are readable by everyone"
    ON scholarships FOR SELECT
    TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "Users read their own targets" ON user_targets;
CREATE POLICY "Users read their own targets"
    ON user_targets FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users create their own targets" ON user_targets;
CREATE POLICY "Users create their own targets"
    ON user_targets FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update their own targets" ON user_targets;
CREATE POLICY "Users update their own targets"
    ON user_targets FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete their own targets" ON user_targets;
CREATE POLICY "Users delete their own targets"
    ON user_targets FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);
