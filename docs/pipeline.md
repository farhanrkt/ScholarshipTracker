# The pipeline

Two scripts, one loop:

```
discover  →  scholarship_candidates  →  [human]  →  scholarships (dateless skeleton)
                                                          ↓
extract   →  scholarship_extractions →  [human]  →  scholarships (dates + profile)
```

Both write only to staging tables. Neither can change a live row. A human in
`/admin/candidates` and `/admin/review` is the only path from "a model said so"
to "a student sees it".

Run them from a terminal or from `/admin/pipeline` — see
[operations.md](operations.md).

---

## Part 1 — Discovery

`scripts/discover/run.ts` finds programmes there is no row for yet.

### Seeds

`scripts/discover/seeds.ts` holds 23 verified seeds across the six target
countries, plus 10 recorded failures in `BLOCKED_SEEDS`. Each entry carries the
count of programme-shaped links it yielded when it was checked.

**The seed list is the single biggest lever on what the database contains.**
Verify before adding:

```bash
npm run discover:verify -- https://example.org/scholarships/
```

That fetches the page and counts programme-shaped links **with the crawler's own
scorer**, so a seed is measured the way it will actually be crawled. Under five
links is not worth a slot.

### Two levels, not one

This is the part that decides volume.

1. **Level one — listings.** The seed is fetched, then its pagination is
   followed, up to `--max-listing` pages. Every programme-shaped link found
   across all of them goes into one pool.
1b. **The site's own sitemap.** See below — the same pool, a different source.
2. **Level two — classification.** The pool is ranked and each candidate is
   fetched, prefiltered, and classified, up to `--per-seed` programmes.

A page that turns out to be *another listing* is expanded for its links instead
of being discarded — it has already been fetched, so that costs nothing. Two
things trigger that: the prefilter recognising index markers, or the model saying
"not a programme" about a page that nonetheless carries five or more
programme-shaped links.

Reading each seed exactly once — the original behaviour — made page 2 of every
portal and every "PhD scholarships A–Z" sub-index invisible. That was the real
ceiling on how many programmes a run could find, not the classifier.

**Measured:** the Commonwealth Scholarship Commission seed goes from 11 links on
one page to 39 candidates across two pages plus a sub-listing expansion.

### Sitemaps

`scripts/discover/sitemap.ts`. Every other path into the database is a link
somebody put on a page we happened to fetch, which caps discovery at the site's
own navigation. A sitemap is the site declaring its complete inventory in one
fetch, so it reaches awards that are linked from no index at all.

Sources, in order: the `Sitemap:` lines in `robots.txt` (a global directive, not
scoped to a User-agent group), then `/sitemap.xml`, `/sitemap_index.xml`,
`/sitemap-index.xml`, `/wp-sitemap.xml`. A `<sitemapindex>` is followed one
level, preferring child sitemaps whose own names mention scholarships or
funding. Bodies are fingerprinted so `/sitemap.xml` and `/wp-sitemap.xml` being
the same file does not cost the budget twice.

**Measured (2026-08-03):**

| Seed | Links on the seed page | Sitemap URLs |
| --- | --- | --- |
| Chevening | 18 | 197 in `wp-sitemap-posts-scholarships-1.xml` |
| Leicester | 14 | 206 |
| Edinburgh | 467 | +21 not linked from the index |
| Berkeley | 108 | +20 |

Two things this cost, both worth knowing before you touch it:

- **Compare hosts, not origins.** Sitemaps routinely still declare `http://` on
  sites that moved to `https` years ago. An origin comparison silently rejected
  every URL of Edinburgh's 6,907-entry sitemap.
- **A sitemap has no anchor text**, so `scoreCandidate` carries the whole
  judgement on the path alone. That is what forced `ARCHIVE_PATH`: newsletter
  posts at `/september-2015/gates-foundation-grants` score *well* on "grants",
  and anchor text was the only thing that had been keeping them out.

Turn it off with `--no-sitemap`; cap it with `--sitemap-urls`.

### Finding seeds without a search engine

`npm run discover:find-seeds -- --country UK`

The seed list is the ceiling on everything discovery can find, and curating it
by hand yields roughly one usable seed per four or five URLs guessed. The
obvious fix is a web search, and it has two problems: it needs a keyed, metered
API, and it returns the open web — which for "scholarship for international
students" is overwhelmingly aggregators, the sources this project refuses to
treat as facts.

**ROR is a better fit than a search engine, not a worse one.** Free, keyless,
CC0, and it lists every accredited education and funding body — ~20,000 across
the six target countries, each an institution by construction. So rather than
searching the web and filtering out junk, we enumerate institutions and read
their own sites. `find-seeds` pulls them, reads each one's sitemap, and prints
paste-ready seed entries with their measured yield.

It stays a **report, not an auto-import**: a seed is a commitment to crawl a
site every run, and telling a funding index from a course catalogue is a
judgement. What it removes is the searching.

Two things learned building it, both now in tests:

- **"College" is a trap.** Preferring it surfaced the Royal College of
  Obstetricians (50 award pages) and the Royal College of Surgeons (11) above
  actual universities. Those are travel fellowships for a college's own medical
  trainees — real, institutional, and not something an applicant can use for a
  degree. `rankInstitutionName` demotes professional and learned societies.
- **ROR has no useful default order.** The first page for South Korea was a
  children's rights society and two provincial colleges.

**It does not fix China or South Korea.** SNU, KAIST, Yonsei, Korea University,
Tsinghua, PKU, Zhejiang and SJTU were tested directly: 0 of 8 publish a usable
sitemap, and several 404 or 403 outright. A search engine would not fix it
either — the blocker is that those servers will not serve a non-browser client,
not that we cannot find the pages.

### Source authority

`scripts/discover/authority.ts`. Grounding proves a source SAID something; it
cannot prove the source was right, and those diverge the moment two sites
describe one award.

| Tier | Meaning |
| --- | --- |
| `funder` | The programme's own organisation — same registrable domain as its `official_portal_url` |
| `official` | A government or academic body that is not the funder |
| `other` | Everything else |

