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

Once rows exist, the loop has a second half that is about depth rather than
count: `/admin/coverage` ranks what is still blank by whether the pipeline could
have filled it, and `--verify` fills from other sites what a funder never
published. See [Chasing blanks](#chasing-blanks--admincoverage).

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

### Duplicates — `/admin/duplicates`

Rows that look like the same programme twice. Discovery dedupes on an exact
normalised title, which is how the catalogue came to hold `Chevening
Scholarship` beside `Chevening Scholarships`, three Humphrey rows and three MEXT
rows — a student scrolling the dashboard meets the same award repeatedly and
cannot tell which entry to track.

**These are suggestions from a string comparison, not findings.** Nothing here
can tell a genuinely separate award from a longer way of writing the same name:
`Distinguished Humphrey Fellowship Program` is a different programme, and
`Chevening Scholarships in Australia` might be. Open both pages before folding
one into the other, and leave the group alone if they differ. The one thing the
comparison does know is that a **fellowship is not a scholarship** — a funder
running both runs two programmes, and that check happens before any other.

Merging picks a survivor and folds the rest in one at a time. It ends in a
DELETE, so everything worth keeping moves first: people tracking the duplicate
(with their statuses and ticked checklists combined), second sources, extraction
history, and any field the survivor is missing. The duplicate's own URL is kept
as a second source, because it is a real page describing this programme.

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

## Chasing blanks — `/admin/coverage`

The other worklist, and the one to use when the question is "why is this row so
empty". It ranks the catalogue by **recoverable** blanks — fields the last
reading blamed on the pipeline rather than on the funder — and expands to a
per-field diagnosis.

The ranking matters more than it looks. A row with 6/25 filled whose every blank
is `not-published` is **finished**: the funder does not publish the rest, and no
amount of crawling will change that. A row with 18/25 filled and four
`never-crawled` has real work in it. Sorting by emptiness alone puts the finished
row at the top and sends you to re-run the one case that cannot improve.

So `recoverable` is the number to watch, and the only honest measure of progress
here — it is what should fall between runs.

| Cause | What to do |
| --- | --- |
| `never-crawled` | Re-run with `--pages` raised, or check `--no-gap-crawl` is not set. If it persists the link scorer never saw the page — look at what the site calls it. |
| `not-retrieved` | The words are in the crawl and never reached a prompt. Usually a missing phrase in `SPECS` in `scripts/extract/gaps.ts`. |
| `model-silent` | Re-run with `--escalate`. If a strong model is also silent, the passage probably does not say what the phrase match suggested. |
| `grounding-rejected` | Nothing. A value that could not be quoted was a guess and was correctly dropped. |
| `not-published` | Nothing. The funder does not state it, and the card now says so. |

The same query outside the UI:

```sql
select title, filled, total, recoverable, not_stated_count
  from scholarship_completeness
 order by recoverable desc, filled asc
 limit 20;
```

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

Cycles roll over annually, and until recently nothing noticed: six of the
sixteen deadlines in the catalogue had already passed, and a row read in March
whose deadline expired in May kept offering that date until somebody happened to
re-run the crawler over it.

**The weekly refresh does that noticing.** `vercel.json` calls
`/api/cron/refresh` every Monday at 06:00 UTC. It plans an extract run over the
rows that have gone out of date and ticks it to completion — and it **stages**
proposals like any other run, so `/admin/review` is still where anything reaches
a row. Set `CRON_SECRET` or the endpoint refuses every request.

What counts as stale, and why the two rules differ:

- **A cycle has turned** — the deadline is in the past. This includes rows a
  human verified: a verification confirms a *date*, and a date that has passed
  has outlived its confirmation.
- **A reading has aged** — nothing has looked in 90 days, or ever. Verified rows
  are excluded here, because a human's check does not expire on a timer, only
  when the thing it checked does.

`Stale rows only` in the pipeline console runs the same selection by hand.

Alongside it:

- **Monthly** — `npm run discover` for new programmes; review candidates, then
  check `/admin/duplicates` for rows that are one programme twice.
- **Quarterly** — `npm run discover:verify` to catch seeds that have moved or
  started blocking.

Running the crawlers locally writes to whatever Supabase project `.env.local`
points at. If that is production, a bad run is visible to real users as soon as
you apply it — `--dry-run` and the review step are what stand between the two.
