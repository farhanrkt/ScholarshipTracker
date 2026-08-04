# ScholarTrack documentation

Written for the person who has to change this thing six months from now — which
is probably you. Each page explains what something does and, where the answer is
not obvious, why it was built that way and what happened when it was built the
other way.

| Page | Read it when |
| --- | --- |
| [architecture.md](architecture.md) | You need the shape of the app: rendering, auth, filtering, mutations, security. |
| [data-model.md](data-model.md) | You are touching the database, the JSONB columns, or the trust tiers. |
| [pipeline.md](pipeline.md) | You are working on discovery, crawling, extraction, or grounding. |
| [operations.md](operations.md) | You want to run the crawlers, review their output, or curate seeds. |
| [deployment.md](deployment.md) | You are shipping to Vercel or standing up a new environment. |
| [testing.md](testing.md) | You are changing grounding, scoring, or anything else with tests around it. |
| [troubleshooting.md](troubleshooting.md) | Something is broken, or behaving in a way that looks broken but is not. |

## The one idea

Everything here follows from a single rule: **a blank field beats a plausible
wrong one.**

A scholarship deadline is a date someone plans a year of their life around. An
early version of this app reconstructed deadlines from each programme's typical
cycle and got Chevening wrong by a month. Every design decision since — nullable
dates, verbatim-quote grounding, staged proposals a human applies, three-valued
booleans, "Not stated" instead of "Not required" — exists to make that class of
error impossible rather than unlikely.

When you extend this app, the question to ask is not "can I fill this field?"
but "can I prove this field?" If you cannot, leave it null and say so in the UI.

## Known limitations

Stated plainly, because discovering these by surprise is worse than reading them
here. Details and workarounds in [troubleshooting.md](troubleshooting.md).

- **Near-duplicate rows exist.** Dedupe is exact-match on a normalised title, so
  `Chevening Scholarship` and `Chevening Scholarships` are two rows. Expect more
  as the seed list grows.
- **Country names are inconsistent in existing data.** `UK` and `United Kingdom`
  both appear and both show in the filter sidebar. New discoveries are
  normalised; rows created before that are not.
- **PDFs are skipped.** Several funders (notably MEXT and KGSP) publish their
  real guidelines as PDF, which the crawler never opens.
- **JavaScript-rendered pages yield nothing** and fail loudly rather than
  silently returning an empty programme.
- **Depth of extracted detail depends on the funder.** ADB-JSP yields six
  coverage lines; Chevening publishes no reachable coverage page and yields one.
  That is the pipeline being honest, not failing.
