# Architecture

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, React 19, Server Components) |
| Styling | Tailwind CSS v4 + shadcn/ui (Base UI) + Lucide |
| Backend | Supabase (PostgreSQL + RLS) |
| Auth | Supabase anonymous auth — no sign-up wall |
| Language | TypeScript, `strict` mode |
| Deploy | Vercel (app) + local machine (crawlers) |

The app is two programs that share one database:

- **The web app** (`src/`) reads scholarships and writes only a user's own
  tracking rows. It never holds a privileged key.
- **The pipeline** (`scripts/`) crawls funder websites and writes proposals into
  staging tables using the service-role key. It runs on a developer machine, not
  on the deployed host. See [pipeline.md](pipeline.md).

Nothing the pipeline produces is visible in the app until a human applies it.

## Request lifecycle

```
request
  → src/proxy.ts            refresh session; mint a ghost account if there is none
  → Server Component        reads via the anon key, constrained by RLS
  → rendered HTML
```

`src/proxy.ts` runs on every request. It refreshes the Supabase session and, if
there is none, calls `signInAnonymously()`. The visitor gets a real JWT and a
stable UUID before the first Server Component renders, so "Track this
scholarship" works on the very first click with no login wall in between.

The one exception is `/auth/*`, where minting a ghost would break the thing the
user is doing — see below.

## Accounts

### Ghost accounts

Anonymous users hold real JWTs, so RLS covers them under the `authenticated`
role exactly like email users. There is no second code path for "logged out".

`AnonymousBanner` renders only while `user.is_anonymous` is true. Linking an
email calls `auth.updateUser({ email })`, which **preserves the UUID** — every
tracked scholarship and ticked checkbox survives the upgrade.

Sign-out is deliberately not offered to anonymous users: their tracker is only
reachable through that session, so signing out would destroy it with no way
back.

### Redeeming an email link, and why it is split in two

Supabase delivers the credential in one of three shapes depending on the
project's email template and flow type:

| Shape | Handled by | Why there |
| --- | --- | --- |
| `?code=…` (PKCE) | `src/app/auth/callback/route.ts` | Cookie writes must survive. |
| `?token_hash=…&type=…` | `src/app/auth/callback/route.ts` | Same. |
| `#access_token=…` (implicit) | `src/components/auth/confirm-fragment.tsx` | A fragment is never sent to the server. |

`src/app/auth/confirm/page.tsx` is the only URL an email ever names. It forwards
the two query-string shapes to the route handler and completes the fragment
shape in the browser.

**A Server Component cannot persist a session.** Next.js only honours
`cookies().set()` in Server Functions and Route Handlers. Our server client
swallows that failure on purpose, and for session *refreshes* that is correct —
the proxy redoes them on the next request. For a sign-in *exchange* it is not:
that session exists nowhere else.

This produced a bug worth remembering, because it was completely silent. The
exchange ran in the page, appeared to succeed, had its cookies discarded,
redirected with `?linked=ok`, and let the proxy mint a fresh ghost. The app then
told people they were signed in while they were not — no error, no log, nothing
to grep for.

Two changes prevent the whole class:

1. The exchange happens in a Route Handler, and that handler **re-reads the
   session before claiming success**. If the cookies did not stick, or the user
   comes back still anonymous, it redirects to sign-in with the reason.
2. **Nothing in the UI decides "signed in" from a URL.**
   `src/lib/supabase/account.ts` is the single answer to that question — a real
   user that is not the ghost — and the header, the banner and `/my-tracker` all
   ask it. Before this, three components each had their own `getUser()` call and
   their own idea of the answer, which is how one screen managed to show a
   "You are signed in" banner next to a "Sign in" button.

## Filtering

`src/lib/filters.ts` owns the URL contract; `src/lib/data/scholarships.ts`
translates it into PostgREST filters. Adding a facet is a two-line change: one
entry in `TOGGLE_DEFINITIONS`, one in `TOGGLE_PREDICATES`.

All filter state lives in the URL, so any view is shareable and the back button
behaves.

**Every JSONB predicate uses `->>` rather than `->`.** `->>` returns SQL `NULL`
both when a key is absent and when its value is JSON `null` — exactly the
"not required / not stated" semantics the UI promises. `->` returns the jsonb
literal `null`, which is not SQL `NULL` and would silently break `is.null`.

## Mutations

Server Actions only. The two `/api` routes that exist are there because
something outside React has to reach them: the auth callback (a browser
redirect) and the pipeline runner (a streaming response).

Every action returns `{ success, data?, error? }` (`ActionResult<T>` in
`src/lib/types/actions.ts`) and never throws across the boundary.

The tracker checklist uses `useOptimistic`, so a tick lands instantly and
reconciles when `revalidatePath` returns.

## Security

RLS is enabled on every table and is the only thing standing between the public
anon key and the data.

| Table | Anon / authenticated |
| --- | --- |
| `scholarships` | readable by everyone; insert restricted to admins; no public write |
| `user_targets` | every policy is `auth.uid() = user_id` |
| `scholarship_extractions` | RLS on, **no policies** — deny-all |
| `scholarship_candidates` | admins only |
| `scholarship_sources` | admins only |
| `admins` | not reachable with the anon key |

Views need the same care and do not get it by default. A view reads its
underlying tables with its **owner's** rights unless it declares
`security_invoker`, so a view over a deny-all table hands out exactly what the
policy just withheld. `scholarship_completeness` (migration 016) reads
`scholarship_extractions` and declares it; migration 012 declined to add a view
over `pipeline_jobs` at all rather than rely on remembering. Any new view over a
staging table must do one or the other.

Two rules that must not be relaxed:

- **The service-role key bypasses every policy above.** It is used only by
  `scripts/`, is never prefixed `NEXT_PUBLIC_`, and is never imported by
  anything under `src/`. It does not belong in the deployed environment at all
  — see [deployment.md](deployment.md).
- **Staging tables are deny-all on purpose.** `scholarship_extractions` holds
  unreviewed model output. The app must not be able to read it, or unreviewed
  guesses would reach users through a bug rather than a decision.

## Defensive rendering

The JSONB columns are typed in TypeScript but not enforced by Postgres, and rows
arrive from three different places — `seed.sql`, `promote_candidate()`, and
`apply_extraction()` — which do not agree on shape. A row promoted from
discovery starts with `'[]'` documents and `'{}'` coverage.

So every consumer guards at the boundary (`Array.isArray`, `typeof x ===
"number"`) rather than trusting the column. A `.filter is not a function` on the
dashboard is a blank page, not a bad number.

Three-valued logic is carried all the way to the screen: absent is not false.
An unstated requirement renders as **"Not stated"**, never "Not required" —
the latter is a claim nobody made, in the direction most likely to hurt.
