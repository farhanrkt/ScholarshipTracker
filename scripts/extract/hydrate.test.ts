import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { amphtmlUrl, hydrateText } from "./hydrate.ts";
import { htmlToText } from "./page.ts";

/**
 * A page that fails here is a programme with EVERY field blank, not one field
 * — the crawl throws and nothing downstream ever runs. It is also the failure
 * furthest from being the funder's fault, so the tests pull in both directions:
 * real copy buried in a hydration payload must come out, and the identifiers,
 * class names and minified code that surround it must not, because the prose
 * this recovers becomes page text that grounding will happily quote.
 */

describe("recovering content from a hydration payload", () => {
  test("reads a Next.js pages-router payload", () => {
    // The content is in the bytes we already downloaded. It was invisible only
    // because `htmlToText` strips <script> and then measures what is left.
    const html = `
      <div id="__next"></div>
      <script id="__NEXT_DATA__" type="application/json">
      {"props":{"pageProps":{"body":"Applications for the 2027/28 intake close on 6 October 2026 at 12:00 GMT."}}}
      </script>
    `;

    assert.ok(
      hydrateText(html, htmlToText).includes("close on 6 October 2026"),
    );
  });

  test("reads a Nuxt-style global assignment", () => {
    const html = `<script>window.__NUXT__={"data":{"summary":"The scholarship covers full tuition and a monthly stipend of 1,347."}}</script>`;

    assert.ok(hydrateText(html, htmlToText).includes("full tuition"));
  });

  test("stops at the end of the payload, not the last brace on the page", () => {
    // A greedy match to the final `}` swallows every later script on the page,
    // which turns one payload into a parse failure and loses the lot.
    const html =
      `<script>window.__NUXT__={"a":"Applications close on 6 October 2026 for this intake."}</script>` +
      `<script>function unrelated(){return {noise:"x"}}</script>`;

    const text = hydrateText(html, htmlToText);
    assert.ok(text.includes("Applications close on 6 October 2026"));
    assert.ok(!text.includes("unrelated"));
  });

  test("a brace inside a string does not end the payload early", () => {
    const html = `<script>window.__NUXT__={"note":"Use the form marked { A } to apply before the closing date."}</script>`;

    assert.ok(hydrateText(html, htmlToText).includes("to apply before the closing date"));
  });

  test("reads the App Router streaming format", () => {
    const html = `<script>self.__next_f.push([1,"0:[\\"$\\",\\"p\\",null,{\\"children\\":\\"The award includes a return airfare and health insurance for scholars.\\"}]\\n"])</script>`;

    assert.ok(hydrateText(html, htmlToText).includes("return airfare"));
  });

  test("recovers an article a site hides behind noscript", () => {
    const html = `<noscript><p>${"Eligibility: applicants must be under the age of 35 on the closing date. ".repeat(4)}</p></noscript>`;

    assert.ok(hydrateText(html, htmlToText).includes("under the age of 35"));
  });
});

describe("what must NOT come back as page text", () => {
  test("class lists and identifiers are not prose", () => {
    // These would be quotable page text. A model that quoted one would ground
    // against it, so the filter is a grounding control, not a tidiness one.
    const html = `<script>window.__NUXT__={"cls":"flexItemsCenter justifyBetween roundedLg borderMuted","id":"a8f3c2e1b4d5"}</script>`;

    assert.equal(hydrateText(html, htmlToText), "");
  });

  test("URLs and encoded blobs are dropped", () => {
    const html = `<script>window.__NUXT__={"src":"https://cdn.example.org/a/very/long/path/to/an/image/file.png","b":"${"QUJDREVG".repeat(12)}"}</script>`;

    assert.equal(hydrateText(html, htmlToText), "");
  });

  test("a short string is not content", () => {
    const html = `<script>window.__NUXT__={"label":"Apply now"}</script>`;

    assert.equal(hydrateText(html, htmlToText), "");
  });

  test("a page with no payload at all yields nothing rather than throwing", () => {
    assert.equal(hydrateText("<html><body></body></html>", htmlToText), "");
  });
});

describe("the AMP copy", () => {
  test("is found and resolved against the page it was linked from", () => {
    const url = amphtmlUrl(
      `<link rel="amphtml" href="/scholarships/example/amp/">`,
      "https://example.org/scholarships/example/",
    );

    assert.equal(url, "https://example.org/scholarships/example/amp/");
  });

  test("is found with the attributes in the other order", () => {
    const url = amphtmlUrl(
      `<link href="https://example.org/amp" rel="amphtml">`,
      "https://example.org/",
    );

    assert.equal(url, "https://example.org/amp");
  });

  test("a non-http scheme is refused", () => {
    // A crawl must not be talked into fetching a `javascript:` or `file:` URL
    // by markup on a page it does not control.
    assert.equal(
      amphtmlUrl(`<link rel="amphtml" href="javascript:alert(1)">`, "https://example.org/"),
      null,
    );
  });

  test("a page with no AMP copy returns null", () => {
    assert.equal(amphtmlUrl("<html></html>", "https://example.org/"), null);
  });
});