`official` comes from registry-controlled suffixes (`.ac.uk`, `.edu`, `.go.jp`,
`.edu.sg`…) that you cannot buy without accreditation, plus a curated list of
real funders on plain domains (`chevening.org`), plus optional ROR membership.
**`.org` is deliberately not official** — anyone can buy one, and both real
funders and content farms do. A denylist beats every promotion path, so a site
judged unreliable cannot be rescued by a suffix or a registry.

### Pagination detection

`scripts/discover/candidates.ts` accepts a link as "more of this list" when the
URL looks like the same list **and** the anchor text reads like a pager:

- `<link rel="next">` or `<a rel="next">` — taken directly
- same path with a `page` / `paged` / `pg` / `p` / `start` / `offset` / `from`
  parameter
- `/some-list/page/2` hanging off `/some-list`
- anchor text matching `next`, `more`, `view all`, `show all`, `»`, or a bare
  number

Bare numbers are only accepted when the URL already looks like a pager, so a
link labelled "2" pointing at a programme is not mistaken for one.

This only works because URL canonicalisation **keeps pagination parameters**.
`extractLinks` used to strip the entire query string — reasonable against
`utm_source`, fatal against `?page=2`. It now runs an allowlist
(`page`, `paged`, `pg`, `p`, `start`, `offset`, `from`, `tab`, `view`), sorts the
survivors, and drops everything else, so two spellings of the same page still
de-duplicate to one fetch.

### Prefilter

`scripts/discover/prefilter.ts` classifies a fetched page **before** spending a
model call, returning one of three kinds:

| Kind | Meaning | Action |
| --- | --- | --- |
| `programme` | Looks like a specific funding programme | Classify it |
| `listing` | Enumerates many programmes | Expand it for links |
| `reject` | Too short, barely mentions funding, no application language, or reads as an article | Drop it |

The rules are deliberately loose. A false reject loses one candidate we can
recover by tuning; a false accept costs one model call we were paying anyway.
Judgement stays with the model.

### Classification

`scripts/discover/classify.ts` sends the first 2,500 characters to the cheapest
provider and asks: is this a specific, named funding programme a student could
apply to? **No grounding here** — that is a judgement, not a fact copied off a
page, and there is nothing to quote. A wrong answer costs a wasted fetch, never
a wrong date on someone's calendar, because **discovery is forbidden from
writing dates at all.**

Host countries are normalised on the way in (`United Kingdom` → `UK`,
`Republic of Korea` → `South Korea`, …). Anything outside the six targets passes
through unchanged rather than being relabelled.

### Budgets

| Knob | Default | Meaning |
| --- | --- | --- |
| `--per-seed` | 20 | Programmes classified per seed |
| `--max-listing` | 8 | Listing/pagination pages fetched per seed |
| `--sitemap-urls` | 150 | Sitemap URLs added to the pool per seed (`--no-sitemap` disables) |
| `--min` | `low` | Minimum classifier confidence to stage |
| `--seed-concurrency` | 3 | Seeds crawled at once |
| internal | `perSeed × 2 + maxListing` | Ceiling on fetches, so pages that fail the prefilter cannot run a seed forever |

Seeds run several at a time, which is safe for the same reason parallel
extraction is: politeness lives in the fetch layer and is enforced per host, and
seeds are different hosts. The provider's own rate limiter is shared across
lanes, so the classification calls stay inside the same per-minute budget — they
simply stop waiting on each other's page fetches. Each seed's log lines are
buffered and printed as one block, because interleaved output from eight crawls
is unreadable.

Within a seed, the next two candidate pages are fetched while the current one is
being classified. The loop otherwise alternates one fetch with one model call,
each waiting on the other; `fetchPage` caches the in-flight promise, so warming
the next addresses means their bytes arrive during the model call and the awaits
that follow return immediately.

---

## Part 2 — Extraction

`scripts/extract/run.ts` crawls a programme's own site and reads two things off
it: the application cycle, and the programme profile.

### Why it crawls rather than fetching one page

A scholarship's details are never all on the page you have a URL for. Chevening
publishes eligibility on `/who-can-apply/`, the deadline on
`/application-timeline/`, and its benefits somewhere else again. A single-page
fetch of any one of them misses the other two.

### The crawl: per-topic quotas

`scripts/extract/crawl.ts`. Every link is scored against five topic families —
`dates`, `eligibility`, `benefits`, `documents`, `process` — and each topic gets
a **reserved page allocation**. Only leftover budget is competed for.

| Setting | Default |
| --- | --- |
| `maxPages` | 16 (`--pages`) |
| `maxDepth` | 3 |
| `minLinkScore` | 6 |
| `maxFetches` | `maxPages × 2` |
| `maxHubs` | 2 |
| Quotas | dates 5, eligibility 4, benefits 4, documents 3, process 3 |

The entry page is always fetched and is not charged to any quota, and neither
are the **hubs**: the entry's parent path and the site root, fetched first
because that is where navigation lives. A row staged by discovery points at
whatever page the classifier read, which is routinely a leaf like
`/how-to-apply/eligibility/`, and a leaf links to its siblings and little else.

Links are also scored for **title affinity** — how strongly their text and path
name *this* programme. Several rows point at a site root rather than a
programme page, and on a portal every section has an eligibility page and a FAQ
that are about the portal rather than the award. Distinctive words from the
title (with "scholarship", "programme", "international" and friends discarded as
useless) are what tell `/planning/scholarships/mext-scholarships` apart from
`/planning/faq`. Affinity is added before the score threshold, because a
programme's own page on a portal is often just its name with no topic
vocabulary at all.

**Why quotas and not one ranked queue:** a single queue is won outright by
whichever topic has the loudest vocabulary. The original scorer knew only date
language, so a twelve-page budget went entirely on date-ish pages and `/benefits`
was never fetched — the direct cause of rows that had a deadline and nothing
else. Under the old scorer, Chevening's own `/who-can-apply/` scored **zero**.

