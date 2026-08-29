import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { titleTokens } from "./crawl.ts";

/**
 * The crawl loop itself is I/O-bound orchestration and is exercised with
 * `--dry-run` against real sites, per docs/testing.md. What is testable here is
 * the pure decision it hangs off: which words in a programme's name actually
 * identify it.
 */

describe("title affinity vocabulary", () => {
  test("words on every funder's every page are not identifying", () => {
    // Matching on these boosts an entire site uniformly, which is the same as
    // boosting nothing — and it spends the affinity bonus that exists to tell
    // one programme's page apart from a portal's FAQ.
    assert.deepEqual(titleTokens("International Scholarship Programme"), []);
  });

  test("the distinctive words survive", () => {
    assert.deepEqual(titleTokens("Chevening Scholarships"), ["chevening"]);
    assert.deepEqual(
      titleTokens("Rotary Peace Fellowship"),
      ["rotary", "peace"],
    );
  });

  test("a repeated word is counted once", () => {
    assert.deepEqual(titleTokens("Fulbright Fulbright Award"), ["fulbright"]);
  });
});
