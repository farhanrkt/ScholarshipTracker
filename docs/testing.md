# Testing

```bash
npm test     # node --test, no dependencies
npm run check   # typecheck + lint + test
```

Node's built-in runner, executing `.test.ts` files directly via type stripping.
No Jest, no Vitest, no config: the suite exists to protect a handful of pure
functions, and adding a framework to do that would be more machinery than the
thing it guards.

## What is tested, and why those things

Coverage is deliberately uneven. These are the functions where being wrong is
silent and expensive.

| Area | Why it earns tests |
| --- | --- |
| `scripts/extract/ground.ts` | The control the whole product rests on. A wrong answer here puts a fabricated deadline or an invented stipend in front of a student as fact. |
| `scripts/extract/quote.ts` | Decides whether a quote counts as found. Too strict and correct values are thrown away; too loose and it stops being a control at all. Both directions are tested. |
| `scripts/extract/gaps.ts` | Decides which fields get a second look and whether the merge can ever lose information. A gap list that misreads `0` or `false` as "not found" asks the same question forever. |
| `scripts/extract/extract.ts` | The response repairs for providers that cannot enforce a schema. They must only ever discard information or fill in "not answered" — one that invented a default would put an unsupported claim in front of a student. The empty-`{}` case also pins the skeleton to the schema. |
| `scripts/extract/page.ts` | `robots.txt` decides whether we may fetch at all — a bug is either an etiquette problem or the silent loss of an entire origin. URL canonicalisation decides whether pagination exists. |
| `scripts/extract/relevance.ts` | Decides what gets crawled. A page that scores zero is never seen, and the row it would have filled stays empty for reasons nothing logs. |
| `scripts/discover/candidates.ts` | Decides what becomes a row, and what counts as a duplicate. |
| `src/lib/format.ts` | Decides what a card *claims*. "No bond" on an unread programme is a promise the data cannot keep. |
| `scripts/extract/repair.ts` | Decides where a moved programme is looked for. Each candidate is a request to a funder, and a bad guess wastes a crawl. |
| `src/lib/pipeline/jobs.ts` | The boundary between an HTTP request and a crawler that spends a paid quota. |
| `src/lib/pipeline/runner.ts` | The bookkeeping that lets a multi-minute run survive a host where nothing outlives a request: which units run, that the cursor only moves forward, that a finished job is written back as finished. |
| `scripts/extract/diagnosis.ts` | Decides what an operator does next, and — through `not-published` — what a student is told the funder does not publish. A cause classified one step too confidently turns our own crawl failure into a claim about the programme. |
| `scripts/extract/structured.ts` | Everything it emits becomes quotable page text, so it fails in both directions: a benefits table that does not survive is a coverage matrix nobody can fill, and a page of breadcrumbs that does survive is the passage budget spent on navigation. |
| `scripts/extract/hydrate.ts` | A page that fails here is a programme with *every* field blank, not one field. The prose filter is a grounding control rather than a tidiness one — whatever it returns is text a model may quote. |

Nothing here tests the model. Model output is checked at runtime by grounding,
which is itself the thing under test.

## The style these tests are written in

Each case is a value that must be **kept** or a value that must be **thrown
away**, and the thrown-away ones matter more. Most are drawn from failures that
actually happened:

- Gates Cambridge's `"opens in September 2026"` becoming `2026-09-01` — an
  invented day, correctly rejected now.
- A stipend figure attached to a real quote that never contained it.
- `"a minimum of five years"` being discarded because the check only understood
  digits — a correct value lost to a bad comparison.
- Two `/host-institutions/` pages staging the same Fulbright programme twice.
- `Disallow: /` plus `Allow: /scholarships/` blocking an origin that was
  explicitly inviting us in.
- A quote stitched across a bullet being rejected as a fabrication, and — the
  other side of the same change — a stipend figure that appears in the quote and
  on no page being rejected anyway.
- A `coverage.airfare` blank on a crawl that fetched no benefits page being
  reported as "the programme does not state it" — our failure printed as the
  funder's decision.
- A model naming a field in `not_stated` *and* returning a grounded value for
  it, which would render a figure beside "not stated by the programme".
- A hydration payload's class list (`flexItemsCenter justifyBetween`) coming
  back as page text a quote could be grounded against.
- A greedy brace match swallowing every later `<script>` on the page and losing
  a payload that had parsed perfectly on its own.

When you fix a bug in these files, add the case that would have caught it. The
comment above each test says what breaks in the real world if it fails, because
in six months that is the only thing that makes the assertion worth keeping.

## What is not covered

Server Components, the crawl loop and the discovery frontier have no automated
tests. They are I/O-bound orchestration, and the honest way to exercise them is
`--dry-run` against real sites, which is what the pipeline console is for. If
you extract a pure decision out of one of them, test it here.

The pipeline runner is half-covered: its bookkeeping is tested against a fake
Supabase client, and the crawling it drives is not. A test that needed a live
database and twenty minutes of real fetching is a test nobody would run, so the
seam is drawn at the store interfaces — `ExtractionStore` and `DiscoveryStore` —
which is also what lets the CLI and the deployed runner share one pipeline.
