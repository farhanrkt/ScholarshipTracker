import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { isPdf } from "./pdf.ts";

/**
 * Deciding a response is a PDF is the whole gate: get it wrong one way and the
 * extractor is handed HTML, get it wrong the other and a funder's application
 * guideline is thrown away as a binary — which is what used to happen, and why
 * the Japan and Korea rows were thin.
 */
describe("recognising a PDF", () => {
  test("the declared content type is enough", () => {
    assert.equal(isPdf("application/pdf", "https://example.org/guidelines"), true);
    assert.equal(isPdf("application/pdf; charset=binary", "https://example.org/x"), true);
  });

  test("a download served as octet-stream is caught by its path", () => {
    // Content-negotiated downloads routinely arrive with no useful type at all.
    assert.equal(
      isPdf("application/octet-stream", "https://example.org/guide.pdf"),
      true,
    );
    assert.equal(isPdf(null, "https://example.org/guide.PDF"), true);
  });

  test("a query string does not hide the extension", () => {
    assert.equal(isPdf(null, "https://example.org/guide.pdf?v=2026"), true);
  });

  test("an HTML page is not a PDF, whatever its name suggests", () => {
    assert.equal(isPdf("text/html; charset=utf-8", "https://example.org/pdf-guide"), false);
    assert.equal(isPdf(null, "https://example.org/about-our-pdfs"), false);
  });

  test("an unparseable URL still gets judged", () => {
    assert.equal(isPdf(null, "not a url at all/guide.pdf"), true);
    assert.equal(isPdf(null, "not a url at all"), false);
  });
});
