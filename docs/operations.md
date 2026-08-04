# Operations

Day-to-day running of the app and its pipeline.

## The loop

```
1. discover   find programmes with no row              → /admin/candidates
2. promote    create a dateless skeleton               (human)
3. extract    crawl it, read dates + profile           → /admin/review
4. apply      merge the proposal onto the row          (human)
5. verify     open the portal, confirm, mark verified  (human)
```

Steps 2, 4 and 5 are human by design. Nothing a model produces reaches a student
without someone approving it.

## Running the crawlers

### From the browser

`/admin/pipeline` runs either crawler with a button and streams its output to the
page. Admin-gated, and linked in the header only for admins.

It spawns the same scripts on the machine serving the page, which means **local
development**. A deployed serverless instance has neither the repo nor
`.env.local` on disk, so the runner returns a clear refusal there instead of
failing halfway through a crawl.

The log is the feature. These runs take minutes and spend a rate-limited quota; a
spinner cannot tell you a slow crawl from a stuck one, while the scripts already
print pages fetched per topic, what grounding discarded, and why.

Two constraints: **one run at a time process-wide** (concurrent crawls fight over
the same per-minute quota), and the argument list is built from a fixed
whitelist — script chosen from a map, flags as literals, free-text filters
pattern-matched before they go anywhere near `spawn`, which is called without a
shell. An admin session should not be a way to run commands on your laptop.

### From a terminal

```bash
npm run extract -- --dry-run --title Chevening
```

Always dry-run first on a programme you know. Then drop the flag to stage it.

```bash
npm run discover -- --dry-run --seed Commonwealth --per-seed 5
```

Full flag reference in [pipeline.md § Tuning reference](pipeline.md#tuning-reference).

## Reviewing

### Candidates — `/admin/candidates`

Discovery's output. Promote creates a dateless `unverified` skeleton;
extraction fills it in afterwards. Reject with a note if it is not a programme,
is out of scope, or duplicates a row you already have.

Watch for near-duplicates of existing rows — dedupe is exact-match on a
normalised title, so `Chevening Scholarship` and `Chevening Scholarships` both
get through. See [troubleshooting.md](troubleshooting.md#near-duplicate-rows).

### Extractions — `/admin/review`

Each card shows the current value, the proposed value, and **the quote backing
it**, with a link to the page the quote was found on. Read the quote. That is the
entire point of it being there.

Also on the card:

- **Discarded by the grounding check** — what the model claimed and the pipeline
  threw away. A long list here usually means the crawl reached the wrong pages,
  not that the model is broken.
- **Kept, but the page qualifies it** — `caveats`. The value is real and the page
  attaches a condition the schema cannot express, e.g. a deadline that differs by
  course. Look before applying.
- Collapsed counts of proposed coverage lines, eligibility fields and documents.

Applying lands the row at **`ai_extracted`**, not `verified`.

From SQL, if you prefer:

```sql
select * from extraction_review;
```

```sql
select apply_extraction('<extraction_id>');
```

```sql
select reject_extraction('<extraction_id>', 'wrong cycle');
```

## Verifying a row

The only way a row becomes `verified`:

1. Open its official page — `source_url`, not the homepage.
2. Read the real dates.
3. Fill in `opens_date`, `deadline_date`, `cycle_label`, `timeline`,
   `source_url`, `last_verified_at`.
4. Set `verification_status = 'verified'`.

The Chevening block at the bottom of `supabase/seed.sql` is the worked example.

**Extraction skips `verified` rows.** If you want one re-crawled — a new cycle,
say — set it back to `unverified` first.

## The worklist

```sql
select * from scholarships_needing_review;
```

Everything unverified, stale, or past its deadline, with the URL to check and the
reason it surfaced. Staleness is computed, not stored, so this query is always
current.

## Curating seeds

The seed list decides what the database can ever contain. Before adding one:

```bash
npm run discover:verify -- https://example.org/scholarships/
```

It reports text length, link counts, programme-shaped links, and any pagination
it found — using the crawler's own scorer, so the number is what the crawler will
actually see. Under five programme-shaped links is not worth a slot.

To re-check the whole list after a run reports a seed as unreachable:

```bash
npm run discover:verify
```

Record failures in `BLOCKED_SEEDS` with the reason rather than deleting them
quietly, so nobody re-adds a known-bad URL six months later.

## Keeping data fresh

Cycles roll over annually. A reasonable rhythm:

- **Monthly** — `npm run discover` for new programmes; review candidates.
- **When a deadline passes** — the worklist surfaces the row; re-extract and
  re-verify for the new cycle.
- **Quarterly** — `npm run discover:verify` to catch seeds that have moved or
  started blocking.

Running the crawlers locally writes to whatever Supabase project `.env.local`
points at. If that is production, a bad run is visible to real users as soon as
you apply it — `--dry-run` and the review step are what stand between the two.
