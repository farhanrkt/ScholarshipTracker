# Which of the duplicate groups are actually one programme

**31 October 2026.** Finding H6 of `audit-2026-10-30.md` reported 5 groups covering
14 of 43 rows and said the rest "genuinely need a human". This is that human pass:
every one of the 14 pages read, every pair decided, with the funder's own words
against each verdict.

Reproduce the dossiers with:

```
node --env-file=.env.local scripts/audit/duplicate-dossiers.ts <outDir>
```

All 14 pages fetched cleanly on 31 October — nothing dead, nothing blocked by
robots.txt. Fetches went through `scripts/extract/page.ts`, so the declared UA
and the per-host delay applied.

## The short version, and a correction to H6

**Two rows are the same programme twice. Not nine.**

H6's headline — "a third of the catalogue is the same programme listed twice" —
counted rows that the detector *grouped*, and a group is not a verdict. Read
against the funder pages, 10 of the 12 pairs are separate awards. The catalogue
goes 43 → 41, not 43 → 34.

The overstatement came from reading `DuplicateCluster.confidence`, which is
documented as "the strongest pair in the cluster, for ordering the review
queue". The four-row Chevening scholarship group is labelled `certain` because
**one** pair in it is identical-but-for-a-plural; the other three rows are
different awards. That is the field doing its job and the audit misreading it.

The `likely` rule — *same site, and one title is the other plus a qualifier* —
was right once in six here. It is right about Humphrey and wrong about SIDS,
OCIS, LSE, FLAS and FLTA. That ratio is the argument for everything in this
document: the comparison is a good way to raise a question and a bad way to
answer one.

## Merge these two

Both at `/admin/duplicates`, keeping the row named first.

### 1 · `Chevening Scholarships` → `Chevening Scholarship`

| | keep | drop |
| --- | --- | --- |
| id | `5a1bb284-e148-4bef-bb0c-0084b5fbd5c4` | `e7bec666-4fab-4a1a-a3e0-1672c42bfb1b` |
| portal | `chevening.org/scholarships/` | `chevening.org/scholarships/who-can-apply/` |
| extractions | none on record | 5, applied, quoted |

The dropped row's page is a child of the kept row's page, and its own heading is
a question about the award rather than the name of one: "Who can apply for a
Chevening Scholarship?" The kept page describes the same thing — "Chevening
Scholarships enable outstanding emerging leaders from all over the world to
pursue one-year master's degrees in the UK."

Keep the `/scholarships/` row because that is the page a student should land on.
It is also the row with *no* extraction history, which sounds like the wrong
choice and is not: `merge_scholarships` moves `scholarship_extractions` to the
survivor, so the five quoted extractions follow it across and the row ends up
better evidenced than either input.

Worth noting that `preferKeep()` suggests this row for none of those reasons —
both rows score identically, so it fell through to `created_at`. It is right by
accident. It does not look at `official_portal_url`, which is the field that
actually decided this.

### 2 · `Humphrey Fellowship Program` → `Hubert H. Humphrey Fellowship Program`

| | keep | drop |
| --- | --- | --- |
| id | `722dc3cc-59a8-4ea4-a7f6-b9fbeb221339` | `bcd12663-b118-48ea-9e91-bfa5f3676f56` |
| portal | `humphreyfellowship.org/how-to-apply/eligibility/` | `humphreyfellowship.org/program-overview` |
| extractions | 5 | 3 |

One programme under its short and full names, which the funder's own history
section states: "The Humphrey Fellowship Program was founded in 1978 to honor
the late Senator and Vice President Hubert H. Humphrey." The site's navigation
carries both pages under one programme — *Program Overview* and *How To Apply →
Eligibility*.

Keep the full official name. The merge records `/program-overview` against the
survivor as a second source, so the better landing page is not lost — though
the survivor's `official_portal_url` stays pointed at the eligibility page,
which is a one-field fix rather than a merge.

No row in either group has a tracker on it (the whole catalogue has 2), so no
one's saved progress is involved.

## Leave these alone — the funder says they are different awards

### Chevening lists its scholarship awards itself

`chevening.org/scholarships/` names three, as separate items: "Standard
Chevening Scholarships", "Chevening SIDS Scholarships", "Chevening ASEAN
Scholarships".

- **`Chevening SIDS Scholarship`** — its own award with its own eligibility and
  its own benefits, for applicants "from a Commonwealth Small Island Developing
  State (SIDS)", who get "the additional opportunity to be considered for the
  Chevening SIDS Scholarship" on top of the standard benefits. Not a duplicate.
- **`Chevening Scholarships in Australia`** — not a separate award and not a
  duplicate either: a country page. It says "Closed for applications" and sends
  applicants elsewhere entirely — "Please apply directly via the Charlie Perkins
  website or the Roberta Sykes website." Folding it into the global award would
  attach that routing to the wrong programme. **Retire it instead** (see below).

### The Chevening fellowships are three different fellowships

- **`Chevening LSE Fellowship`** — the *Chevening LSE Global Impact Fellowship*,
  three or six months at LSE. Eligibility: "Be a citizen of China, currently
  live in the country, and intend to return to China at the end of the period of
  study." Closed for applications. Not a duplicate.
