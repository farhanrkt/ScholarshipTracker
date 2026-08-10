# Deployment

The app deploys to Vercel, and **the pipeline now deploys with it**. Running a
crawl from `/admin/pipeline` works the same on your laptop and on the deployed
site.

It did not always. The old runner spawned `node scripts/extract/run.ts` and
refused to start on a serverless host, because there is no repo to spawn from,
the filesystem is read-only, and the function is killed in seconds while a crawl
takes minutes. The way through was not a longer timeout — it was to stop
treating a run as a process.

## How a run survives a serverless host

A run is a **row**, not a process:

1. Starting one writes a `pipeline_jobs` row: the arguments, and the fixed list
   of units to work through (programmes for extract, seeds for discover).
2. `POST /api/admin/pipeline/tick` claims that job, works until its time budget
   runs out, saves the cursor and the log, and returns.
3. The console calls `tick` again. And again, until the job says `done`.

Everything follows from that. Close the tab and the run keeps its place; reopen
the page and it re-attaches and carries on. A redeploy mid-run costs you the
unit in flight, not the run. Two tabs cannot double-crawl a site, because
`claim_pipeline_tick` hands the job to one worker at a time — and a worker that
dies is reclaimed after its heartbeat goes stale.

## What goes where

| Piece | Runs on | Needs |
| --- | --- | --- |
| Next.js app | Vercel | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Database, auth | Supabase | migrations applied (including **012**), anonymous sign-ins enabled |
| Pipeline, from the browser | Vercel | a provider key — `GEMINI_API_KEY` or `GROQ_API_KEY` |
| `npm run extract` / `discover` | Your machine | provider key + `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` |

## Environment variables

```
NEXT_PUBLIC_SUPABASE_URL          required
NEXT_PUBLIC_SUPABASE_ANON_KEY     required
GEMINI_API_KEY                    only to run the pipeline from the deployed app
CRON_SECRET                       only for the weekly refresh — see below
CRON_SUPABASE_EMAIL               only for the weekly refresh — see below
CRON_SUPABASE_PASSWORD            only for the weekly refresh — see below
```

The two `NEXT_PUBLIC_` values are safe in the browser — the anon key is
constrained by the RLS policies in `supabase/schema.sql`. The provider key is
**not** public: it is read only inside a Route Handler, never prefixed
`NEXT_PUBLIC_`, and never sent to the client.

### The service-role key still does not belong here

**Do not add `SUPABASE_SERVICE_ROLE_KEY` to Vercel.** It bypasses every RLS
policy in the schema, and the deployed pipeline does not need it: migration 012
gives admins `INSERT` on the staging tables, so the runner writes **as the
signed-in admin**, through the same policies the review UI uses. A non-admin
hitting those routes gets a 403 from the gate and nothing from Postgres.

That is a better arrangement than the scripts have. The CLI still uses the
service-role key because it runs as nobody, but the deployed path is
authenticated end to end.

To confirm the claim yourself:

```bash
grep -rn "SERVICE_ROLE" src/
```

The only hits should be comments.

### The weekly refresh, and what it runs as

`vercel.json` calls `/api/cron/refresh` every Monday at 06:00 UTC to re-read the
rows that have gone out of date. It needs three values, and **none of them is the
service-role key**:

| Variable | Why |
| --- | --- |
| `CRON_SECRET` | Vercel Cron sends it as `Authorization: Bearer …`. Without it the endpoint refuses every request — it spends a model quota and fetches other people's servers, so it fails closed |
| `CRON_SUPABASE_EMAIL` | A Supabase account you have added to the `admins` table |
| `CRON_SUPABASE_PASSWORD` | That account's password |

The route signs in with the anon key exactly as a browser would, so RLS checks
every write it makes and the run is attributable in `pipeline_jobs.created_by`.
Revoking it is deleting one row from `admins`, not rotating a key that bypasses
the whole schema. Create the account through the normal sign-in flow, then:

```sql
insert into admins (email, note) values ('refresh@yourdomain', 'scheduled refresh');
```

It **stages** proposals like any other run. Nothing reaches a scholarship row
without a human applying it in `/admin/review`.

### Optional, for tuning a deployed run

