-- ScholarTrack :: migration 008
-- One spelling per country.
--
-- WHY THIS EXISTS. `scholarships.country` is free text in the database but a
-- six-value union in the UI, and the filter sidebar builds its facets from the
-- DISTINCT stored values. Discovery's classifier answers with whatever the page
-- calls the country, so "United Kingdom" and "United States" arrived alongside
-- "UK" and "USA" — and the sidebar grew eight country facets for six countries.
-- Worse, a row filed under "United Kingdom" is invisible to anyone filtering on
-- "UK": it exists, it renders, and it can never be found.
--
-- Discovery normalises on write now (scripts/discover/candidates.ts). This
-- fixes the rows created before that.
--
-- Only the six target countries are folded. Anything else is left exactly as
-- stored — silently relabelling a German programme would be a worse bug than
-- the one being fixed.

UPDATE scholarships
SET country = CASE lower(trim(country))
    WHEN 'united kingdom'            THEN 'UK'
    WHEN 'great britain'             THEN 'UK'
    WHEN 'britain'                   THEN 'UK'
    WHEN 'england'                   THEN 'UK'
    WHEN 'scotland'                  THEN 'UK'
    WHEN 'wales'                     THEN 'UK'
    WHEN 'northern ireland'          THEN 'UK'
    WHEN 'united states'             THEN 'USA'
    WHEN 'united states of america'  THEN 'USA'
    WHEN 'us'                        THEN 'USA'
    WHEN 'u.s.'                      THEN 'USA'
    WHEN 'u.s.a.'                    THEN 'USA'
    WHEN 'america'                   THEN 'USA'
    WHEN 'republic of korea'         THEN 'South Korea'
    WHEN 'korea'                     THEN 'South Korea'
    WHEN 'korea, south'              THEN 'South Korea'
    WHEN 's. korea'                  THEN 'South Korea'
    WHEN 'people''s republic of china' THEN 'China'
    WHEN 'peoples republic of china' THEN 'China'
    WHEN 'prc'                       THEN 'China'
    WHEN 'mainland china'            THEN 'China'
    WHEN 'republic of singapore'     THEN 'Singapore'
    ELSE country
END
WHERE lower(trim(country)) IN (
    'united kingdom', 'great britain', 'britain', 'england', 'scotland',
    'wales', 'northern ireland',
    'united states', 'united states of america', 'us', 'u.s.', 'u.s.a.', 'america',
    'republic of korea', 'korea', 'korea, south', 's. korea',
    'people''s republic of china', 'peoples republic of china', 'prc', 'mainland china',
    'republic of singapore'
);

-- ---------------------------------------------------------------------------
-- Find the near-duplicate rows this tends to come with
-- ---------------------------------------------------------------------------
-- NOT a merge. Deduplication is a judgement — "Chevening Fellowships" and
-- "Chevening Scholarships" are different programmes that a fuzzy match would
-- happily fuse — so this only surfaces the pairs for a human to look at.
--
--   select * from possible_duplicate_scholarships;
--
-- The comparison strips punctuation and trailing plurals, which is what catches
-- "Chevening Scholarship" against "Chevening Scholarships".
CREATE OR REPLACE VIEW possible_duplicate_scholarships AS
WITH normalised AS (
    SELECT
        id,
        title,
        country,
        verification_status,
        source_url,
        created_at,
        regexp_replace(
            regexp_replace(lower(title), '[^a-z0-9 ]+', ' ', 'g'),
            's\b', '', 'g'
        ) AS fingerprint
    FROM scholarships
)
SELECT
    a.id            AS keep_candidate_id,
    a.title         AS keep_candidate,
    b.id            AS duplicate_id,
    b.title         AS duplicate,
    a.country,
    a.verification_status AS keep_status,
    b.verification_status AS duplicate_status,
    b.source_url    AS duplicate_source
FROM normalised a
JOIN normalised b
  ON a.fingerprint = b.fingerprint
 AND a.id < b.id
ORDER BY a.title;

COMMENT ON VIEW possible_duplicate_scholarships IS
    'Rows whose titles match once punctuation and plurals are stripped. Review by hand — merging is a judgement, not a rule.';
