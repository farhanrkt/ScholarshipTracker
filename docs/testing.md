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
| `scripts/extract/page.ts` | `robots.txt` decides whether we may fetch at all — a bug is either an etiquette problem or the silent loss of an entire origin. URL canonicalisation decides whether pagination exists. |
| `scripts/extract/relevance.ts` | Decides what gets crawled. A page that scores zero is never seen, and the row it would have filled stays empty for reasons nothing logs. |
| `scripts/discover/candidates.ts` | Decides what becomes a row, and what counts as a duplicate. |
| `src/lib/format.ts` | Decides what a card *claims*. "No bond" on an unread programme is a promise the data cannot keep. |

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

When you fix a bug in these files, add the case that would have caught it. The
comment above each test says what breaks in the real world if it fails, because
in six months that is the only thing that makes the assertion worth keeping.

## What is not covered

Server Components, the crawl loop, the discovery frontier and the pipeline
runner have no automated tests. They are I/O-bound orchestration, and the
honest way to exercise them is `--dry-run` against real sites, which is what
the pipeline console is for. If you extract a pure decision out of one of them,
test it here.
