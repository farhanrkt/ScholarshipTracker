# ScholarTrack

A zero-cost dashboard for finding, filtering and tracking fully-funded
international scholarships.

The point of difference is **granular, structured data**. Programme details live
in JSONB columns rather than prose, so the sidebar can answer questions a wall
of text cannot — _"scholarships in Japan that need no work experience and
include a funded language year"_ is a filter, not a reading exercise.

## Stack

| Layer     | Choice                                              |
| --------- | --------------------------------------------------- |
| Framework | Next.js 16 (App Router, React 19, Server Components) |
| Styling   | Tailwind CSS v4 + shadcn/ui (Base UI) + Lucide       |
| Backend   | Supabase (PostgreSQL + RLS)                          |
| Auth      | Supabase anonymous auth — no sign-up wall            |
| Language  | TypeScript, `strict` mode                            |
| Deploy    | Vercel                                               |

## Getting started

**1. Create a Supabase project**, then run the SQL in order from the Supabase
SQL editor:

- `supabase/schema.sql` — tables, indexes, `updated_at` trigger, RLS policies
- `supabase/migrations/002_ai_extraction.sql` — extraction staging + the third trust tier
- `supabase/migrations/003_admin_review.sql` — admin allowlist and review policies
- `supabase/migrations/004_discovery.sql` — discovery staging
- `supabase/migrations/005_fix_admin_lookup.sql` — admin lookup fix
- `supabase/migrations/006_extraction_caveats.sql` — kept-but-qualified values
- `supabase/migrations/007_deep_extraction.sql` — apply coverage, eligibility and documents, not just dates
- `supabase/seed.sql` — 10 real programmes across the six target countries

Already have a project from before the provenance work? Run
`supabase/migrations/001_application_window_and_provenance.sql` first instead of
re-running `schema.sql`, then the rest in order, then re-run `seed.sql`.

To use the review pages, add yourself to the allowlist and sign in with that
address:

```sql
insert into admins (email, note) values ('you@example.com', 'founder');
```

**2. Enable anonymous sign-ins**: Supabase Dashboard → Authentication →
Sign In / Providers → toggle **Allow anonymous sign-ins**. Nothing works
without this — it is what mints the ghost account.

**3. Configure the app:**

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
Project Settings → API Keys.

**4. Run it:**

```bash
npm run dev
```

## How it fits together

### Ghost accounts

`src/proxy.ts` runs on every request. It refreshes the Supabase session and, if
there is none, calls `signInAnonymously()`. The visitor gets a real JWT and a
stable UUID before the first Server Component renders, so "Track this
scholarship" works on the very first click.

`AnonymousBanner` renders only while `user.is_anonymous` is true. Linking an
email calls `auth.updateUser({ email })`, which **preserves the UUID** — every
tracked scholarship and ticked checkbox survives the upgrade.

### Where an email link is redeemed, and why it is split in two

`src/app/auth/confirm/page.tsx` is the only URL an email ever names, but it
finishes only one of the three shapes Supabase sends. Query-string credentials
(`?code=`, `?token_hash=`) are forwarded to `src/app/auth/callback/route.ts`;
the fragment shape (`#access_token=`) is completed in the browser, because a
fragment is never sent to the server at all.

**A Server Component cannot persist a session.** Next.js only honours
`cookies().set()` in Server Functions and Route Handlers, and our server client
swallows the failure on purpose — a dropped session *refresh* is harmless
because the proxy redoes it next request. A dropped sign-in *exchange* is not:
that session exists nowhere else. Doing the exchange in the page therefore
looked like it worked, discarded the cookies, redirected with `?linked=ok`, and
let the proxy mint a fresh anonymous ghost — the app told people they were
signed in while they were not, with no error anywhere. The route handler fixes
the cause, and it re-reads the session before claiming success rather than
trusting the exchange.

For the same reason nothing in the UI decides "signed in" from a URL any more.
`src/lib/supabase/account.ts` is the single answer to that question — a real
user that is not the ghost — and the header, the banner and `/my-tracker` all
ask it, so they cannot contradict each other on the same screen.

### Filtering

`src/lib/filters.ts` owns the URL contract; `src/lib/data/scholarships.ts`
translates it into PostgREST filters. Adding a facet is a two-line change: one
entry in `TOGGLE_DEFINITIONS`, one in `TOGGLE_PREDICATES`.