- **`Chevening Oxford Centre for Islamic Studies Fellowship`** — five months at
  OCIS, six places, its own two-round interview. Its eligibility list names
  "Afghanistan\*, Algeria, Azerbaijan, Bangladesh, Egypt, Indonesia, Iraq,
  Jordan …". **Indonesia is on it.** Not a duplicate — and the single most
  relevant row in the group for this catalogue's audience. A group-level merge
  on that green `certain`-style badge would have deleted it.
- **`Chevening Fellowships`** — the hub page for the family, and explicit that it
  is not the scholarship: "Fellowships have a different objective to our
  scholarship programme". Keep, with the caveat that nobody applies to "a
  Chevening Fellowship" in general.

### Humphrey has a second, separate programme

- **`Distinguished Humphrey Fellowship Program`** — "Launched in 2016 … This
  rigorous, short-term, invitation-only program", about 18 days, 15–20
  participants. A different award, exactly as `src/lib/duplicates.ts:12-14`
  predicted. Not a duplicate — and **invitation-only**, so nobody can apply to
  it.

### Harvard's own navigation separates these two

`Foreign Language & Area Studies Grants` and `Language Study Fellowships` sit
side by side as sibling items under *Summer Fellowships* on `gsas.harvard.edu`.
Two awards, not one.

### Fulbright names both on its front page

"Learn how to apply to the Fulbright Foreign Student and FLTA programs." Two
programmes, named together, on `foreign.fulbrightonline.org`.

## What else the 14 pages turned up

Not duplicates, so not merges — but they are why these rows looked alike, and
three of them are the kind of thing that costs someone an application.

| Row | What the page says | Suggested |
| --- | --- | --- |
| `Chevening Scholarships in Australia` | For Australians, closed, apply via Charlie Perkins / Roberta Sykes | **Retire** — Indonesia-first rule |
| `Chevening SIDS Scholarship` | Commonwealth SIDS only; Indonesia is in neither set | **Retire or scope-flag** |
| `Chevening LSE Fellowship` | China only | **Retire or scope-flag** |
| `Distinguished Humphrey Fellowship Program` | Invitation-only | **Retire** — not applicable-to |
| `Foreign Language and Area Studies Fellowships`, `Language Study Fellowships` | Harvard GSAS internal awards for its own doctoral students | **Retire or scope-flag** |
| `Fulbright Foreign Language Teaching Assistant Program` | Row points at `/host-institutions/flta-program/…`, the page for US colleges wanting to *host* an FLTA, not for applicants | **Re-point to the applicant page** |
| `Chevening LSE Fellowship` | Stored title is short of the real one, "Chevening LSE Global Impact Fellowship" | One-field fix |

So 6 of the 14 grouped rows are not open to an Indonesian applicant at all. The
duplicate groups turned out to be a good place to go looking for scope defects,
because a funder's near-identical page titles are usually near-identical
programmes split by *who may apply*.

**One lead, not a finding.** The hub page names "Chevening ASEAN Scholarships"
and the catalogue has no row for it. Indonesia is an ASEAN member, so this looks
like a coverage gap worth checking — but `chevening.org/scholarship/asean/` is a
404, so the real page has not been read and nothing here is verified beyond the
hub page naming the award.

## Deadlines: the suspicion that did not hold

All seven Chevening rows carry the same `deadline_date`, 2026-10-06, which looks
like one date copied across a family. It is not. Every one of them has an
applied extraction with a grounded quote, and the two fellowships quote their
own pages rather than the shared timeline:

- scholarships → `/scholarships/application-timeline/`: "6 October 2026
  Applications close at 11:00 UTC"
- OCIS → `/fellowship/ocis/`: "Open for applications until 6 October 2026, at
  11:00 (UTC)"
- LSE → `/fellowship/lse/`: "Open for applications until 6 October 2026, at
  11:00 (UTC)"

"No quote, no value" held here. The one real wrinkle is provenance rather than
accuracy: the Australia row takes its deadline from the global timeline page
while its own portal page says applications are closed and routes applicants to
two other funders.

Separately, `chevening.org/scholarship/indonesia/` now reads "Applications for
2027-2028 Chevening Scholarships are now closed", so the stored date is a closed
cycle and the row is correctly *past*, not wrong. Nothing has re-read it since
29 August — C1 again.

## What has not been done

**No production data changed.** Both merges are still to run, and I cannot run
them: `merge_scholarships` is `SECURITY DEFINER` with `is_admin()` as its first
statement, and `is_admin()` reads `auth.jwt() ->> 'email'`. The service-role key
carries no email claim, so the guard rejects it — and so would the Supabase SQL
editor. The function is reachable only from a signed-in admin browser session,
which is the same wall as C1.

That is the right design and worth saying plainly: the only way to delete a
scholarship row is for a logged-in reviewer to press a button, and no key in
`.env.local` can do it.

Two clicks at `/admin/duplicates`, in a session signed in as the admin:

1. keep `Chevening Scholarship` → fold `Chevening Scholarships` in
2. keep `Hubert H. Humphrey Fellowship Program` → fold `Humphrey Fellowship Program` in

Leave every other group alone. The retirements in the table above are a separate
decision and a separate pass.