**Nav vocabulary.** The topic families are phrase-shaped on purpose — "benefits"
in prose discriminates nothing. A link is not prose: a menu entry reads
`Benefits → /benefits/`, and under the phrase lists alone it scored **zero** and
was dropped before it was fetched. `NAV_TERMS` adds bare page-name words applied
**only to link labels and paths**, never to passage text, because `scoreTopics`
drives passage selection and grounding depends on it staying precise.

| Link | Before | After |
| --- | --- | --- |
| `Benefits` → `/benefits/` | 0 | 40 |
| `Apply` → `/apply/` | 0 | 40 |
| `Funding` → `/funding/` | 0 | 40 |
| `Fees and costs` → `/fees/` | 0 | 50 |

Path scoring weights the **last segment ×3** over ancestors ×1: the leaf is the
page's own name, the ancestors are the section's. Weighting the whole path
uniformly let `/how-to-apply/fellowship-components` — Humphrey's *funding* page —
route to `process` on the strength of its parent directory.

**A page only fills the `dates` quota if it talks like a deadline.** Month and
year tokens are rewarded by `scoreText`, so everything dated looks like a
timeline: a news post at `/news/2026-cohort-announced` scores 18, clears the
threshold, and — because ties in `bestTopic` fall to `dates` — takes one of the
five reserved date slots. On Chevening that spent two of them on a
fellowship-hosting page and an "areas of impact" page. `hasDeadlineLanguage()`
now gates the charge, and a page that fails it is re-routed to whatever it is
actually about or dropped.

Two ceilings exist for reasons that were learned the hard way:

- `maxFetches` counts attempts, not successes. Without it, a site whose links
  mostly 404 walks its entire queue at a page and a half of latency each — one
  programme spent ten minutes fetching pages it then discarded.
- Pages are de-duplicated **again on the URL that came back**, not just the one
  requested. A redirect or an ignored query parameter otherwise spends a topic's
  whole reservation on one document fetched twice.

### Where a crawl starts, and why the order matters

`official_portal_url` first, `source_url` second. That order is load-bearing and
it is the reverse of the original, which had a feedback loop in it:

1. A crawl finds the deadline on `/scholarships/application-timeline/`.
2. `bestSourceUrl` becomes that page — correct, it is what a human
   re-verifying the date should open.
3. `apply_extraction()` writes it to `source_url`.
4. The next crawl starts *there* instead of the programme's own page.

Each pass walked the entry further toward a generic dates page and further from
the page describing the award. Observed: all three Chevening rows — Scholarships,
SIDS and Fellowships — had converged on the same `/application-timeline/` entry,
so all three crawled the same pages, none started from its own programme page,
and the coverage matrix stayed empty because nothing in that neighbourhood talks
about money.

Converging distinct programmes on one entry is also how a row inherits another
programme's dates. The Fellowships row was saved only by the model noticing and
reporting `wrong site`.

`official_portal_url` is the right anchor precisely because nothing in the
pipeline ever writes to it. The timeline page is still reached — it is one link
away and scores highly — and `bestSourceUrl` still records it for the reviewer.

### One fetch per URL per run

`fetchPage` memoises by canonical URL for the life of the process
(`clearPageCache()` resets it).

Programmes on one site overlap almost completely, and each row runs its own
crawl: three Chevening rows fetched the **same sixteen pages**, 48 requests where
16 would do, and MEXT did the same across two rows. The politeness gate made that
slow rather than rude — the right trade, but not a reason to send the requests.

Two details worth keeping:

- **Promises are cached, not results.** Concurrent crawls ask for the same page
  at the same time, which is the normal case at `--concurrency 3` on one host.
  Caching the in-flight promise makes the second caller await the first instead
  of starting an identical request.
- **Rejections are evicted.** A 404 for one programme must not stop the next
  from trying; the failure may have been transient, and `fetchWithRetry` has its
  own view on that.

`fetchedAt` on a cache hit is when the bytes were actually read, not when the
hit happened — which is the honest value, and the one stored as the extraction's
`fetched_at`.

### Politeness and the fetch layer

Not optional, and deliberately **not** the caller's job. `fetchPage` owns it:

- **`robots.txt`, properly.** Groups are parsed separately and the one naming us
  wins over `*`; within it the longest matching pattern decides, with `Allow`
  beating `Disallow` on a tie. `*` wildcards and `$` anchors are supported. This
  matters more than it sounds — a site with `Disallow: /` and
  `Allow: /scholarships/` is inviting us to exactly the section we want, and the
  earlier Disallow-only parser refused the entire origin.
- **`Crawl-delay` is honoured** when published, overriding our own gap — and a
  site that publishes one is also dropped to a single connection. An explicit
  request for spacing outranks our throughput.
- **A per-host gate** spaces requests to one host while letting different hosts
  run concurrently. Putting this in the fetch layer is what makes parallel
  extraction safe: three crawls that happen to share a host are still spaced, and
  no caller can forget to sleep.
- **Two connections per host, with request _starts_ spaced by the gap.** This is
  the difference between a crawl that takes 56 seconds and one that takes 20.
  The gate used to run one chain per host and measure the gap from the END of
  the last response, which is strictly serial: a page cost `latency + gap`, and
  because a programme's pages are all on one host, no amount of concurrency
  above it changed anything. Spacing _starts_ instead means the gap overlaps the
  latency rather than following it. The sustained rate a site sees is unchanged
  at one request per gap; a browser opens six connections per host without
  anyone calling it rude.
- **Transient failures are retried** — 429, 500, 502, 503, 504 — up to three
  attempts, honouring `Retry-After`. A 404 is an answer and is not retried.
  Losing a programme's whole coverage section to one momentary rate limit was a
  real and frequent loss on busier university sites.