Every JSONB predicate uses `->>` rather than `->`. `->>` returns SQL `NULL` both
when a key is absent and when its value is JSON `null` — which is exactly the
"not required / not stated" semantics the UI promises. `->` returns the jsonb
literal `null`, which is not SQL `NULL` and would silently break `is.null`.

All filter state lives in the URL, so any view is shareable and the back button
behaves.

### Mutations

Server Actions only — no `/api` routes except the auth confirmation callback,
which has to exist because Supabase redirects a browser to it.

Every action returns `{ success, data?, error? }` (`ActionResult<T>` in
`src/lib/types/actions.ts`) and never throws across the boundary.

The tracker checklist uses `useOptimistic`, so a tick lands instantly and
reconciles when `revalidatePath` returns.

### Security

RLS is enabled on both tables and is the only thing standing between the public
anon key and your data:

- `scholarships` — readable by everyone, writable by nobody through the API
- `user_targets` — every policy is `auth.uid() = user_id`

Anonymous users hold real JWTs, so they are covered by the `authenticated` role
exactly like email users.

## Data accuracy

This is the part the product lives or dies on, so it has explicit rules.

**A blank field beats a plausible wrong one.** Dates are nullable. A row with no
deadline renders as "Dates not published" — it never invents one. An earlier
version reconstructed deadlines from each programme's typical cycle and got
Chevening wrong by a month, which is exactly the failure this design prevents.

**Provenance is never defaulted.** `last_verified_at` has no `DEFAULT NOW()`; a
row nobody has checked reads NULL and the UI says "Not verified" out loud.
`source_url` holds the specific timeline page the dates were read from, not the
homepage, so the next person can re-check the same thing.

**Staleness is derived, never stored.** A stored flag goes wrong the moment
nobody updates it. `describeVerification()` computes it from the verification
date and the deadline: past its deadline means the cycle has rolled over; more
than 90 days unchecked means "may be out of date".

**The worklist is a query:**

```sql
select * from scholarships_needing_review;
```

Everything unverified, stale, or past its deadline, with the URL to check and
the reason it surfaced.

### AI-assisted extraction

`npm run extract` crawls a programme's own site, has a model read the
application cycle **and** the programme profile off it, and stages the result
for review. **The output is a proposal, never a fact.**

```bash
npm run extract -- --dry-run
```

### Why it crawls rather than fetching one page

A scholarship's details are never on the page you have a URL for. Chevening
publishes eligibility on `/who-can-apply/`, the deadline on
`/application-timeline/`, and what the money covers somewhere else again — a
single-page fetch of any one of them misses the other two.

So the pipeline runs a small crawl (default 16 pages, depth 2, same origin
only) with **per-topic quotas**: dates, eligibility, benefits, documents and
process each get a reserved allocation, and only leftover budget is competed
for. A single ranked queue does not work here, because it is won outright by
whichever topic has the loudest vocabulary — an earlier date-only scorer spent
the whole budget on date pages and never fetched `/benefits` at all, which is
why extracted rows had a deadline and nothing else.

Then it scores passages per topic and sends only the dense ones. **Keyword
scoring, not embeddings**: at sixteen pages you know exactly which words you're
hunting for, so a keyword score is exact, free, instant and debuggable, where
embeddings would add a provider, a vector store, and a retrieval failure mode.

### Two calls, one crawl

The crawl is shared; the extraction is not. One call reads the application
cycle, a second reads coverage, eligibility and the document checklist. That is
an output-budget decision, not a tidiness one: a single response carrying all of
it — each value with its own verbatim quote — overruns the token ceiling of the
free-tier providers this runs on, and a truncated response loses the dates too.
Split, a failed profile call still leaves you the deadline. `--dates-only` skips
the second call.

Grounding then runs against the **full text of every crawled page**, not the
trimmed selection — so budgeting can never turn a real quote into a rejected
one. It also records *which* page contained each quote, and that page becomes
the row's `source_url`. The system derives the right source page instead of
trusting the one it started from.

