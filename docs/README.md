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

- **Near-duplicate rows still need a human.** Discovery now rejects a near match
  on the same site as well as an exact title, and `/admin/duplicates` surfaces
  the rows already in the catalogue — but merging is a judgement call and stays
  one. `Distinguished Humphrey Fellowship Program` is a separate award that
  reads like a longer way of writing another one.
- **One programme, one country.** The column holds a single value, so a
  fellowship placing recipients in six countries is filed under `Multiple` and a
  student filtering for Japan will not find it. Fixing that properly means
  `country` becomes an array, which reaches the schema, the filters, discovery
  and every card.
- **A scanned PDF needs an OCR service configured.** Text-layer PDFs are read
  like any other page. A scan is an image, so without `OCR_SERVICE_URL` it fails
  the short-text guard and is reported. With one, its quotes are kept at a
  distinct evidence tier (`match: "ocr"`) and flagged for a human, because a
  machine's reading of a glyph is a weaker claim than text somebody published.
- **JavaScript-rendered pages are recovered when the content is in the page.**
  Most frameworks ship it as a hydration payload inside the initial HTML, which
  costs no extra request to read. A page that genuinely builds its content
  client-side still yields nothing unless `RENDER_SERVICE_URL` is configured,
  and fails loudly rather than silently returning an empty programme.
- **Depth of extracted detail depends on the funder.** ADB-JSP yields six
  coverage lines; Chevening publishes no reachable coverage page and yields one.
  That is the pipeline being honest, not failing. Each run prints
  `12/25 field(s) filled` and, for the rest, *why* each one is empty — so a thin
  extraction is not merely visible but diagnosed. `/admin/coverage` ranks the
  catalogue by the blanks the pipeline could still fill.
- **"No blanks at all" is not a goal and cannot be one.** A field is blank
  precisely when nothing on the funder's pages proved it, and the only way to
  zero that out is to write something nobody published. What the pipeline chases
  instead is **no *recoverable* blanks** — every field the funder's pages, or a
  credible second source, actually state. The rest are reported as
  `not-published` and shown to students as "Not stated by the programme", which
  is an answer rather than an absence.
- **China and South Korea are thinly seeded** — one or two seeds each against
  eleven for the USA, which is most of why the catalogue is 19 USA rows to 1
  Chinese one. The best Chinese sources block crawlers or serve
  JavaScript-rendered pages; see `BLOCKED_SEEDS` in `scripts/discover/seeds.ts`
  and use `npm run discover:find-seeds -- --country China` when hunting more.
