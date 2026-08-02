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