- **A refusal gets one second try, shaped like a browser.** A large share of
  4xx failures are a WAF scoring the _request_ — no `Accept-Language`, a bare
  bot token, no `Sec-Fetch-*` headers — on a public page that `robots.txt`
  allows and a person loads instantly. So 401, 403, 406 and 451 are retried once
  with browser-shaped headers, and the host is remembered so its other pages
  skip the wasted first request. The retry still names us and still carries the
  contact URL, `robots.txt` is still obeyed first, and a host that refuses both
  identities is left alone.
- **A failed status is carried, not flattened into a string.** `HttpError.status`
  is what lets extraction tell "this URL is wrong" (404) from "we were turned
  away" (403) — see URL repair below, which acts on the first and must not act
  on the second.
- A descriptive user-agent is sent, and binaries are skipped.

### When the stored URL is dead — `scripts/extract/repair.ts`

Funders reorganise their sites constantly. The URL in our row keeps pointing at
where the page **was**, extraction fails with `HTTP 404`, and the row is listed
as "fix these by hand" until somebody does — while the programme itself is fine
and its new page is two segments away.

A 404 is the one crawl failure that carries information: it says the address is
wrong, which is something the pipeline can act on. So it probes, cheapest first:

1. **Spellings of the same address** — trailing slash both ways, `www` toggled,
   a leftover `index.php` dropped, `http` upgraded. Nothing new has to exist for
   these to work.
2. **Ancestors**, nearest first — `/funding/chevening/how-to-apply` gone means
   `/funding/chevening` is where the programme probably lives now. Landing on a
   section index is enough: the crawler takes a title hint and walks back down.
3. **The site's own sitemap**, ranked by how well each path matches the
   programme's distinctive words. The only step that can find a genuinely new
   address.

**It proposes addresses, never facts.** Whether the page it found is the right
programme is decided downstream by `page_is_about_requested_programme`, exactly
as for any other crawl. Only after that passes is the row re-pointed — so the
worst case of a bad guess is a wasted crawl, never a row silently re-pointed at
someone else's scholarship. This is the one place the pipeline writes
`official_portal_url`, it never runs in a dry run, and `--no-fix-urls` turns the
write off while leaving the recovery on.

A 403 is **not** repaired. The address is probably right and we were refused;
guessing more addresses at a host already turning us away is just more refusals.

`<nav>` and `<footer>` are stripped before text extraction: as text they are the
same twenty link labels on every page, crowding real prose out of the passage
budget and offering month names to misread as deadlines. Their **links** are
still harvested, because `extractLinks` reads the raw HTML — which is the
arrangement we want, since navigation is a hand-written index of the pages worth
crawling.

### Passage selection

`scripts/extract/passages.ts`. Sixteen pages is ~90k characters of mostly
navigation chrome. Passage selection keeps the parts that look like they state
something we asked for, in document order, labelled with their source page.

Text is split into paragraph-ish blocks (short lines are glued to their
neighbours — `"Deadline: 6 October 2026"` is 24 characters and the most important
sentence on the page), scored per topic, then filled in two passes: a reserved
pass where each topic spends its own share, and a leftover pass that reallocates
what quiet topics did not use.

Topic weights: dates 1, eligibility 1, benefits 1, documents 1, **process 0.6** —
process prose is the most verbose and the least load-bearing.

**Keyword scoring, not embeddings.** At sixteen pages you know exactly which
words you are hunting for, so a keyword score is exact, free, instant and
debuggable. Embeddings would add a provider, a vector store, and a retrieval
failure mode to a problem we do not have.

### Two calls, one crawl

The crawl is shared; the extraction is not.

| Call | Schema | Reads |
| --- | --- | --- |
| 1 | `CycleExtractionSchema` | `cycle_label`, `opens_date`, `deadline_date`, full `timeline` |
| 2 | `ProfileExtractionSchema` | `coverage`, `eligibility`, `documents`, post-study obligations, language training, `fields_of_study`, `award_duration`, `number_of_awards` |

This is an output-budget decision, not a tidiness one. One response carrying
dates, a timeline, eight coverage lines, eleven eligibility claims and a document
list — each with its own verbatim quote — overruns the token ceiling of the
free-tier providers this runs on, and a truncated response loses the dates too.
Split, a failed profile call still leaves you the deadline.

The two calls **share** the provider's prompt budget, because a rate limit is per
minute and both calls happen inside the same minute. Dates are selected first,
against 55% of it, and **whatever they do not spend goes to the profile** rather
than expiring. That matters more than the split does: date passages are sparse
by nature — a closing date lives in one or two sentences — so a fixed 45% share
for the profile did not mean the profile _got_ 45%. It meant the cycle half used
a fraction of its reservation, the remainder was discarded, and eligibility and
coverage passages that would have fitted were dropped for want of room. On a
real Chevening crawl this is the difference between ~45k and ~73k characters of
evidence reaching the profile call.

Failures are contained: either call can fail, time out, or return unparseable
JSON, and the other still produces a proposal. `--dates-only` skips call two.

With `--escalate`, the cycle call escalates on a missing **closing date**, not
only on an empty reading. A reading with an opening date and four undated stages
is not empty, so it used to end the chain while missing the one field a student
cannot recover from. Because a second attempt is then no longer guaranteed to
improve on nothing, the better of the two readings is kept rather than the later
one — scored closing date first, opening date next, dated stages last.

### Escalating on thin, not only on empty

The profile call used to escalate to the stronger provider only when it came
back **completely empty** — and empty is not the characteristic failure of a
small model on this prompt. **Thin is.** Twenty-five facts each carrying its own
verbatim quote is a large response, and what a small model does with it is
answer the first few and stop: three coverage lines, nothing else, no error, no
truncation the provider reports. That result is not empty, so it was accepted,
and the escalation configured for exactly this case never fired.

Below `THIN_PROFILE_FIELDS` (6 of 25) the reading is treated as a failure worth
one more call. Six is deliberately low — it is not a target, the gap passes exist
to get well past it, it is the line below which the reader has plainly not
engaged with the passages. When a stronger reader does run, its result is merged
fill-only over the first, so escalating can only ever add.

### The profile call gets a second, smaller go