The control that makes this safe is **grounding**. The model must return a
verbatim `evidence_quote` alongside every value it extracts. After it responds,
the pipeline searches the fetched page text for each quote and **discards any
value whose quote is not found**. A hallucinated deadline comes with a
hallucinated quote, and a hallucinated quote is not on the page — so fabrication
is caught by string search, not by someone reading the output and hoping.

Paraphrases fail too: the quote has to be the page's own words. Quotes under
eight characters are rejected (`"2026"` matches almost any page by accident),
and a value that isn't a real ISO date is dropped no matter what backs it.

The same rule applies to money and requirements, with a numeric check on top: a
stipend figure, a GPA minimum or an age cap is kept only if that **number**
appears in the quote backing it. A grounded sentence saying the award "includes
a monthly stipend" does not license an invented amount printed next to it, and
a plausible figure nobody published sends a student abroad on a budget that does
not exist. Booleans are three-valued throughout — absent is not false, and the
UI renders an unstated requirement as "Not stated" rather than "Not required".

Everything lands in `scholarship_extractions`, which is RLS deny-all — the app
cannot read it. A human promotes a row:

```sql
select * from extraction_review;              -- proposals + their evidence
select apply_extraction('<extraction_id>');   -- promote to ai_extracted
select reject_extraction('<extraction_id>', 'wrong cycle');
```

Applying lands the row at **`ai_extracted`**, not `verified` — quote-backed but
unconfirmed, and the UI labels it that way. Only a person who has opened the
portal sets `verified`. The script never touches rows that are already
`verified`.

Two other guards: the model reports what the site is actually about (catching
redirects and 404s), and pages that render their dates in JavaScript produce too
little text to extract, so they fail loudly rather than silently returning
nothing.

Crawl size is tunable per run — `--pages 20` for a sprawling site, `--pages 3`
to keep a run cheap. The crawler respects `robots.txt`, sends a descriptive
user-agent, fetches one page at a time with a 1.5s gap, and skips PDFs and
other binaries.

