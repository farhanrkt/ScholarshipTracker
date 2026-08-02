-- ScholarTrack :: migration 006
-- Caveats: values that were KEPT but need a human eye.
--
-- WHY THIS EXISTS. Grounding proves a quote is on the page. It does not prove
-- the quote supports the value derived from it, and two real cases from the
-- first live run showed the gap:
--
--   Gates Cambridge, opens_date
--     page:  "Applications will open again in September 2026"
--     value: 2026-09-01          <- the day was invented
--
--   Gates Cambridge, deadline_date
--     page:  "either Tuesday 8th December 2026 or Wednesday 6th January 2027
--             (see Course Directory)"
--     value: 2026-12-08          <- one branch of a conditional, condition lost
--
-- The first is now discarded outright: a date whose day, month or year is not
-- traceable to its quote is a month, not a date, and there is no month field.
-- The second is kept — both dates are genuine — but recorded here so the
-- reviewer is told the page qualifies it rather than having to notice.

ALTER TABLE scholarship_extractions
    ADD COLUMN IF NOT EXISTS caveats TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN scholarship_extractions.caveats IS
    'Values kept but qualified by the page (e.g. course-dependent deadlines). Distinct from ungrounded_fields, which were discarded.';

-- Surface them in the review queue alongside the discards.
--
-- DROP first, not CREATE OR REPLACE: replacing a view can only append columns
-- at the end, never insert one mid-list, and `caveats` belongs next to
-- `ungrounded_fields` where a reader will actually see the pair together.
DROP VIEW IF EXISTS extraction_review;
CREATE VIEW extraction_review AS
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
    e.caveats,
    e.page_subject,
    e.model_notes,
    e.source_url,
    e.fetched_at
FROM scholarship_extractions e
JOIN scholarships s ON s.id = e.scholarship_id
WHERE e.status = 'pending'
ORDER BY e.created_at DESC;
