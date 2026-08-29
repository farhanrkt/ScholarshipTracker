# Troubleshooting

Symptoms first, since that is what you have when you arrive here.

## Auth

### "It says I'm signed in, but I'm not"

Fixed, but worth understanding because the failure mode is silent and the shape
recurs.

The session exchange used to run in a Server Component, where Next.js ignores
`cookies().set()`. The exchange succeeded, the cookies were discarded, the page
redirected with `?linked=ok`, and the proxy minted a fresh anonymous ghost. No
error was logged anywhere.

Now the exchange happens in `src/app/auth/callback/route.ts`, which re-reads the
session before claiming success, and no UI decides "signed in" from a URL — they
all ask `src/lib/supabase/account.ts`.

**If it recurs, check in this order:**

1. Is the origin in Supabase's redirect allowlist? See
   [deployment.md § 4](deployment.md#4-auth-redirect-urls--do-this-before-testing-sign-in).
   This is the most likely cause on a new domain.
2. Are third-party/all cookies blocked in the browser?
3. Did the link get opened in a different browser from the one that requested
   it? PKCE stores a verifier cookie in the requesting browser.
4. Is the link stale? They are single-use and expire.

The callback now redirects to `/auth/sign-in?error=invalid&reason=…` with
Supabase's own message. Read the reason.

### Email link says "invalid flow state, no valid flow state found"

The PKCE verifier cookie is missing — usually opening the link in a different
browser or profile. Request a fresh link from the same browser.

### Nothing works and every visitor is signed out

**Authentication → Sign In / Providers → Allow anonymous sign-ins** is off. That
toggle mints the ghost account the whole app assumes exists.

## Discovery

### A seed reports "unreachable"

Run `npm run discover:verify -- <url>` for the detail. Four failure modes recur,
all recorded in `BLOCKED_SEEDS` with examples:

| Symptom | Cause | What to do |
| --- | --- | --- |
| `HTTP 403` / `412` | Origin rejects non-browser clients | Find a different entry point; do not spoof a user-agent |
| `produced only N characters` | Page is JavaScript-rendered | Unfixable here — find a static equivalent |
| `HTTP 404` | The URL moved | Re-check; these move often |
| Fetches fine, few links | It is a single programme dressed as an index | Not worth a seed slot |

### A run finds very few candidates

Check the line `N listing page(s) → M candidate link(s)`. If `N` is 1, the seed
has no pagination the detector recognises; if `M` is low, the seed itself is
thin — verify it. Also check how many were `already known`: rediscovering rows
you have is success, not failure.

Then check the `found via sitemap` count in the summary. A seed whose site
publishes a sitemap should be contributing dozens to hundreds of URLs there —
Chevening's own sitemap lists 197 scholarship pages against 18 links on the seed
page. Zero means the site has no sitemap at any conventional path, or robots.txt
disallows it. `--no-sitemap` turns the harvest off entirely; check you have not
left it on.

### Near-duplicate rows

`Chevening Scholarship` vs `Chevening Scholarships`, two Fulbright rows, two MEXT
rows. Dedupe is exact-match on a normalised title, so one character of difference
creates a second row.

**Today:** catch them at `/admin/candidates` before promoting. Merge existing
duplicates by hand, keeping the row with the better provenance.

**If you want it fixed properly:** the right shape is a near-duplicate *warning*
on the candidate card, not automatic merging — `Chevening Fellowships` and
`Chevening Scholarships` are genuinely different programmes, and silently merging
real awards is worse than showing two rows.

### `UK` and `United Kingdom` both in the filter sidebar

Country names from the classifier are normalised now, but rows created before
that kept their original spelling. Fix the existing rows:

```sql
update scholarships set country = 'UK' where country = 'United Kingdom';
```

Repeat for `United States` → `USA`. Only the six target countries are
normalised; anything else passes through unchanged on purpose.

## Extraction

### "HTTP 404 fetching …" / "no reachable entry page"

The address in the row is wrong, not the programme. Extraction now says so and
acts on it: it looks for where the page moved to — slash and `www` variants
first, then the parent sections, then the site's own sitemap ranked by how well
each path matches the title — and re-points the row once an extraction confirms
the page it found really is that programme.

You see `↻ recovered via parent section /scholarships/` in the log, then
`↻ row re-pointed at …`. Nothing is written in a dry run, and `--no-fix-urls`
keeps the recovery while leaving the row alone.

If it still reports the row as unreachable, every guess failed too and the URL
needs finding by hand — the summary prints the status alongside each row, which
is what tells you whether the problem is the address or the host.

### "HTTP 403 fetching …"

We were refused, which is different from the page being gone — usually a WAF
scoring the request rather than the URL. The fetch layer already retries once
with browser-shaped headers and remembers the host, so a 403 that survives to
the log is a firm one.

This is **not** repaired: the address is probably right, and guessing more
addresses at a host that is turning us away just produces more refusals. If a
whole origin behaves this way, `CRAWL_USER_AGENT` lets you introduce yourself
differently, and a funder blocking crawlers deliberately is a row to maintain by
hand.

### "produced only N characters of text — likely JavaScript-rendered"

The page is a shell that fetches its content in the browser. There is nothing to
read and no header trick that fixes it; the fetch layer does not run JavaScript
by design. Point the row at a server-rendered page on the same site if one
exists — often the print view or a `/en/` variant — or maintain it by hand.

### "This model is currently experiencing high demand"

The provider is busy, not you. It is retried three times with a short backoff
(`· gemini-flash-lite-latest is busy, retrying in 5s`). If a whole run dies this
way, Google is having a bad hour: switch with `--provider groq`, or set a
different `GEMINI_MODEL` — free-tier capacity is granted per model.

### "no relevant passages found across the crawl"

The crawl reached pages with no date, eligibility, benefit or document language
at all. Usually the entry URL is a landing page that links onward via JavaScript.
Check `source_url` / `official_portal_url` points somewhere with real content.

### "wrong site — model saw: …"

The crawl landed on a redirect, a cookie wall, or a 404. The message says what
the model thought the page was about. Fix the row's URL.

### Everything is dropped by the grounding check

Read the discards — they name the value and why. Common patterns:

- *"quote not found on any fetched page"* — the model paraphrased, or invented.
  Working as intended.
- *"the quote does not state the day"* — the page gave a month, the model
  invented a day. Working as intended; there is no month field.
- Many boolean discards — the model answered `false` for things the page never
  addressed. The prompt now asks for `null` there, but weaker models still do it.
  Harmless: they are discarded.

A programme where *everything* is discarded usually means the crawl reached the
wrong pages, not that the model is broken. Try `--pages 24`.

### Only one or two coverage lines

Most likely the funder does not publish them anywhere the crawl reaches.
Chevening is the reference case: its eligibility, timeline and guidance pages
contain no tuition or stipend language at all, so one line is the honest answer.

To check rather than assume, run with `--dry-run` and read the crawl summary —
`[dates 4 · eligibility 4 · process 3]` with no `benefits` entry means no
benefits-shaped page was found to fetch.

### A row has a deadline and nothing else, and the run said it succeeded

Read the per-programme lines for `profile call ... — retrying on half the
passages` or `profile extraction failed`. The extraction is two calls, and only
the second reads coverage, eligibility and documents. When it fails the first
still succeeds, so the run reports `N staged` and looks healthy while every row
it staged is dates-only. This is the single easiest failure to miss, because
nothing about the summary line looks wrong.

A size-related failure now gets one automatic retry on the densest half of the
passages. If it still fails:

- `The operation was aborted due to timeout` — raise `GEMINI_TIMEOUT_MS` (300s
  by default), or lower `--pages` so there is less to read.
- Truncation — the response hit the output ceiling. Same remedies.
- Run with `--concurrency 1`. Three programmes in flight means three model
  calls competing, and the timeout is per call.

### "N programme(s) skipped — a proposal is already waiting in review"

Working as intended. Re-running used to stage a second proposal for a row that
already had one pending, so the queue filled with duplicates of the same
programme and a reviewer had to work out which was newer. Clear the queue at
`/admin/review`, or pass `--force`.

### "unchanged since the last extraction — skipped"

The page behind the previous proposal is byte-identical, so the model would read
the same words and reach the same conclusion. The crawl still happened (it is
cheap); the two model calls did not. `--force` re-reads anyway.

### A run takes far longer than expected

Crawling is deliberately paced: request starts to one host are spaced 800ms
apart, at most two connections at a time, up to `maxPages × 2` attempts per
programme. Twenty pages is roughly 20–30 seconds of fetching before any model
call. Lower `--pages` for a cheap pass, or raise `CRAWL_DELAY_MS` to be gentler.

If it hangs with no output, remember the scripts buffer stdout when piped to a
file; run them in a terminal or via `/admin/pipeline` to see progress live.

**The model timeout dominates the worst case.** It is 300s, and the profile call
gets a second go on half the passages, so one programme can spend
300 (cycle) + 300 (profile) + 300 (retry) = 15 minutes before giving up. Three
Chevening programmes took 15:07 wall-clock for 2.4s of CPU — all of it waiting.

That number is deliberate: at 180s every Chevening profile call failed, and at
300s they all succeeded. But if you are doing a quick pass rather than a
thorough one, `GEMINI_TIMEOUT_MS=120000` fails fast and leans on the
half-passage retry instead.

**A slow site costs more than a slow model.** A fetch timeout is 15s, and a
timeout gets one retry rather than two. There is nothing to fix in the pipeline
when this happens; it is the site, and the retries are what get you the page
next time.

`--concurrency` helps most when a batch spans several funders. Rows sharing a
host no longer serialise completely — the gate allows two connections and spaces
request _starts_ — but they do share that host's budget, so three Chevening rows
still finish more slowly than three rows on three different sites.

### A re-run is slow even though nothing changed

It should not be, any more. The unchanged check used to run after the crawl;
it now fetches the single page the last proposal was read from and skips on a
hash match. If rows are still being crawled in full, check the run is not
passing `--force`, and that the previous run actually staged something — a row
with no prior extraction has nothing to compare against.

### 429s, or "TPM budget reached"

`GROQ_TPM` does not match your tier. Set it from the Groq console → Limits. The
pipeline sizes every request to 85% of it, so too high produces 429s and too low
wastes context. Gemini's limiter paces by requests per minute instead; adjust
`GEMINI_RPM`.

### "Daily limit" stops a run early

Free-tier daily cap, most often Groq's. The run stops cleanly so already-staged
rows are reported rather than lost. Switch provider with `--provider gemini` or
wait out the day.

### Every row is re-read after upgrading, even unchanged ones

Expected, once.

The "unchanged since the last extraction" check compares `page_sha256` against
the last proposal's, and that hash is taken over the page's **text**. Migration
016's pipeline appends structured data — JSON-LD, meta descriptions, rendered
tables — to that text, so every page hashes differently than it did before and
every row looks changed.

That is the outcome you want here: those rows have never been read with the
table and JSON-LD content included, and several of them were thin precisely
because of what was being discarded. It settles after one pass.

### A field says "Not stated by the programme" and the page clearly states it

Two possible causes, and they are told apart in `/admin/coverage`.

If the field's cause reads `not-published`, the crawl reached that topic and the
field's vocabulary appeared nowhere in anything fetched — usually because the
statement is phrased in words the phrase list in `scripts/extract/gaps.ts` does
not carry. Add the phrasing the site actually uses.

If the cause is anything else, the row should not be showing that message at
all — only `not-published` is allowed to reach a card. A row still showing it
was most likely applied from an older extraction; re-run and re-apply.

### A blank stays blank after several runs

Open `/admin/coverage` and expand the row rather than raising `--pages` again.
Each cause has a different fix and only three of the five are worth acting on —
see [operations.md § Chasing blanks](operations.md#chasing-blanks--admincoverage).

The commonest surprise is `not-retrieved`: the words are in the crawl and never
reached a prompt, which is a missing phrase in `SPECS`, not a crawl problem.
Raising the page budget for that one does nothing at all.

### "no readable pages" on a site that works in a browser

The page builds its content client-side and ships nothing in the initial HTML.
The recovery ladder (`scripts/extract/hydrate.ts`) tries the hydration payload,
`<noscript>` and the AMP copy first, all free; if none of those had it, the
content genuinely is not in the bytes.

Set `RENDER_SERVICE_URL` to a headless renderer to go further. Nothing here is
bundled — see [pipeline.md § Pages a plain fetch cannot read](pipeline.md#pages-a-plain-fetch-cannot-read).

### A scanned PDF is reported as unreadable

There is no text layer and no `OCR_SERVICE_URL` configured. With one set, the
scan is read and every quote from it is recorded as `match: "ocr"`, which the
review UI flags — grounding is unchanged, but a human is told the characters
were a machine's reading of an image before they mint `verified` off it.

## Pipeline console

### "Reviewers only"

Your address is not in `admins`, or the session is anonymous, or the email is
unconfirmed. `select * from why_not_admin();` says which.

### "Apply supabase/migrations/012_pipeline_jobs.sql to run the pipeline from here"

The queue tables do not exist yet. Run that migration in the Supabase SQL editor.
Everything else in the app works without it — only the browser-driven pipeline
needs it. (The terminal crawlers never did.)

### "A run is already in flight"

One live run at a time, enforced by a partial unique index rather than by a
variable in one server process — which is what makes it hold on a serverless
host, where every request may land in a different instance. Wait, or press Stop
on the running one.

If nothing is actually running — a function was killed mid-tick, say — the job
is still marked `running` until its heartbeat goes stale. Either press Stop, or:

```sql
update pipeline_jobs set status = 'cancelled', finished_at = now()
where status in ('queued', 'running');
```

### The console says "running" but the log has stopped moving

The tick loop lives in the tab. If the tab was closed or slept, nothing is
calling `tick` — the job is not dead, it is unattended. Reopen
`/admin/pipeline`: the console re-attaches to the live run and starts ticking it
again from the cursor.

### A deploy fails with an error about `maxDuration`

`api/admin/pipeline/tick/route.ts` asks for 300 seconds and your plan allows
less. Vercel validates this at build time, so the deploy fails rather than the
run. Lower `maxDuration` in that file, and lower `PIPELINE_TICK_MS` with it so a
tick still finishes its unit inside the ceiling. More ticks, same result.

### "No model provider configured" from the deployed console

The provider key is missing from the deployed environment. Add `GEMINI_API_KEY`
(or `GROQ_API_KEY`) in the Vercel project settings and redeploy. It is read only
inside a Route Handler and never reaches the browser. Do **not** add
`SUPABASE_SERVICE_ROLE_KEY` — the deployed pipeline writes as the signed-in
admin and does not want it.

## App

### A page renders blank after changing a JSONB column

Something consumed a column without guarding its shape. The JSONB columns are
typed in TypeScript but not enforced by Postgres, and rows arrive from three
places that disagree — `seed.sql`, `promote_candidate()`, `apply_extraction()`.
Guard with `Array.isArray` / `typeof x === "number"` at the boundary.

### A card shows "Not stated" everywhere

That row is a discovery-promoted skeleton nothing has filled in yet. Run
extraction against it and apply the proposal. If applying changes nothing, check
that **migration 007 is applied** — the earlier `apply_extraction()` copied only
the four date keys and silently discarded coverage, eligibility and documents.

```sql
select proposed_documents from extraction_review limit 1;
```

An error there means 007 has not run.

### A timeline disappeared after applying an extraction

Fixed in 007. The old `apply_extraction()` used
`COALESCE(proposed -> 'timeline', timeline)`, and an empty JSON array is not SQL
NULL — so a proposal with no timeline overwrote a good one. Arrays are now
replaced only when the proposal is non-empty.

### Checklist ticks vanished for a document

`document_checklist[].key` is the id stored in `user_targets.checklist_progress`.
An applied extraction that renamed a document's slug orphans that user's tick.
Unavoidable when a checklist is genuinely corrected — one reason a human approves
the proposal first.

### The site feels slow, and worse the more you move around

Almost certainly orphaned pipeline drivers, fixed as of `017`.

The console does not poll a background worker — each tick is an HTTP request
that performs the crawling and returns. That loop lives in a closure, and
nothing used to stop it when the component unmounted, so navigating away from
`/admin/pipeline` left it running. `useRef` is per instance, so coming back
started a *second* loop beside the first, and every visit added another.

The orphans are not idle. Each POSTs a tick, `claim_pipeline_tick` refuses it
because the live loop holds the job, it backs off three seconds and asks again
— so what accumulates is a set of permanent three-second pollers, each an
invocation with an admin check and a query behind it, competing with ordinary
page loads that are all `force-dynamic`.

Unmount now stops the loop. It is *asked* to stop rather than aborted: the tick
in flight is doing real crawling and saves at the end, so killing it would throw
that work away. The run itself survives either way — the cursor is in Postgres,
and reopening the page re-attaches.

A hard refresh clears any orphan from a session that predates the fix.

### The pipeline log appears in bursts, or looks stuck

Fixed as of `017`, and worth knowing the shape of.

A tick is up to 210 seconds of crawling and every line it produced used to stay
in a local array until the whole thing returned — so there was nothing to poll,
because the lines did not exist anywhere a poller could reach. The pane sat
blank for three and a half minutes and then filled at once.

The runner now flushes lines and its cursor to `pipeline_job_lines` after every
batch, and the console pulls by sequence number every 2.5s. Lines come from the
database only, so a tick returning cannot duplicate what polling already showed.

If a run still feels coarse, lower `PIPELINE_TICK_MS` (default 210000). Shorter
ticks return more often and keep the host freer for ordinary requests, at the
cost of more invocations per run.