| Variable | Default | Why you might set it |
| --- | --- | --- |
| `PIPELINE_PROVIDER` | first key present | Force `gemini`, `groq`, or `anthropic` |
| `PIPELINE_TICK_MS` | 210000 | Work per tick. Must stay below the function ceiling |
| `PIPELINE_BATCH` | 3 | Units started together inside one tick |
| `GEMINI_TIMEOUT_MS` | 90000 on the server | A model call must not outlive the function |

**If a deploy fails with a maxDuration error**, your plan's function ceiling is
below the 300s that `api/admin/pipeline/tick/route.ts` asks for. Lower
`maxDuration` in that file and `PIPELINE_TICK_MS` to match — the run simply
takes more ticks. Nothing else changes.

## First deploy

### 1. Prepare the repository

Check that `.env.local` is ignored before the first commit:

```bash
git check-ignore -v .env.local
```

It should report a match against `.env*`. If it prints nothing, stop and fix
`.gitignore` — a service-role key in git history is a credential rotation, not a
revert.

Commit and push to GitHub. In PyCharm: **⌘K** to commit, **⌘⇧K** to push.

### 2. Supabase

Run the SQL in `supabase/` in order — see
[data-model.md § Migrations](data-model.md#migrations). Note that
`000_apply_all_pending.sql` predates 005–007; run those after it.

Enable anonymous sign-ins: **Authentication → Sign In / Providers → Allow
anonymous sign-ins**. Nothing works without this — it is what mints the ghost
account that lets someone track a scholarship on their first click.

Add yourself to the admin allowlist:

```sql
insert into admins (email, note) values ('you@example.com', 'founder');
```

### 3. Vercel

[vercel.com/new](https://vercel.com/new) → import the repository. The Next.js
preset is detected automatically; root directory stays `./`. Add the two
environment variables above, then deploy.

### 4. Auth redirect URLs — do this before testing sign-in

**Supabase Dashboard → Authentication → URL Configuration:**

- **Site URL**: `https://<your-app>.vercel.app`
- **Redirect URLs**, all four:
  - `https://<your-app>.vercel.app/auth/confirm`
  - `https://<your-app>.vercel.app/auth/callback`
  - `http://localhost:3000/auth/confirm`
  - `http://localhost:3000/auth/callback`

`emailRedirectTo` is built from the request origin, and Supabase silently drops
origins that are not allowlisted. Skip this and sign-in appears broken in
production for reasons nothing logs. Keep the localhost entries or you break
local development.

### 5. Smoke test

- Dashboard loads and filters work
- A card opens its detail sheet
- A sign-in email link lands you actually signed in — the header should show
  your address, not a "Sign in" button
- `/admin/pipeline` lets you start a **dry run** and shows its log advancing

## After deploying

Run the pipeline from wherever suits the job.

**From the deployed app** — `/admin/pipeline`, dry run first. Best for a few
programmes or one seed: it needs nothing installed, and the run survives you
closing the tab.

**From a terminal** — best for a full sweep. No function ceiling, so no ticking,
and the whole run is one log:

```bash
npm run extract
```

Both write to the same Supabase and use the same crawler code, so the live site
picks up new data with no redeploy. The only difference is who the writes are
made as: the deployed path writes as the signed-in admin under RLS, the CLI with
the service-role key.

## Things that will bite you

**`maxDuration` is validated at build time.** `tick/route.ts` asks for 300s.
Vercel checks that against your plan's ceiling when it builds, so on a plan that
allows less the DEPLOY fails — not the run. Lower it, and lower
`PIPELINE_TICK_MS` with it so a tick still finishes its unit before the host
pulls the plug. The run just takes more ticks.

**A tick that is killed loses its unit, not the run.** The cursor only advances
when a batch completes, so a killed tick re-does that batch. That is why the
budget (210s) sits well below the ceiling (300s): the gap is room for a unit
that started late to finish.

**One Supabase project, two environments.** If `.env.local` points at the same
project Vercel uses, a local crawl edits production data — and now so does a run
started from the deployed console, which is easier to do by accident. Dry run is
the default in the UI for exactly this reason, and the review step is the second
net. A true staging environment means a second Supabase project and a second set
of Vercel variables.

**Node version.** `package.json` declares no `engines` field. The CLI relies on
Node's TypeScript stripping (22.6+); on Vercel the same modules are bundled by
Turbopack instead, so the app is not subject to that floor.