Containment has a nasty edge to it. When the *profile* call fails, the cycle
call still succeeds — so the run reports `3 staged` and looks healthy, while
every row it staged carries a deadline and nothing about the money, the
eligibility, or the documents. That is the shallow-data symptom arriving through
the path that looks like success, and it is easy to miss for exactly that reason.

A three-programme Chevening run lost the profile call on **all three** to
`The operation was aborted due to timeout`. So a size-related failure — a
timeout, or `TruncatedError` — now earns one retry on the **highest-scoring half**
of the passages.

Halving the input is the right retry rather than simply waiting longer: prompt
size is what makes the response slow, since fewer passages means fewer values to
quote and a much shorter JSON body. It is also not merely cheaper — the half
kept is the densest half, so the second attempt reads better evidence than the
first. Failures that would fail identically on less input (a refusal, a bad key)
are not retried.

The provider timeout is 300s, overridable with `GEMINI_TIMEOUT_MS`.

### The third call: going back for what is still empty

`scripts/extract/gaps.ts`. A staged row was routinely half blank — a deadline,
three coverage lines, and nulls everywhere else — and the reason was almost never
that the funder does not publish the answer. It was one of three things, and all
three are ours:

1. **The passage was never sent.** Topic selection works at the scale of a
   page's subject. `"Applicants must be under the age of 35 on 1 September"` is
   one sentence on a long eligibility page, competing for budget under a single
   `eligibility` score that cannot tell it from the paragraph about referees.
2. **The model ran out of room.** Twenty-five facts, each carrying its own
   verbatim quote, is a large response, and small models drop the tail.
3. **The model went past it.** One ask covering money, eligibility, documents
   and scope gives no field its own attention.

So a third call asks a much narrower question. `profileGaps()` lists the slots
still empty — 25 of them, which is also the denominator of the `12/25 field(s)
filled` figure now printed per programme — and each carries a **phrase list of
its own**: `"under the age of"`, `"born on or after"`, `"no older than"` for an
age cap; `"return airfare"`, `"economy class"`, `"travel allowance"` for flights.
Blocks are re-scored against those phrases rather than against a page's general
subject, so a fact stated once, halfway down a page that lost the first budget
contest, is reachable for the first time.

Three properties keep it honest:

- **Same grounding.** The reply goes through `groundProfile()` unchanged. A
  value it cannot quote off a fetched page is discarded exactly as before.
- **Fill-only merge.** The first reading wins every contest — not because it is
  better, but because it read a wider context and is better placed to judge
  which of two stipend figures belongs to this award. The pass is therefore
  monotonic: it can add information and can never remove any.
- **Text already sent is discounted, not excluded.** Sometimes the answer was in
  front of the model and it went past it, and re-sending three sentences with a
  question attached is a very different prompt from re-sending forty with a
  general one. New material still wins any close contest for the budget.

It is skipped when fewer than two slots are empty, and when nothing in the crawl
uses the vocabulary of the missing fields — in which case the log says so, which
is the difference between "the funder is silent" and "we never asked".

The pass escalates like the other two, and it is where escalation pays best:
these are the hard fields by construction, and the call is one narrow question
against a few thousand characters. On the Rotary Peace Fellowship it is the
difference between 4/25 and 6/25 slots filled; the rest of that row is genuinely
not published, because Rotary's deadlines are set per district.

`--no-gap-fill` turns it off.

### The fourth call: crawling again for what was never read

Everything above **re-reads pages already held**. That is the right response to
a fact that was fetched and missed, and it is powerless against a fact on a page
nobody fetched — a different and very common failure: the benefits page lost the
quota contest, or its link scored under `minLinkScore`, and no amount of
re-reading what we did get will produce a stipend that was never downloaded.

Telling those apart is what `scripts/extract/diagnosis.ts` is for (below). Of
its five causes, exactly one — `never-crawled` — is worth spending new requests
on, and the crawl it asks for is narrow in a way the first one could not be:

- **quotas concentrated** on the starved topics and set to zero everywhere else,
  so the second crawl cannot re-run the first one's contest and re-fetch the
  same well-linked pages under a new name;
- **link scoring boosted by the missing facts' own vocabulary** — the same
  phrase lists the gap retrieval uses. The topic scorers ask "is this page about
  eligibility"; after a first pass the question is "is this page about the age
  limit", and a link labelled `Age and residency` scores nothing on a phrase
  list built from headings like "who can apply";
- **every page already read excluded** via `skipUrls`, so the budget buys new
  material rather than confirming old;
- **one level deeper** (`maxDepth: 4`), because the pages that survive to a
  second crawl are the ones buried furthest from the entry, which is usually why
  the first crawl never reached them.

It fires only when a whole topic was starved **and** at least two fields are
unreachable — one field is not worth a crawl, and the pattern this exists for is
never just one. Then the gap pass runs again over the enlarged crawl.

`--no-gap-crawl` turns it off. It is a separate switch from `--no-gap-fill`
because it is the only gap mechanism that spends new requests: an operator
throttling a run usually wants to keep the free re-read and drop the fetches.

---

## Why a field is blank — `scripts/extract/diagnosis.ts`

The log could say `12/25 field(s) filled`. It could say nothing at all about the
other thirteen, and those thirteen are not one thing. **A blank has four
possible causes and they are fixed in four different files** — so "improve
coverage" was unfalsifiable, and a crawler that never reached the benefits page
looked exactly like a funder that publishes no stipend.

| Cause | Means | Fix in |
| --- | --- | --- |
| `never-crawled` | No page on that subject was fetched | crawl budget, link scorer |
| `not-retrieved` | A fetched page uses the vocabulary; no passage carrying it was sent | retrieval |
| `model-silent` | The words reached the model; nothing came back | prompt, or escalate |
| `grounding-rejected` | Something came back and its quote was not on the page | **nothing — working as intended** |
| `not-published` | The subject was crawled, read, and does not discuss it | **nothing — a fact about the funder** |

