# Operations

Day-to-day running of the app and its pipeline.

## The loop

```
1. discover   find programmes with no row              → /admin/candidates
2. promote    create a dateless skeleton               (human)
3. extract    crawl it, read dates + profile           → /admin/review
4. apply      merge the proposal onto the row          (human)
5. verify     open the portal, confirm, mark verified  → /admin/verify
```

Steps 2, 4 and 5 are human by design. Nothing a model produces reaches a student
without someone approving it.

## Running the crawlers

### From the browser

`/admin/pipeline` runs either crawler with a button and shows its log as it goes.
Admin-gated, and linked in the header only for admins. **It works on the
deployed site**, not only locally — see
[deployment.md](deployment.md#how-a-run-survives-a-serverless-host) for how.

What that means in practice:

- **Progress is saved as it goes.** Close the tab, come back, and the console
  re-attaches to the run and carries on. Nothing is lost but the unit that was
  in flight.
- **Stop is safe.** It stops the run before the next unit; whatever was already
  staged stays staged and reviewable.
- **One run at a time**, enforced by a unique index rather than by a variable in
  one server process — concurrent crawls double the request rate at the same
  funders and race through one free-tier quota.

The log is the feature. These runs take minutes and spend a rate-limited quota; a
spinner cannot tell you a slow crawl from a stuck one, while the crawlers already
print pages fetched per topic, what grounding discarded, and why.

Every option is parsed against a whitelist before it reaches a crawler — numbers
clamped, toggles matched with `=== true`, free-text filters pattern-checked.
Dry run is the default, so a malformed request writes nothing rather than
everything.

**Needs migration 012.** Without it the console says which file to apply and
does nothing else; the terminal path is unaffected.

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

## Verifying a row — `/admin/verify`

`verified` is the one status no crawler may write. It means a person opened the
programme's own page and confirmed what the row says, so it has to come from a
person, and this is where.

The page is three queues:

| Tab | What is in it |
| --- | --- |
| **AI-extracted** | A model has read these and quoted the page for every value. Start here — confirming one costs a glance at the portal. |
| **Never checked** | Promoted from discovery and never crawled. These have no dates to check yet; run extraction first. |
| **Verified** | Already confirmed. Open it to send one back when a cycle rolls over. |

Each card shows the dates, the **quote behind each one**, and a link to the page
that quote came from. The job is to open the portal, check the two or three
dates against it, and press **Mark verified** — which stamps the row with
today's date.

**Send one back** with *Needs another look*. A row an extraction has read
returns to `ai_extracted` (its quotes are still real); one nothing has read
returns to `unverified`, and its verification date is cleared with it.

Nothing here needs SQL. If you prefer it anyway:

```sql
update scholarships
set verification_status = 'verified', last_verified_at = now()
where id = '<uuid>';
```

**Extraction skips `verified` rows.** When a cycle rolls over, send the row back
from the Verified tab first — that is what puts it back in the crawler's queue.

Staleness is never stored: a verified row starts reading as "may be out of date"
90 days later, and as "cycle has rolled over" the moment its deadline passes.
Neither needs undoing by hand.

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