Requires `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.
The service-role key bypasses every RLS policy — it is used only by this script,
never prefixed `NEXT_PUBLIC_`, and never imported by anything under `src/`.

### Running both from the browser

`/admin/pipeline` runs either crawler with a button and streams its output to
the page as it works. It spawns the same scripts, on the machine serving the
page — which means local development, where the repo and `.env.local` are on
disk. A deployed serverless instance has neither, so the runner returns a clear
refusal there instead of failing halfway through a crawl.

The log is the point. These runs take minutes and spend a rate-limited quota; a
spinner cannot tell you a slow crawl from a stuck one, while the scripts already
print pages fetched per topic, what grounding discarded, and why.

Two constraints worth knowing: one run at a time process-wide (concurrent crawls
fight over the same per-minute quota), and the argument list is built from a
fixed whitelist — the script is chosen from a map, every flag is a literal, and
free-text filters are pattern-matched before they go anywhere near `spawn`,
which is called without a shell. An admin session should not be a way to run
commands on your laptop.

### Discovery

`npm run discover` finds programmes there is no row for yet. It expands the seed
index pages in [scripts/discover/seeds.ts](scripts/discover/seeds.ts), scores
outbound links for programme shape, and has the cheap model classify each one.

```bash
npm run discover -- --dry-run
npm run discover:verify              # re-check every seed still yields programmes
```

**Two levels, not one.** A seed is first expanded into its pagination and its
sub-listings, and only then are the programme-shaped links classified. Reading
each seed exactly once — the earlier behaviour — made page 2 of every portal and
every "PhD scholarships A–Z" sub-index invisible, which was the real ceiling on
how many programmes a run could find, not the classifier. A page the prefilter
or the model calls a listing rather than a programme is now expanded for its
links instead of discarded; it has already been fetched, so that costs nothing.

`--per-seed` caps programmes classified per seed, `--max-listing` caps the
listing pages followed to get to them.

**Discovery never writes dates.** Promoting a candidate creates a dateless,
`unverified` skeleton; extraction fills the cycle in afterwards, with quotes
attached. That is why there is no grounding check at this stage — classification
is a judgement, not a fact copied off a page, and a wrong one costs a wasted
fetch rather than a wrong date on someone's calendar.

The seed list is the single biggest lever on what the database contains, so
curate it — and verify before committing: `npm run discover:verify -- <url>`
fetches a candidate and counts its programme-shaped links with the crawler's own
scorer, so a seed is measured the way it will actually be crawled. Under five
links is not worth a slot.

Expect failures while curating. Four kinds have already been hit and are
recorded in `BLOCKED_SEEDS` with the reason: origins that reject non-browser
clients (`403`/`412`), listings whose links only exist after JavaScript runs,
URLs that have simply moved, and pages that look like an index but describe a
single programme. China is the hardest region to seed for the first two reasons.

Review at `/admin/candidates`.

### Model providers

The pipeline is provider-agnostic — [scripts/extract/providers/](scripts/extract/providers/)
is the only Anthropic-specific code left.

| Provider | Env | Free tier shape |
|---|---|---|
| Gemini (default) | `GEMINI_API_KEY` | request-bound (~15 RPM), 1M context |
| Groq | `GROQ_API_KEY` | 12k tokens/min + a daily cap |
| Claude | `ANTHROPIC_API_KEY` | paid, no rate squeeze |

Whichever key is set wins, in that order; `--provider gemini|groq|anthropic`
overrides. **Gemini is first because free-tier shape decides what is possible at
volume**: a single discovery run exhausted Groq's daily token allowance after
about fifty classification calls, while Gemini's constraint is requests per
minute, which pacing handles.

Each provider converts the schema to its own dialect — Gemini's `responseSchema`
is an OpenAPI subset where nullability is a `nullable: true` flag rather than
`anyOf: [T, null]`, and `additionalProperties` is rejected outright. Left
unconverted, every "the page does not say" field becomes unrepresentable, which
is the one answer this pipeline most needs the model to be able to give.

**On a rate-limited tier, the binding constraint is tokens per *minute*, not the
context window** — and Groq counts reserved output against it, so an oversized
`max_completion_tokens` can exhaust the budget before a character of the page is
read. Each provider therefore declares a `promptBudgetChars`, derived from
`GROQ_TPM` at 85% for headroom, and passage selection is sized from that rather
than a constant. A sliding-window limiter paces calls across the minute, and
429s are retried using the server's own hint. Set `GROQ_TPM` to match your tier
(console → Limits) or you will either see 429s or waste context.

```bash
npm run extract -- --provider anthropic   # force one
npm run extract -- --escalate             # retry empties on the other
npm run extract -- --models               # list models your Groq key can reach
```

Groq is the default because **grounding makes model quality a yield question,
not a correctness one**. A weaker model produces more quotes it cannot back up;
those get discarded. You lose coverage, never truth. `--escalate` retries
whatever came back empty on the stronger model, so you pay frontier prices only
for the pages that need it.

### Verifying a row

Open its official timeline page, read the real dates, then fill in `opens_date`,
`deadline_date`, `cycle_label`, `timeline`, `source_url` and `last_verified_at`,
and set `verification_status = 'verified'`. The Chevening block at the bottom of
[supabase/seed.sql](supabase/seed.sql) is the worked example.

All seed rows ship as `unverified` with no dates. The programmes, coverage and
document lists are structurally accurate and change slowly; the dates change
every cycle and must be sourced by a human.

## Scripts

```bash
npm run dev        # dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run extract          # fill in dates, coverage, eligibility and documents
npm run discover         # find programmes we have no row for
npm run discover:verify  # check the seed list still yields programmes
```

## Layout

```
src/
├── proxy.ts                     # anonymous auth + session refresh
├── app/
│   ├── actions/                 # Server Actions (auth, targets)
│   ├── admin/pipeline/          # run the crawlers, stream their logs
│   ├── api/admin/pipeline/      # spawns the scripts (local dev only)
│   ├── auth/confirm/            # email-link landing page (fragment flow)
│   ├── auth/callback/route.ts   # redeems ?code / ?token_hash — sets cookies
│   ├── dashboard/               # discovery + filters
│   └── my-tracker/              # tracked applications + checklists
├── components/
│   ├── filters/                 # sidebar rail + mobile sheet
│   ├── scholarship/             # card, detail sheet, coverage grid
│   ├── tracker/                 # optimistic checklist card
│   └── ui/                      # shadcn primitives
└── lib/
    ├── data/                    # server-side queries
    ├── supabase/                # browser / server / session clients
    └── types/                   # strict schema + action types
supabase/
├── schema.sql
└── seed.sql
```