The order of the rules **is** the algorithm, running from the most specific
evidence to the least. A field grounding rejected was obviously also crawled and
retrieved, so asking "was it rejected" first is what stops it being reported as a
retrieval bug. `not-published` is last because it is the residual and the claim
we are least entitled to make: nothing reaches it that any earlier rule could
explain.

That narrowness matters beyond tidiness, because **`not-published` is the only
cause allowed to reach a student**, as "Not stated by the programme" on the card.
Every other cause is our failure, and printing our failure as a fact about the
funder is exactly the class of confident wrongness the rest of this pipeline
exists to prevent.

The diagnosis is written to `scholarship_extractions.gap_causes` and surfaced at
[`/admin/coverage`](operations.md), ranked by how many blanks are recoverable —
which is the number that should fall between runs, and the only honest
definition of progress here.

---

## Pages a plain fetch cannot read

A page that yields nothing is a programme with **every** field blank, not one
field, so this is the largest single category of blank and the one furthest from
being the funder's fault.

### Structured data — `scripts/extract/structured.ts`

`htmlToText` strips `<script>` wholesale, which is right for the analytics and
framework bundles that make up nearly all of it, and also threw away
`application/ld+json` — a funder stating its own award in machine-readable form.
Tables fared no better: `</td>` became a newline, so a benefits grid arrived as
a column of orphaned cells with its header row several lines above and nothing
tying the two together.

Both are now rendered into ordinary sentences and **appended to the page's
text**, which is the whole design. It adds no extraction path, no schema and no
trust rule: `findQuote` searches them like any other page text, which makes a
value taken from JSON-LD **self-grounding** — the quote is literally in the page
source, because that is where the funder put it.

Rendering is allowlisted rather than dumped. A page's JSON-LD routinely carries
breadcrumbs, logos and a publisher's postal address, and letting those through
would spend the passage budget on exactly the material `htmlToText` strips nav
to avoid.

### JavaScript-rendered pages — `scripts/extract/hydrate.ts`

**Most "JavaScript-rendered" pages are not.** A site built with any mainstream
framework ships its content inside the initial HTML as a JSON payload so the
client can hydrate without a second round trip — `__NEXT_DATA__`,
`window.__NUXT__`, `self.__next_f`, an inline Apollo or Redux cache. The text is
already in the bytes we downloaded. It was invisible only because the extractor
throws away `<script>` and then measures what is left.

So the ladder runs cheapest-first, and a browser is the last rung:

1. **embedded hydration payloads** — free, no extra request, no dependency
2. **`<noscript>`** — what the site itself serves to a client without JS
3. **the AMP copy** the page links to — one fetch of static markup
4. **an external renderer**, if `RENDER_SERVICE_URL` is configured

Prose is separated from chrome by shape — long enough to say something, with
spaces, not a URL or an encoded blob, not a run of camelCase identifiers. That
filter is a grounding control, not a tidiness one: whatever it returns becomes
quotable page text.

The renderer is a URL rather than a dependency. Bundling Playwright would put a
browser download into every install of a project whose point is that it costs
nothing to run, and would not deploy to the serverless host the pipeline runs on.

### Scanned PDFs, and the fourth evidence tier

The objection to OCR was exactly right: OCR output is approximate, and an
approximate quote would pass a grounding check that exists to be exact.

The resolution is not to loosen grounding but to **record how the text was
obtained**. OCR'd pages are marked, every quote matched against one is recorded
as `match: "ocr"` alongside `exact` and `loose`, and the review UI flags it and
tells the reviewer to check the original. Grounding is unchanged — an OCR quote
still has to be found in the OCR text by the same matcher. What changes is that
a human is told which readings rest on a machine's guess at a glyph, which is a
much smaller claim than "this is verbatim from the page".

Unset `OCR_SERVICE_URL` and a scan is reported unreadable, exactly as before.

---

## Cross-verification — `--verify`

Grounding proves a source **said** something. It cannot prove the source was
**right**, and those stop being the same question the moment two sites describe
one award: a university page saying Chevening closes on 12 October grounds
exactly as well as chevening.org saying 6 October. One of them is last year's.

### Where the second sources come from

No search engine, and no new fetching. Discovery already meets them: when it
classifies a page whose programme name matches a row we have, it counts a
`duplicate` and drops the URL. That URL is another site describing a programme
we track — the exact input cross-verification needs — and it was being discarded
only because there was nowhere to put it. It now lands in `scholarship_sources`
with its authority tier.

### The two rules

1. **The funder wins.** A programme's own site is definitionally right about its
   own deadline — if it is wrong, it is still what an applicant is held to.
2. **Disagreement is never silently resolved.** The losing value keeps its URL
   and tier and becomes a reviewer caveat, so nobody sees a date with false
   confidence behind it.

What reconciliation deliberately does **not** do is average, vote, or let weight
of numbers beat authority. Ten aggregators copying each other's stale deadline
is one mistake ten times; treating it as ten confirmations is precisely how a
student ends up planning around a date nobody published. Corroboration is only
ever a tie-break between sources of equal tier.

### Scope: reconciled dates, filled profile

**Reconciliation** — several sources weighed against each other, one winning,
the losers recorded — covers only `cycle_label`, `opens_date` and
`deadline_date`. That is a cost decision made honestly: each extra source is a
full crawl plus a model call, extraction already runs ~5 minutes per programme,
and the free tier allows 15 requests a minute. A missed deadline is a missed
year — the one error here a student cannot recover from — so that is what gets
the budget.

**Filling** is different, and covers everything else: coverage, eligibility,
documents and scope, via `verifyProfile`.

This section used to claim that "secondary sources still improve the profile
fields, just by the ordinary path: a site stating a stipend the funder omits is
read when that source is crawled." **That was never true.** `crawlProgramme`
follows links same-origin only, so the ordinary extraction never crawls a second
origin at all — the sentence described a route that does not exist. The profile
was read exclusively from the funder's own site, and anything the funder chose
not to publish stayed blank permanently, however many times it was re-read.

