import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { normalise } from "./page.ts";
import { findQuote, type QuotePage } from "./quote.ts";

/**
 * The loose matcher exists to stop grounding rejecting real facts for reasons
 * that have nothing to do with truth — a stitched bullet, a dropped article.
 * It is also the one place where loosening a control could let a fabrication
 * through, so the rejection tests here matter more than the acceptance ones.
 */

function pages(...texts: string[]): QuotePage[] {
  return texts.map((text, index) => ({
    url: `https://example.org/${index}`,
    text: normalise(text),
  }));
}

describe("finding a quote on a page", () => {
  test("an exact quote matches, and says so", () => {
    const match = findQuote(
      pages("Applications close on 6 October 2026 at 12:00 midday UK time."),
      "Applications close on 6 October 2026",
    );

    assert.equal(match?.exact, true);
    assert.equal(match?.url, "https://example.org/0");
  });

  test("an exact match on a later page beats a loose one on an earlier page", () => {
    // Otherwise a near-miss decides the row's source_url, and a re-checker is
    // sent to the wrong page.
    const match = findQuote(
      pages(
        "Applications close in October and interviews are held in the spring.",
        "Applications close on 6 October 2026 and interviews follow in March.",
      ),
      "Applications close on 6 October 2026 and interviews follow in March",
    );

    assert.equal(match?.exact, true);
    assert.equal(match?.url, "https://example.org/1");
  });

  test("a quote stitched across a bullet is still found", () => {
    // The characteristic near-miss: the model reads a list as a sentence.
    const match = findQuote(
      pages("Applications close on 6 October 2026\n· Interviews are held in March 2027"),
      "Applications close on 6 October 2026 Interviews are held in March 2027",
    );

    assert.equal(match?.exact, false);
    assert.match(match?.text ?? "", /6 october 2026/);
    assert.match(match?.text ?? "", /march 2027/);
  });

  test("a quote missing a word is still found", () => {
    const match = findQuote(
      pages("Chevening covers a monthly stipend of GBP 1,347 for living expenses in the UK."),
      "Chevening covers monthly stipend of GBP 1,347 for living expenses in the UK",
    );

    assert.equal(match?.exact, false);
    assert.match(match?.text ?? "", /1,347/);
  });

  test("a figure the page never printed is not matched loosely", () => {
    // THE test. The page describes a stipend and gives no amount; the model
    // supplies one. Every word but the number is on the page, so a pure
    // token-overlap rule would accept it and a student would budget against an
    // invented figure.
    const match = findQuote(
      pages("The award covers a monthly stipend towards your living costs in London."),
      "The award covers a monthly stipend of GBP 1,347 towards your living costs in London",
    );

    assert.equal(match, null);
  });

  test("a quote that shares only some of its words is rejected", () => {
    const match = findQuote(
      pages("Applications close in the autumn; the exact date is confirmed each spring."),
      "Applications close on 6 October 2026 at 12:00 midday UK time",
    );

    assert.equal(match, null);
  });

  test("a fabricated quote matches nothing", () => {
    const match = findQuote(
      pages("This page is about the history of the foundation and its founders."),
      "Applicants must be under the age of 35 on the closing date",
    );

    assert.equal(match, null);
  });

  test("a quote too short to be evidence is not matched at all", () => {
    assert.equal(findQuote(pages("Something about 2026 and other things."), "2026"), null);
  });

  test("a short quote gets the exact search only", () => {
    // Five tokens: 85% rounds to "one word may differ", which on a nav-heavy
    // page is a coincidence. Exact still works.
    const text = "Deadline: 6 October 2026 for all applicants.";
    assert.equal(findQuote(pages(text), "Deadline: 6 October 2026")?.exact, true);
    assert.equal(findQuote(pages(text), "Deadline: 7 October 2026"), null);
  });

  test("the returned span is trimmed to the words that matched", () => {
    // The span is what every downstream check reads, so slack at its edges
    // would hand those checks text the quote never claimed.
    const match = findQuote(
      pages(
        "Unrelated preamble about the university. Applicants must hold an offer of admission before applying. Unrelated closing text about parking.",
      ),
      "Applicants must an offer of admission before applying",
    );

    assert.equal(match?.exact, false);
    assert.equal(match?.text.startsWith("applicants"), true);
    assert.equal(match?.text.endsWith("applying"), true);
  });
});
