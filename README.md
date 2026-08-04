# ScholarTrack

A zero-cost dashboard for finding, filtering and tracking fully-funded
international scholarships.

The point of difference is **granular, structured data**. Programme details live
in JSONB columns rather than prose, so the sidebar can answer questions a wall
of text cannot — _"scholarships in Japan that need no work experience and
include a funded language year"_ is a filter, not a reading exercise.

Data comes from a crawler that reads each funder's own site and is only allowed
to record what it can quote. Everything it produces is a **proposal a human
applies**, never a fact.

## Stack

| Layer     | Choice                                              |
| --------- | --------------------------------------------------- |
| Framework | Next.js 16 (App Router, React 19, Server Components) |
| Styling   | Tailwind CSS v4 + shadcn/ui (Base UI) + Lucide       |
| Backend   | Supabase (PostgreSQL + RLS)                          |
| Auth      | Supabase anonymous auth — no sign-up wall            |
| Language  | TypeScript, `strict` mode                            |
| Deploy    | Vercel (app) + your machine (crawlers)               |

## Documentation

Full docs live in [`docs/`](docs/README.md).

| Page | Covers |
| --- | --- |
| [architecture.md](docs/architecture.md) | Rendering, auth, filtering, mutations, RLS |
| [data-model.md](docs/data-model.md) | Tables, JSONB shapes, trust tiers, migrations |
| [pipeline.md](docs/pipeline.md) | Discovery, crawling, extraction, grounding, providers |
| [operations.md](docs/operations.md) | Running the crawlers, reviewing, verifying, seeds |
| [deployment.md](docs/deployment.md) | Vercel + Supabase setup |
| [testing.md](docs/testing.md) | What has tests, and why those things |
| [troubleshooting.md](docs/troubleshooting.md) | Symptoms and their causes |

## Getting started

**1. Create a Supabase project** and run the SQL from the SQL editor in this
order:

```
supabase/schema.sql
supabase/migrations/001_application_window_and_provenance.sql
supabase/migrations/002_ai_extraction.sql
supabase/migrations/003_admin_review.sql
supabase/migrations/004_discovery.sql
supabase/migrations/005_fix_admin_lookup.sql
supabase/migrations/006_extraction_caveats.sql
supabase/migrations/007_deep_extraction.sql
supabase/migrations/008_normalise_countries.sql
supabase/migrations/009_is_profiled.sql
supabase/seed.sql
```

`000_apply_all_pending.sql` bundles 002–004 for a fresh project, but predates
005–009 — run those after it. Details in
[data-model.md](docs/data-model.md#migrations).

**2. Enable anonymous sign-ins**: Authentication → Sign In / Providers → **Allow
anonymous sign-ins**. Nothing works without this; it is what mints the ghost
account.

**3. Add yourself as an admin** to reach the review pages:

```sql
insert into admins (email, note) values ('you@example.com', 'founder');
```

**4. Configure:**

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
Project Settings → API Keys. For the crawlers, add a provider key (Gemini is the
default) and `SUPABASE_SERVICE_ROLE_KEY`. That key bypasses every RLS policy —
it is used only by `scripts/`, never prefixed `NEXT_PUBLIC_`, and never imported
by anything under `src/`.

**5. Run:**

```bash
npm run dev
```

## Scripts

```bash
npm run dev              # dev server
npm run build            # production build
npm run start            # serve the production build
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm test                 # node --test (no dependencies)
npm run check            # typecheck + lint + test
npm run extract          # crawl programmes: dates, coverage, eligibility, documents
npm run discover         # find programmes we have no row for
npm run discover:verify  # check the seed list still yields programmes
```

Both crawlers take `--dry-run`. Use it first. Full flag reference in
[pipeline.md](docs/pipeline.md#tuning-reference).

## Data accuracy

The rule the whole design follows: **a blank field beats a plausible wrong one.**

An earlier version reconstructed deadlines from each programme's typical cycle
and got Chevening wrong by a month. A scholarship deadline is a date someone
plans a year of their life around, so:

- **Dates are nullable.** No deadline renders as "Dates not published".
- **Every extracted value carries a verbatim quote**, checked against the fetched
  page. Values whose quote is not found are discarded — fabrication is caught by
  string search, not by someone reading output and hoping.
- **Numbers must appear in their own quote.** A grounded "includes a monthly
  stipend" does not license an invented amount beside it.
- **Absent is not false.** An unstated requirement shows as "Not stated", never
  "Not required".
- **Provenance is never defaulted.** `last_verified_at` is NULL until a human
  checks, and the UI says "Not verified" out loud.

The full trust model is in [pipeline.md § Grounding](docs/pipeline.md#grounding--the-control-everything-else-rests-on).

## Layout

```
src/
├── proxy.ts                     # anonymous auth + session refresh
├── app/
│   ├── actions/                 # Server Actions (auth, targets, review)
│   ├── admin/pipeline/          # run the crawlers, stream their logs
│   ├── api/admin/pipeline/      # spawns the scripts (local dev only)
│   ├── auth/confirm/            # email-link landing page (fragment flow)
│   ├── auth/callback/route.ts   # redeems ?code / ?token_hash — sets cookies
│   ├── dashboard/               # discovery + filters
│   └── my-tracker/              # tracked applications + checklists
├── components/
│   ├── admin/                   # gate, candidate + extraction cards, console
│   ├── filters/                 # sidebar rail + mobile sheet
│   ├── scholarship/             # card, detail sheet, coverage grid, timeline
│   ├── tracker/                 # optimistic checklist card
│   └── ui/                      # shadcn primitives
└── lib/
    ├── data/                    # server-side queries
    ├── pipeline/                # job whitelist for the runner
    ├── supabase/                # browser / server / session / account
    └── types/                   # strict schema + action types
scripts/
├── discover/                    # seeds, link scoring, pagination, classify
└── extract/                     # crawl, passages, schemas, grounding, providers
supabase/
├── schema.sql
├── migrations/
└── seed.sql
docs/
```
