# Deployment

The app deploys to Vercel. **The crawlers do not deploy at all** — they run on a
developer machine against the same database.

## What goes where

| Piece | Runs on | Needs |
| --- | --- | --- |
| Next.js app | Vercel | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Database, auth | Supabase | migrations applied, anonymous sign-ins enabled |
| `npm run extract` / `discover` | Your machine | provider key + `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` |

## Environment variables

Only **two** variables belong in Vercel:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

Both are safe in the browser — the anon key is constrained by the RLS policies in
`supabase/schema.sql`.

**Do not add `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY` or
`ANTHROPIC_API_KEY` to the deployed environment.** Nothing under `src/` reads
them, and the pipeline route refuses to run on a serverless host regardless. The
service-role key bypasses every RLS policy in the schema, so putting it on a
public host adds real risk for zero function.

To confirm that claim yourself:

```bash
grep -rn "SERVICE_ROLE" src/
```

The only hit should be a comment.

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
- `/admin/pipeline` shows the "run locally" refusal (correct, not a bug)

## After deploying

The crawlers stay local. Run them from PyCharm's terminal:

```bash
npm run extract
```

They write to the same Supabase, so the live site picks up new data with no
redeploy.

## Things that will bite you

**One Supabase project, two environments.** If `.env.local` points at the same
project Vercel uses, running a crawler locally edits production data. `--dry-run`
and the review step are the safety net. A true staging environment means a second
Supabase project and a second set of Vercel variables.

**`maxDuration` and serverless timeouts.** Do not add a `maxDuration` export to
the pipeline route. Vercel validates it at *build* time against the plan ceiling
(60s on Hobby), so a value long enough to be useful fails the deployment
outright — and it would buy nothing, since that route refuses to run on
serverless anyway.

**Filesystem access in route handlers.** `src/app/api/admin/pipeline/route.ts`
resolves paths against `process.cwd()`, which tells the bundler's file tracer the
route might read anything in the project — so it traces the whole repo,
`node_modules` included, into the deployment bundle. The `path.join()` calls
there carry `/*turbopackIgnore: true*/` for that reason. If you add another one,
annotate it, and watch the build output for *"Encountered unexpected file in NFT
list"*.

**Node version.** `package.json` declares no `engines` field; Vercel's default is
fine for the app. The scripts rely on Node's TypeScript stripping (22.6+) but
never run on Vercel, so this only matters locally.
