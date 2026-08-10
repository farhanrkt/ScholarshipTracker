# Data model

Canonical definitions live in `supabase/schema.sql` plus the numbered migrations;
the TypeScript mirror is `src/lib/types/database.ts`. This page explains what the
shapes mean and which invariants matter.

## Tables

| Table | Holds |
| --- | --- |
| `scholarships` | The live programme rows the app renders. |
| `user_targets` | One row per user per tracked scholarship, with checklist progress. |
| `scholarship_extractions` | Staged model proposals awaiting human review. Deny-all. |
| `scholarship_candidates` | Programmes discovery found that have no row yet. |
| `admins` | Email allowlist for the review pages. |

## Views and functions

| Object | Purpose |
| --- | --- |
| `scholarships_needing_review` | Worklist: unverified, stale, or past deadline, with the reason and the URL to check. |
| `extraction_review` | Pending proposals with their evidence and per-section counts. |
| `apply_extraction(uuid)` | Promotes a proposal onto its row. Lands at `ai_extracted`. |
| `reject_extraction(uuid, text)` | Marks a proposal rejected with a note. |
| `promote_candidate(uuid)` | Creates a dateless `unverified` skeleton from a candidate. |
| `reject_candidate(uuid, text)` | Marks a candidate rejected. |
| `is_admin()` / `why_not_admin()` | Allowlist check, and a diagnosis when it fails. |

`apply_extraction` and friends are `SECURITY INVOKER`, so RLS still applies — a
browser client cannot promote anything even if it learned an id.

## Trust tiers

`scholarships.verification_status` is the spine of the product.

| Value | Means | Set by |
| --- | --- | --- |
| `unverified` | Nobody and nothing has checked this row. | Seed data, `promote_candidate()` |
| `ai_extracted` | A model read it off the official page and **every value is backed by a verbatim quote found on that page**. No human has opened the portal. | `apply_extraction()` |
| `verified` | A person read the official page. | A human, deliberately |

Two consequences that are easy to break by accident:

- **Extraction never touches a `verified` row.** `scripts/extract/run.ts` filters
  them out. If you want a verified row re-crawled, set it back to `unverified`
  first.
- **`ai_extracted` is not a synonym for correct.** The UI says so on the card and
  in the detail sheet. Do not collapse the two tiers to simplify a query.

## Provenance

- `last_verified_at` has **no `DEFAULT NOW()`**. A row nobody has checked reads
  NULL and the UI says "Not verified" out loud. Defaulting it would make every
  row claim it was checked the day it was created.
- `source_url` holds the specific page the dates were read from — the timeline
  page, not the homepage — because that is the page the next person needs to
  open. Grounding derives it from *which page contained the quote*, so it is not
  simply the URL the crawl started at.
- **Staleness is derived, never stored.** A stored flag goes wrong the moment
  nobody updates it. `describeVerification()` computes it from the verification
  date and the deadline: past its deadline means the cycle has rolled over; more
  than 90 days unchecked means "may be out of date".

## JSONB shapes

