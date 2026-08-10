-- ScholarTrack :: migration 015
-- Two rows that were lying quietly, and the reasons they could.
--
-- Both are data repairs for bugs whose CODE fixes ship alongside this file.
-- Neither is something a re-run of the pipeline would have corrected on its
-- own, which is the only reason a migration is touching row data at all.

-- ---------------------------------------------------------------------------
-- 1. A country that no filter could select
-- ---------------------------------------------------------------------------
-- `scholarships.country` is free text in Postgres and a closed union in the UI,
-- and the filter sidebar builds its facets from the DISTINCT stored values. The
-- Rotary Peace Fellowship — one programme, partner universities on four
-- continents — was stored as 'Unknown'. That rendered as a chip, highlighted
-- when clicked, put a parameter in the URL, and filtered nothing, because
-- `parseFilters` drops any value outside the union. A control that looks active
-- and does nothing is worse than no control.
--
-- 'Multiple' is now IN that union, so the row is reachable. The code-side fixes
-- are `normaliseCountry` (so a classifier answering "Various" cannot reintroduce
-- this) and `fetchScholarshipCountries` (so a facet that cannot filter is never
-- offered again, whatever ends up in the column).
--
-- Only the answers that are not countries are folded. A row stored as 'Germany'
-- is left exactly as it is: silently relabelling a real country would be a
-- worse bug than the one being fixed, and migration 008 made the same call.
UPDATE scholarships
SET country = 'Multiple'
WHERE lower(trim(country)) IN (
    'unknown', 'unspecified', 'various', 'worldwide', 'global',
    'international', 'multiple countries', 'several countries',
    'not specified', 'n/a', ''
);

-- ---------------------------------------------------------------------------
-- 2. Deadlines from a cycle that ended years ago
-- ---------------------------------------------------------------------------
-- The Richard Rockefeller Fellowship row carried `deadline_date 2019-12-09`,
-- grounded, quoted, and stamped `last_verified_at` in 2026 — read off a page
-- the funder left up and never took down. Grounding cannot catch that and never
-- could: the quote is real, the date is real, the page is real. It is simply
-- seven years old, and it reached a student as the date to plan around.
--
-- A scholarship cycle repeats annually, so a date more than a cycle before the
-- reading that produced it cannot be that cycle's date. `ground.ts` now refuses
-- them at extraction time. It cannot repair what is already stored, because
-- `apply_extraction` fills nulls and never clears values — so the bad date
-- would survive every future run.
--
-- Clearing rather than correcting: we do not know what the current cycle's date
-- is, and a null renders as "not announced", which is true. The row keeps its
-- timeline and its stage names.
UPDATE scholarships
SET deadline_date = NULL
WHERE deadline_date IS NOT NULL
  AND deadline_date < COALESCE(last_verified_at::DATE, CURRENT_DATE) - INTERVAL '365 days';

UPDATE scholarships
SET opens_date = NULL
WHERE opens_date IS NOT NULL
  AND opens_date < COALESCE(last_verified_at::DATE, CURRENT_DATE) - INTERVAL '365 days';

-- A stage keeps its name and loses its date, exactly as grounding now does it:
-- "there is an interview round" survives being unable to say when.
UPDATE scholarships
SET timeline = (
    SELECT COALESCE(jsonb_agg(
        CASE
            WHEN stage ->> 'date' IS NOT NULL
             AND (stage ->> 'date')::DATE
                 < COALESCE(last_verified_at::DATE, CURRENT_DATE) - INTERVAL '365 days'
            THEN jsonb_set(stage, '{date}', 'null'::jsonb)
            ELSE stage
        END
    ), '[]'::jsonb)
    FROM jsonb_array_elements(timeline) AS stage
)
WHERE jsonb_typeof(timeline) = 'array'
  AND jsonb_array_length(timeline) > 0
  AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(timeline) AS stage
      WHERE stage ->> 'date' IS NOT NULL
        AND (stage ->> 'date')::DATE
            < COALESCE(last_verified_at::DATE, CURRENT_DATE) - INTERVAL '365 days'
  );

-- What is left to look at by hand:
--   select title, country from scholarships
--    where country not in ('USA','UK','China','Japan','South Korea','Singapore','Multiple');