That is a large share of the catalogue's blanks and it is the recoverable kind.
A host university states the stipend its own scholars receive; a government
portal lists the documents its embassy requires. Those pages were already in
`scholarship_sources`, already tiered, and were being consulted about three date
fields and nothing else.

The rules for filling are **stricter** than for reconciling, because a second
source is not entitled to an opinion about a slot the funder already filled:

1. **Fill only.** A second source can fill a field the funder left empty. It can
   never change one the funder stated — not when it looks more specific, not
   when it agrees. The funder's reading is not entered into the contest at all;
   the contest is only over slots it left open.
2. **Only the gaps are asked about.** The prompt names the missing fields, so a
   second source is never invited to opine on the rest.
3. **Grounded against its own pages**, exactly as for dates. A quote from one
   site can never be validated against another's text.
4. **Every filled field is attributed** in `field_sources`, so the UI can say a
   figure came from the host university rather than the funder — and a caveat is
   raised for anything a non-funder source is the only witness to, since that may
   be that university's arrangement rather than the award's terms.

A blank becomes a sourced value or stays a blank. It never becomes an unsourced
value.

### What the student sees

`SourceNote` renders **nothing** when the funder said it and nobody disagreed —
a badge on every card trains people to ignore all of them. It speaks up only for
second-hand values and for disagreements, which is the one case where the number
on screen might be wrong and we know it.

---

## Grounding — the control everything else rests on

`scripts/extract/ground.ts`.

The model must return a verbatim `evidence_quote` beside every value. After it
responds, the pipeline searches the fetched page text for each quote and
**discards any value whose quote is not found**. A hallucinated deadline comes
with a hallucinated quote, and a hallucinated quote is on none of the pages — so
fabrication is caught by string search, not by someone reading the output and
hoping.

Grounding runs against the **full text of every crawled page**, not the trimmed
passages, so budgeting can never turn a real quote into a rejected one. It also
records *which* page held each quote, and that page becomes the row's
`source_url`.

Layered checks, each catching something the previous one lets through:

| Check | Catches |
| --- | --- |
| Quote found verbatim (after one shared normalisation) | Invention, paraphrase |
| …or found **loosely** — see below | (recovers real values, catches nothing) |
| Quote ≥ 8 characters | `"2026"` matching by accident |
| Value is a real ISO date | Malformed dates with a good quote |
| **Date precision** — day, month and year each traceable to the quote | `"opens in September 2026"` → `2026-09-01`, where the day was invented |
| **Number support** — a claimed number must appear in its own quote | A grounded "includes a monthly stipend" sentence with an invented amount beside it |
| List values individually matched | A quote naming IELTS and TOEFL grounding a third test the model added |
| Conditional language → `caveats` | `"either 8 December or 6 January (see Course Directory)"` — real, but not one date |

Failing closed is deliberate: an ungrounded value is dropped, not flagged for
someone to notice later. Discards are reported per run and stored in
`ungrounded_fields` so a reviewer can see what was claimed and rejected.

Two guards sit outside grounding: the model reports what the site is actually
about (catching redirects and 404s), and pages that render their content in
JavaScript produce too little text to extract, so they fail loudly.

### When the quote misses the page by a word — `scripts/extract/quote.ts`

A substring search asks the right question and rejects for reasons that have
nothing to do with whether the model read the page:

```
page:  "Applications close on 6 October 2026.
        · Interviews follow in November"
quote: "Applications close on 6 October 2026. Interviews follow in November"
```

The model stitched across a bullet. The fact is real, the value is right, the
quote is on the page in every sense a human would recognise — and the deadline
was discarded, leaving the row emptier than the site. The same thing happens
when a quote drops a `"the"`, or a table cell arrives with a stray tab.

So there are two matchers, tried in order. **Exact** is the old substring search,
unchanged, and still what almost every quote hits — and it is tried against
*every* page before any loose match is attempted, so a quote that is verbatim on
page three is never attributed to a near-miss on page one. **Loose** slides a
window over the page's word tokens and accepts a window holding ≥85% of the
quote's tokens *and* every number the quote states.

What makes this a strengthening rather than a loosening: the match returns the
**span of page text** it matched, and every downstream check — date precision,
number support, list-value naming — now runs against that span instead of
against the model's quote. Previously those checks read the quote and trusted
the substring search to have tied it to a page. Now the page's own words are
what is examined, so a loose match cannot smuggle in a figure the page never
printed:

```
page:  "The award covers a monthly stipend towards your living costs in London."
quote: "The award covers a monthly stipend of GBP 1,347 towards your living
        costs in London"          → REJECTED: 1,347 is on no page
```

Quotes under six tokens get the exact search only — at that length 85% rounds to
"one word may differ", which on a nav-heavy page is a coincidence. Each field's
evidence records `match: "exact" | "loose"`, so a reviewer can see which values
rest on the looser reading.

### What good output looks like

Two real runs, both dry:

```
ADB-Japan Scholarship Program (JSP)
  12 page(s) [dates 4 · eligibility 4 · process 3]
  → 4 stage(s) · 6 coverage line(s) · 4 eligibility field(s) · 5 document(s)

Chevening Scholarships
  12 page(s) [eligibility 3 · benefits 3 · process 5]
  → opens 2026-08-04 · closes 2026-10-06 · 9 stage(s)
  → 1 coverage line(s) · 1 eligibility field(s) · 6 document(s)
```

Chevening yields one coverage line because **its site publishes no reachable
coverage page** — the crawler visited its eligibility, timeline and guidance
pages and none mention tuition or stipend figures. Returning one line instead of
seven is the pipeline being honest. Depth of detail is a property of the funder's
website, not a quality score for the run.

---

## Providers

`scripts/extract/providers/` is the only provider-specific code. Whichever key is
set wins, in the order below; `--provider gemini|groq|anthropic` overrides.

| Provider | Env | Default model | Prompt budget | Shape of the limit |
| --- | --- | --- | --- | --- |
| **Gemini** (first) | `GEMINI_API_KEY` | `gemini-3.5-flash` | 100,000 chars | ~15 requests/min, generous tokens |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | derived from `GROQ_TPM` (~31k chars at 12k TPM) | 12k tokens/min + a daily cap |
| Claude | `ANTHROPIC_API_KEY` | `claude-opus-5` | 60,000 chars | paid, no rate squeeze |