All four are typed in `src/lib/types/database.ts`. Postgres does not enforce
them, so read [architecture.md § Defensive rendering](architecture.md#defensive-rendering)
before you consume one.

### `coverage_matrix`

`Partial<Record<CoverageKey, { covered: boolean; detail?: string | null }>>`

Keys: `tuition`, `monthly_stipend`, `airfare`, `accommodation`,
`health_insurance`, `settling_in_allowance`, `research_grant`, `visa_fees`.

**Partial on purpose.** A missing key renders as "Not stated by the programme",
which is a different claim from `covered: false` ("Not covered"). The
distinction matters when you are budgeting a year abroad, so the extraction
prompt tells the model to omit a line rather than guess at it.

`detail` carries the figure as published — `"JPY 143,000 per month"` — never
converted, never rounded.

### `eligibility_flags`

Fields: `max_age`, `min_gpa_4_scale`, `min_work_experience_years`,
`language_test_required`, `accepted_language_tests`, `min_toefl_ibt`,
`min_ielts`, `requires_university_admission_first`,
`requires_government_nomination`, `requires_research_proposal`,
`restricted_to_nationalities`, `notes`.

**Three states per key, not two** (migration 013):

| Shape | Means |
| --- | --- |
| key absent | nobody asked this question of this programme |
| key present, `null` | the pages were read and state nothing |
| key present, value | the pages state this |

The middle state is what makes the column useful and it is the easy one to
lose. In PostgREST, **`->>` collapses it into the first and `->` keeps them
apart** — so any query that must not answer "unknown" as "no" has to use `->`.

Two filters were written against `->>` and did exactly that. "No work
experience required" matched `min_work_experience_years IS NULL`, which is the
absence of an answer rather than an answer: it returned 23 of 37 rows, all of
them unread, offered to a student as "open to applicants straight out of
university" on no evidence — while *excluding* A\*STAR, the one row whose pages
say none is needed, because a stated `0` is not null. Wrong in both directions
from one missing distinction. The detail panel had the same bug in prose,
printing "No age cap" and "Open to all nationalities" for rows nothing had read.

Extraction records the middle state through `proposed.eligibility_silent`: a
list of the questions the model answered with an explicit "the pages do not
say". A claim that *failed grounding* is deliberately not on that list — we
asked, something came back, and it was not usable, which leaves the question
unanswered rather than answered "no". `apply_extraction()` merges those markers
at the **lowest** priority, so a "not stated" from today can never overwrite a
figure an earlier reading found.

Remaining nullability rules:

- `min_work_experience_years: 0` — the pages say none is required.
- `restricted_to_nationalities: null` or `[]` — open to all.
- Booleans are `boolean | null` in a proposal. An extraction only writes the keys
  the pages actually stated, so a row's flags object is usually partial.

### `document_checklist`

`Array<{ key, label, required, notes? }>`

`key` is a slug and is **the id written into `user_targets.checklist_progress`**.
Changing a document's key orphans every user's tick for it. `apply_extraction()`
replaces the array wholesale when a proposal is non-empty, which is exactly when
that can happen — one more reason a human approves it first.

### `timeline`

`Array<{ key, label, date: string | null, note?: string | null }>`

A stage with a `null` date is shown, not hidden: knowing that "Interviews take
place" exists as a stage is useful before its date is announced. Chevening
publishes nine stages, only three of which carry exact dates.

An undated stage also carries **rescued month-precision dates**. When a page
says "applications open again in September 2026", grounding refuses to invent
2026-09-01 — but rather than discard the fact, it becomes an undated stage whose
note quotes the page. `GroundedExtraction.hasMonthOnlyDate` flags this, because
`isEmpty()` would otherwise read the result as "no dates found" and bin the
whole extraction.

## Scope of the award (migration 010)

Three plain columns rather than JSONB, because each is a single value:

| Column | Type | Meaning |
| --- | --- | --- |
| `fields_of_study` | `TEXT[]` | Subjects the award is **restricted to**. Empty means open to any subject — never "unknown". |
| `award_duration` | `TEXT` | How long funding lasts, as published: `"up to 3 years"`. |
| `number_of_awards` | `TEXT` | How many are offered, as published: `"approximately 1,500 annually"`. |

**Text, not numbers,** for the last two. Pages write "up to three years, or four
where the programme requires it"; forcing that into an integer means choosing a
number the page did not state. They are grounded like a stipend figure — every
digit in the value must appear in the quote backing it.

`fields_of_study` is only ever **added to** by extraction, never cleared. The
model returns `[]` both for "open to every subject" and for "these pages did not
discuss it", and the column cannot tell those apart, so an empty proposal is
treated as the second.

## How a proposal merges into a row

`apply_extraction()` (migration 007) is deliberately asymmetric:

| Column kind | Behaviour | Why |
| --- | --- | --- |
| Scalars (`cycle_label`, dates, `post_study_obligations`) | `COALESCE(proposed, existing)` | Silence must not overwrite knowledge. |
| Objects (`coverage_matrix`, `eligibility_flags`) | `existing \|\| proposed` — key-wise merge | An extraction that learned the stipend must not erase the tuition line a previous one established. |
| Arrays (`timeline`, `document_checklist`) | Replaced **only when the proposal is non-empty** | A timeline is an ordered whole; merging two is meaningless. |

The array rule fixes a real bug: the original used
`COALESCE(proposed -> 'timeline', timeline)`, and an empty JSON array is not SQL
NULL — so an extraction that found no timeline silently wiped one already there.

## Migrations

Run in order from the Supabase SQL editor. `000_apply_all_pending.sql` is a
convenience bundle of 002–004 for a fresh project; **it predates 005–007 and
still contains the dates-only `apply_extraction()`**, so run those three after it
or you will reinstall a function that discards coverage, eligibility and
document proposals.

| File | Adds |
| --- | --- |
| `schema.sql` | Tables, indexes, trigger, RLS policies |
| `001_application_window_and_provenance.sql` | Opens/closes dates, cycle label, provenance columns |
| `002_ai_extraction.sql` | Extraction staging, the `ai_extracted` tier |
| `003_admin_review.sql` | Admin allowlist and review policies |
| `004_discovery.sql` | Discovery staging |
| `005_fix_admin_lookup.sql` | Admin lookup fix |
| `006_extraction_caveats.sql` | `caveats` — values kept but qualified by the page |
| `007_deep_extraction.sql` | Applies coverage, eligibility and documents, not just dates |
| `008_normalise_countries.sql` | Folds `United Kingdom`→`UK` etc; adds `possible_duplicate_scholarships` |
| `009_is_profiled.sql` | `is_profiled` generated column — required by the "No bond" filter |
| `010_award_scope.sql` | `fields_of_study`, `award_duration`, `number_of_awards`; carries them through `apply_extraction()` |
| `011_cross_verification.sql` | `scholarship_sources`, `scholarships.field_sources`, the `scholarship_provenance` view |
| `012_pipeline_jobs.sql` | `pipeline_jobs`, `pipeline_job_lines`, `claim_pipeline_tick()` — the pipeline as rows rather than a process |
| `013_answered_eligibility.sql` | Three-valued `eligibility_flags`; `apply_extraction()` merges silence markers at the lowest priority |
| `014_merge_duplicates.sql` | `merge_scholarships()` — folds a duplicate row into the one being kept, carrying trackers, sources and history |
| `015_multi_country_and_stale_dates.sql` | Repairs the `Unknown` country row and clears cycle dates read off archived pages |

**011 and 013 each replace `apply_extraction()`**, and each is a superset of the
one before, so applying them in order is correct and applying an earlier one
afterwards would regress. Run them in order.

**014 is the only `SECURITY DEFINER` function in the schema.** It has to be:
`user_targets` is owner-only under RLS, so no admin session can re-point someone
else's saved programme, and `scholarships` has no DELETE policy at all. The
`is_admin()` check as the function's first statement is what replaces those
policies — if you edit that function, that line stays at the top.

Until 011 is applied, `--verify` prints why it is doing nothing and the run
continues normally; discovery warns once per run that it cannot record second
sources; and the UI reads absent provenance as "not checked" and stays silent.

**010 must be applied for the new fields to survive review.** Until it is, the
pipeline still extracts and grounds them — they are written into the staging
table's JSONB `proposed` — but `apply_extraction()` has no columns to copy them
into, so they never reach a row. The app degrades quietly rather than breaking:
`select("*")` simply returns rows without those keys, and the rendering guards
in `src/lib/format.ts` treat them as "not stated".
