import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  ancestorUrls,
  scorePathAgainstTitle,
  urlVariants,
} from "./repair.ts";
import { titleTokens } from "./crawl.ts";

/**
 * Repair proposes ADDRESSES, never facts, and the tests are written around
 * that: what matters is that the cheap, high-yield guesses come first, that
 * nothing suggests an address on somebody else's site, and that the ordering
 * is stable enough to reason about the cost of a repair (each candidate is a
 * request to a funder's server).
 *
 * Whether a proposed page is really the right programme is decided downstream
 * by the model's `page_is_about_requested_programme`, so there is nothing to
 * test for that here — and deliberately so.
 */

describe("URL variants", () => {
  test("offers the other trailing-slash spelling first", () => {
    // The cheapest possible repair: no new page has to exist, and plenty of
    // CMSs 404 one form while serving the other rather than redirecting.
    const variants = urlVariants("https://example.org/scholarships/chevening");
    assert.equal(variants[0]?.url, "https://example.org/scholarships/chevening/");
  });

  test("toggles www in whichever direction is missing", () => {
    const added = urlVariants("https://example.org/a").map((item) => item.url);
    assert.ok(added.some((url) => url.startsWith("https://www.example.org/")));

    const removed = urlVariants("https://www.example.org/a").map((item) => item.url);
    assert.ok(removed.some((url) => url.startsWith("https://example.org/")));
  });

  test("drops a leftover index file", () => {
    const variants = urlVariants("https://example.org/funding/index.php");
    assert.ok(variants.some((item) => item.url === "https://example.org/funding/"));
  });

  test("upgrades http, and never downgrades https", () => {
    assert.ok(
      urlVariants("http://example.org/a").some((item) =>
        item.url.startsWith("https://"),
      ),
    );
    assert.ok(
      !urlVariants("https://example.org/a").some((item) =>
        item.url.startsWith("http://example.org"),
      ),
    );
  });

  test("never proposes the address that just failed", () => {
    const dead = "https://example.org/a/";
    assert.ok(!urlVariants(dead).some((item) => item.url === dead));
  });

  test("a malformed URL yields nothing rather than throwing", () => {
    assert.deepEqual(urlVariants("not a url"), []);
  });
});

describe("ancestors", () => {
  test("walks up nearest-first and ends at the site root", () => {
    const urls = ancestorUrls(
      "https://example.org/study/funding/chevening/how-to-apply",
    ).map((item) => item.url);

    assert.deepEqual(urls, [
      "https://example.org/study/funding/chevening/",
      "https://example.org/study/funding/",
      "https://example.org/study/",
      "https://example.org/",
    ]);
  });

  test("stays on the same origin", () => {
    for (const item of ancestorUrls("https://example.org/a/b/c")) {
      assert.equal(new URL(item.url).origin, "https://example.org");
    }
  });

  test("a root URL has nothing above it to propose", () => {
    // The root is the address that just failed. Offering it back would spend a
    // request re-confirming the failure.
    assert.deepEqual(ancestorUrls("https://example.org/"), []);
  });
});

describe("matching a path to a programme", () => {
  test("counts the words that actually identify the programme", () => {
    const tokens = titleTokens("Chevening Scholarships");
    assert.ok(
      scorePathAgainstTitle("https://x.example/awards/chevening/", tokens) > 0,
    );
    assert.equal(
      scorePathAgainstTitle("https://x.example/news/2026/", tokens),
      0,
    );
  });

  test("a generic title matches nothing, rather than everything", () => {
    // "Scholarship", "international" and "programme" are on every page of every
    // funder. Matching on them would rank a site's entire estate equally, which
    // is the same as ranking nothing.
    const tokens = titleTokens("International Scholarship Programme");
    assert.equal(tokens.length, 0);
    assert.equal(
      scorePathAgainstTitle("https://x.example/international-scholarships/", tokens),
      0,
    );
  });

  test("a longer match outranks a shorter one", () => {
    const tokens = titleTokens("MEXT Japanese Government Scholarship");
    const specific = scorePathAgainstTitle(
      "https://x.example/en/mext-japanese-scholarships",
      tokens,
    );
    const vague = scorePathAgainstTitle("https://x.example/en/mext", tokens);
    assert.ok(specific > vague, `${specific} should beat ${vague}`);
  });

  test("percent-encoded paths are read as their characters", () => {
    const tokens = titleTokens("Erasmus Mundus");
    assert.ok(
      scorePathAgainstTitle("https://x.example/en/erasmus%20mundus/", tokens) > 0,
    );
  });
});