Override models with `GEMINI_MODEL`, `GROQ_MODEL`, `ANTHROPIC_MODEL`.

**Gemini is first because free-tier *shape* decides what is possible at volume.**
A single discovery run exhausted Groq's daily token allowance after about fifty
classification calls, while Gemini's constraint is requests per minute, which
pacing handles.

**Provider choice moves yield, not correctness.** A weaker model produces more
quotes it cannot back up, and those get discarded. You lose coverage, never
truth. That is what makes a free-tier default defensible, and why `--escalate`
— retry whatever came back empty on the next provider — is the right way to
spend money: only on the pages that need it.

Two provider-specific traps worth knowing:

- **Gemini's `responseSchema` is an OpenAPI subset, not JSON Schema.**
  Nullability is a `nullable: true` flag rather than `anyOf: [T, null]`, and
  `additionalProperties` is rejected. Left unconverted, every "the page does not
  say" field becomes unrepresentable — the one answer this pipeline most needs
  the model to be able to give. `scripts/extract/json-schema.ts` handles it.
- **On a rate-limited tier the binding constraint is tokens per *minute*, not
  the context window**, and Groq counts reserved output against it. Set
  `GROQ_TPM` to match your tier (console → Limits) or you will either see 429s
  or waste context.

**Escalation only works if the prompt is cut to the *escalation target's*
budget.** Passage selection is per-provider (`passagesFor()` in
`programme.ts`), memoised per call. Selecting once against the primary's budget
meant every escalated call carried a prompt cut for Gemini's 100k characters
into Groq's 12k-tokens-per-minute tier and died with `a single request needs
~13,491 tokens but the limit is 12,000 TPM` — escalation configured, attempted,
and physically unable to succeed.

**Groq's `llama-3.3-70b-versatile` rejects `json_schema` mode** and falls back to
plain `json_object`, so nothing constrains its output shape. One omitted
sub-object then made zod reject the whole response, discarding a complete,
correctly quoted profile. `repairCycle()` / `repairProfile()` in `extract.ts`
fill omitted fields with their "not answered" form, coerce an unusable
`confidence` to `low`, and drop coverage entries whose `covered` is null — the
model's way of saying what the schema asks it to express by omitting the entry.
Repairs may only ever discard information or fill in "not answered"; never a
value and never a quote. `page_is_about_requested_programme` defaults to
**false**, because a model that did not vouch for the page has not vouched for
the page. `extract.test.ts` parses an empty `{}` through both schemas, so adding
a schema field without adding it to the skeleton fails a test rather than
silently breaking escalation again.

## Tuning reference

| Flag | Script | Default | Effect |
| --- | --- | --- | --- |
| `--dry-run` | both | off | Crawl and extract, write nothing |
| `--limit` | extract | 50 | Max programmes per run |
| `--title` | extract | — | Match one programme by title |
| `--pages` | extract | 20 | Crawl size per programme |
| `--concurrency` | extract | 3 | Programmes crawled at once |
| `--dates-only` | extract | off | Skip the profile call |
| `--escalate` | extract | off | Retry on the next provider — cycle (empty **or no closing date**), profile, second look |
| `--force` | extract | off | Re-read rows that are unchanged or already pending |
| `--verify` | extract | off | Cross-check dates against other sources, **and fill profile gaps from them** |
| `--verify-sources` | extract | 2 | Other sources read per programme |
| `--no-gap-fill` | extract | off | Skip the third call at the fields still empty |
| `--no-gap-crawl` | extract | off | Never crawl again for a topic nothing was fetched about |
| `--gap-crawl-pages` | extract | 8 | Pages the second crawl may fetch |
| `--no-fix-urls` | extract | off | Find a moved page, but do not re-point the row |
| `--models` | extract | — | List models your key can reach |
| `--seed` | discover | — | Match seeds by label |
| `--per-seed` | discover | 20 | Programmes classified per seed |
| `--max-listing` | discover | 8 | Listing pages followed per seed |
| `--seed-concurrency` | discover | 3 | Seeds crawled at once |
| `--min` | discover | `low` | Minimum confidence to stage |
| `--provider` | both | auto | Force a provider |

Environment knobs for the fetch layer, all optional:

| Variable | Default | Effect |
| --- | --- | --- |
| `CRAWL_DELAY_MS` | 800 | Minimum gap between request starts to one host |
| `CRAWL_HOST_CONCURRENCY` | 2 | Connections open to one host at once |
| `CRAWL_USER_AGENT` | ScholarTrackBot/1.0 | How we announce ourselves |
| `CRAWL_FALLBACK_USER_AGENT` | browser-shaped | Used only after a host refuses the first |
| `RENDER_SERVICE_URL` | unset | Headless renderer for pages no hydration payload rescues |
| `RENDER_SERVICE_TOKEN` | unset | Bearer token for the above |
| `OCR_SERVICE_URL` | unset | OCR engine for scanned PDFs; quotes from it are tiered `match: "ocr"` |
| `OCR_SERVICE_TOKEN` | unset | Bearer token for the above |

Both services are optional and both are a URL rather than a dependency — see
[Pages a plain fetch cannot read](#pages-a-plain-fetch-cannot-read). Neither is
a first resort: the free rungs of the ladder run before either is consulted.

### What a re-run costs

A run over programmes that have not changed is the common case, and it used to
be almost as expensive as the first one: the "unchanged" check ran **after** the
crawl, so three unchanged Chevening rows still fetched 61 pages and took just
under three minutes to announce there was no work to do.

The answer depends on exactly one page — the one the last proposal was read
from — so that is the only page fetched to find out. The same three rows now
take eleven seconds. A failure on that one page is neither a skip nor an error:
it falls through to the full crawl, which is where a dead URL gets diagnosed and
repaired.
