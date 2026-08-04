-- ScholarTrack :: migration 011
-- Reading a programme from more than one source, and saying which one said what.
--
-- WHY THIS EXISTS. Grounding proves a source SAID something. It cannot prove
-- the source was right, and those stop being the same question the moment two
-- sites describe one award: a university page saying Chevening closes on 12
-- October grounds exactly as well as chevening.org saying 6 October. One of
-- them is last year's.
--
-- Two things are needed for that. Somewhere to remember the other sources, and
-- somewhere to record which source each field's value actually came from.
--
-- WHERE THE OTHER SOURCES COME FROM -- and this is the part that needs no
-- search engine. Discovery already meets them: when it classifies a page and
-- the programme name matches a row we have, it counts a `duplicate` and throws
-- the URL away. That URL is a second site describing a programme we track,
-- which is precisely what cross-verification needs. It was being discarded
-- because there was nowhere to put it.

-- ---------------------------------------------------------------------------
-- 1. Other pages that describe a programme we already have
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scholarship_sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scholarship_id UUID NOT NULL REFERENCES scholarships(id) ON DELETE CASCADE,

    url TEXT NOT NULL,

    -- Tier at the time of discovery. Stored rather than derived because the
    -- rules in scripts/discover/authority.ts will change, and an extraction
    -- must stay explainable against the rules it actually ran under.
    --   funder    the programme's own organisation
    --   official  a government or academic body that is not the funder
    --   other     everything else
    authority TEXT NOT NULL CHECK (authority IN ('funder', 'official', 'other')),

    -- Which seed or run surfaced it, for auditing a bad source back to its origin.
    found_via TEXT,

    discovered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_checked_at TIMESTAMPTZ,

    -- Set when a source turns out to be useless or wrong, so a human's decision
    -- to stop reading it survives the next discovery run re-finding it.
    muted BOOLEAN NOT NULL DEFAULT FALSE,
    muted_reason TEXT,

    UNIQUE (scholarship_id, url)
);

COMMENT ON TABLE scholarship_sources IS
    'Pages on OTHER sites that describe a programme we track. Populated by discovery from what it used to discard as duplicates; read by extraction --verify. Never a source of facts on its own -- every value still has to survive grounding.';

CREATE INDEX IF NOT EXISTS scholarship_sources_scholarship_idx
    ON scholarship_sources (scholarship_id) WHERE NOT muted;

ALTER TABLE scholarship_sources ENABLE ROW LEVEL SECURITY;

-- Deny-all by default, exactly like the other staging tables: the service role
-- bypasses RLS for the scripts, and admins read it in the review UI.
DROP POLICY IF EXISTS "Admins read sources" ON scholarship_sources;
CREATE POLICY "Admins read sources"
    ON scholarship_sources FOR SELECT
    TO authenticated
    USING (is_admin());

DROP POLICY IF EXISTS "Admins manage sources" ON scholarship_sources;
CREATE POLICY "Admins manage sources"
    ON scholarship_sources FOR UPDATE
    TO authenticated
    USING (is_admin())
    WITH CHECK (is_admin());

-- ---------------------------------------------------------------------------
-- 2. Which source each field's value came from
-- ---------------------------------------------------------------------------
-- Shape, keyed by field name:
--
--   {
--     "deadline_date": {
--       "authority": "funder",
--       "source_url": "https://www.chevening.org/scholarships/application-timeline/",
--       "corroborated_by": [{"url": "...", "authority": "official"}],
--       "conflicts": [{"url": "...", "authority": "other", "value": "2026-10-12"}]
--     }
--   }
--
-- WHY ON THE ROW AND NOT ONLY IN THE EXTRACTION. The extraction is a proposal
-- and is superseded; the row is what a student reads. A value that came from
-- somewhere other than the funder has to carry that fact all the way to the
-- card, or "labelled" means labelled in a table nobody opens.
ALTER TABLE scholarships
    ADD COLUMN IF NOT EXISTS field_sources JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN scholarships.field_sources IS
    'Per-field provenance: which source established the value, who agreed, who disagreed. Absent key = never cross-verified, which is different from "one source agreed". See migration 011.';

-- ---------------------------------------------------------------------------
-- 3. Carry provenance through review
-- ---------------------------------------------------------------------------
-- Merged key-wise, like coverage_matrix and eligibility_flags and for the same
-- reason: an extraction that verified the deadline must not erase what a
-- previous one established about the stipend.
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

        eligibility_flags = CASE
            WHEN jsonb_typeof(ext.proposed -> 'eligibility_flags') = 'object'
            THEN COALESCE(eligibility_flags, '{}'::jsonb) || (ext.proposed -> 'eligibility_flags')
            ELSE eligibility_flags
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
    'Promotes a reviewed extraction onto its scholarship row. Object columns merge key-wise; array columns are replaced only when the proposal is non-empty. Lands at ai_extracted, never verified.';

-- ---------------------------------------------------------------------------
-- 4. What a reviewer needs to see first
-- ---------------------------------------------------------------------------
-- Rows whose fields rest on something other than the funder's own site, or
-- whose sources disagree. These are the rows where a human's judgement is
-- worth more than anywhere else in the queue.
CREATE OR REPLACE VIEW scholarship_provenance AS
SELECT
    s.id,
    s.title,
    s.country,
    field.key   AS field_name,
    field.value ->> 'authority'  AS authority,
    field.value ->> 'source_url' AS source_url,
    COALESCE(jsonb_array_length(field.value -> 'corroborated_by'), 0) AS agreeing_sources,
    COALESCE(jsonb_array_length(field.value -> 'conflicts'), 0)       AS conflicting_sources
FROM scholarships s
CROSS JOIN LATERAL jsonb_each(s.field_sources) AS field(key, value)
WHERE field.value ->> 'authority' IS DISTINCT FROM 'funder'
   OR COALESCE(jsonb_array_length(field.value -> 'conflicts'), 0) > 0
ORDER BY conflicting_sources DESC, s.title;

COMMENT ON VIEW scholarship_provenance IS
    'Fields not established by the funder''s own site, or where sources disagree. The queue for a human to arbitrate.';
