import assert from "node:assert/strict";
import { test, describe, before } from "node:test";

/**
 * robots.txt decides whether we are allowed to fetch anything at all, so a bug
 * here is either a legal/etiquette problem or an invisible loss of every page
 * on an origin. The parser is exercised against literal robots files rather
 * than live sites, because the interesting cases (Allow exceptions, competing
 * agent groups) are ones no single real site exhibits all of.
 */

let robotsBody = "";
let host = 0;

type PageModule = typeof import("./page.ts");
let pageModule: PageModule;

/** Page requests that actually reached the network, for the cache tests. */
let pageFetches = 0;
/** Makes the next page request fail, so we can check failures are not cached. */
let failNextPage = false;
/** Makes every page request time out, for the retry-ceiling test. */
let timeoutPages = false;

const PAGE_HTML = `<html><body><p>${"Scholarship funding details. ".repeat(20)}</p></body></html>`;

/** The Accept header of the last non-robots request, for the 406 regression. */
let lastAccept = "";

before(async () => {
  // Stub the network before the module is loaded, so its robots fetches hit us.
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/robots.txt")) {
      return new Response(robotsBody, { status: 200 });
    }

    lastAccept = String(
      (init?.headers as Record<string, string> | undefined)?.accept ?? "",
    );

    pageFetches++;
    if (timeoutPages) {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    if (failNextPage) {
      failNextPage = false;
      return new Response("gone", { status: 404 });
    }
    return new Response(PAGE_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;
  pageModule = await import("./page.ts");
});

/** A fresh origin per case, because policies are cached per origin. */
function freshOrigin(body: string): string {
  robotsBody = body;
  return `https://h${host++}.example`;
}

describe("robots.txt", () => {
  test("a blanket disallow blocks everything", async () => {
    const origin = freshOrigin("User-agent: *\nDisallow: /");
    assert.equal(await pageModule.isAllowed(`${origin}/anything`), false);
  });

  test("an Allow exception beats Disallow: /", async () => {
    // The case that cost us whole origins: a site explicitly inviting us to the
    // one section we want, refused because only Disallow lines were read.
    const origin = freshOrigin("User-agent: *\nDisallow: /\nAllow: /scholarships/");
    assert.equal(await pageModule.isAllowed(`${origin}/scholarships/chevening`), true);
    assert.equal(await pageModule.isAllowed(`${origin}/news/story`), false);
  });

  test("another agent's rules do not apply to us", async () => {
    const origin = freshOrigin(
      "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private",
    );
    assert.equal(await pageModule.isAllowed(`${origin}/public`), true);
    assert.equal(await pageModule.isAllowed(`${origin}/private/x`), false);
  });

  test("our own group wins over the wildcard group", async () => {
    const origin = freshOrigin(
      "User-agent: ScholarTrackBot\nDisallow: /secret\n\nUser-agent: *\nDisallow: /",
    );
    assert.equal(await pageModule.isAllowed(`${origin}/open`), true);
    assert.equal(await pageModule.isAllowed(`${origin}/secret/x`), false);
  });

  test("an empty Disallow means allow everything", async () => {
    const origin = freshOrigin("User-agent: *\nDisallow:");
    assert.equal(await pageModule.isAllowed(`${origin}/anything`), true);
  });

  test("wildcards and end anchors are honoured", async () => {
    const origin = freshOrigin("User-agent: *\nDisallow: /*.pdf$");
    assert.equal(await pageModule.isAllowed(`${origin}/a/b.pdf`), false);
    assert.equal(await pageModule.isAllowed(`${origin}/a/pdf-guide`), true);
  });

  test("the longest matching rule decides", async () => {
    const origin = freshOrigin("User-agent: *\nDisallow: /a\nAllow: /a/b");
    assert.equal(await pageModule.isAllowed(`${origin}/a/b/c`), true);
    assert.equal(await pageModule.isAllowed(`${origin}/a/z`), false);
  });

  test("Crawl-delay is read", async () => {
    const origin = freshOrigin("User-agent: *\nCrawl-delay: 4\nDisallow: /x");
    assert.equal(await pageModule.crawlDelayFor(`${origin}/page`), 4_000);
  });

  test("comments and stray whitespace are ignored", async () => {
    const origin = freshOrigin("# a comment\n  User-agent: *  \n  Disallow: /x # trailing\n");
    assert.equal(await pageModule.isAllowed(`${origin}/x/y`), false);
    assert.equal(await pageModule.isAllowed(`${origin}/y`), true);
  });
});

describe("URL canonicalisation", () => {
  test("keeps pagination parameters and drops tracking", async () => {
    // Stripping the whole query string made pagination invisible to discovery,
    // which was the single biggest cap on how many programmes a run could find.
    const url = new URL("https://x.example/list?utm_source=news&page=2&fbclid=abc");
    assert.equal(pageModule.canonicaliseUrl(url), "https://x.example/list?page=2");
  });

  test("orders parameters so one page is one key", async () => {
    const a = pageModule.canonicaliseUrl(new URL("https://x.example/l?tab=b&page=2"));
    const b = pageModule.canonicaliseUrl(new URL("https://x.example/l?page=2&tab=b"));
    assert.equal(a, b);
  });

  test("drops the fragment and a bare trailing slash", async () => {
    assert.equal(
      pageModule.canonicaliseUrl(new URL("https://x.example/a/#section")),
      "https://x.example/a",
    );
  });
});

describe("html to text", () => {
  test("drops navigation and footer chrome but keeps the content", async () => {
    const html = `
      <nav><a href="/a">Scholarships</a><a href="/b">News</a></nav>
      <main><p>Applications close on 6 October 2026.</p></main>
      <footer><a href="/privacy">Privacy</a> Copyright 2026</footer>`;
    const text = pageModule.htmlToText(html);

    assert.match(text, /Applications close on 6 October 2026/);
    assert.doesNotMatch(text, /Privacy/);
    assert.doesNotMatch(text, /News/);
  });

  test("block boundaries become newlines so cells do not fuse", async () => {
    const text = pageModule.htmlToText("<tr><td>Applications close</td><td>6 Oct 2026</td></tr>");
    assert.match(text, /Applications close\n\s*6 Oct 2026/);
  });

  test("entities are decoded", async () => {
    assert.equal(pageModule.htmlToText("<p>Fees &amp; funding &ndash; 2026</p>").trim(), "Fees & funding - 2026");
  });
});

describe("link extraction", () => {
  const html = `
    <nav><a href="/benefits">What you get</a></nav>
    <a href="https://other.example/x">Off site</a>
    <a href="/guide.pdf">Guide</a>
    <a href="mailto:a@b.c">Mail</a>
    <a href="/apply/">Apply</a>
    <a href="/apply">Apply again</a>`;

  test("nav links survive even though nav text does not", async () => {
    // Deliberate: navigation is useless as prose and excellent as an index.
    const links = pageModule.extractLinks({
      url: "https://x.example/page",
      text: "",
      html,
      sha256: "",
      fetchedAt: "",
    });

    assert.ok(links.some((link) => link.url === "https://x.example/benefits"));
  });

  test("skips other origins, binaries and non-http schemes, and de-duplicates", async () => {
    const links = pageModule.extractLinks({
      url: "https://x.example/page",
      text: "",
      html,
      sha256: "",
      fetchedAt: "",
    });
    const urls = links.map((link) => link.url);

    assert.ok(!urls.some((url) => url.includes("other.example")));
    assert.ok(!urls.some((url) => url.endsWith(".pdf")));
    assert.ok(!urls.some((url) => url.startsWith("mailto")));
    assert.equal(urls.filter((url) => url === "https://x.example/apply").length, 1);
  });
});

/**
 * Programmes on one site overlap almost completely, and each row runs its own
 * crawl. Three Chevening rows were observed fetching the SAME sixteen pages —
 * 48 requests where 16 would do. The politeness gate made that slow rather than
 * rude, which is the right trade and not a reason to send the requests at all.
 */
describe("page cache", () => {
  test("one fetch serves every crawl that wants the page", async () => {
    pageModule.clearPageCache();
    const url = `${freshOrigin("")}/scholarships/benefits`;
    pageFetches = 0;

    // Concurrent is the normal case: --concurrency 3 on one host. The second
    // caller must await the first request, not start a second one.
    const [first, second] = await Promise.all([
      pageModule.fetchPage(url),
      pageModule.fetchPage(url),
    ]);
    const later = await pageModule.fetchPage(url);

    assert.equal(pageFetches, 1, `${pageFetches} requests reached the network`);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.sha256, later.sha256);
  });

  test("URL variants that are one page are one fetch", async () => {
    pageModule.clearPageCache();
    const origin = freshOrigin("");
    pageFetches = 0;

    // canonicaliseUrl already folds these; the cache keys on that spelling, so
    // it must not be fooled into a second request.
    await pageModule.fetchPage(`${origin}/apply/`);
    await pageModule.fetchPage(`${origin}/apply`);
    await pageModule.fetchPage(`${origin}/apply?utm_source=newsletter`);
    await pageModule.fetchPage(`${origin}/apply#eligibility`);

    assert.equal(pageFetches, 1, `${pageFetches} requests reached the network`);
  });

  test("a real page is still one fetch per distinct URL", async () => {
    pageModule.clearPageCache();
    const origin = freshOrigin("");
    pageFetches = 0;

    await pageModule.fetchPage(`${origin}/benefits`);
    await pageModule.fetchPage(`${origin}/eligibility`);

    assert.equal(pageFetches, 2);
  });

  test("a failure is not cached", async () => {
    // A 404 for one programme must not stop the next from trying: the failure
    // may have been transient, and fetchWithRetry has its own view on that.
    pageModule.clearPageCache();
    const url = `${freshOrigin("")}/eligibility`;
    pageFetches = 0;
    failNextPage = true;

    await assert.rejects(() => pageModule.fetchPage(url));
    const recovered = await pageModule.fetchPage(url);

    assert.equal(pageFetches, 2, "the retry never reached the network");
    assert.ok(recovered.text.includes("Scholarship funding details"));
  });
});

describe("content negotiation", () => {
  /**
   * A server that honours Accept answers a request for XML with 406 when told
   * we only read HTML. Nottingham does exactly that: its sitemap 406s under the
   * page crawler's header and returns 19,917 URLs under a neutral one. The
   * failure is silent — a 406 is indistinguishable from "this origin has no
   * sitemap" — so sitemap discovery was quietly dead on every site that
   * negotiates, and nothing in the logs said so.
   */
  test("a page fetch asks for HTML", async () => {
    pageModule.clearPageCache();
    await pageModule.fetchPage(`${freshOrigin("")}/scholarships`);
    assert.match(lastAccept, /text\/html/);
  });

  test("a sitemap fetch does NOT ask for HTML only", async () => {
    pageModule.clearPageCache();
    await pageModule.fetchText(`${freshOrigin("")}/sitemap.xml`);

    assert.match(lastAccept, /xml/, "sitemap request did not advertise XML");
    assert.notEqual(
      lastAccept,
      "text/html,application/xhtml+xml",
      "sitemap request sent the HTML-only Accept header that causes 406s",
    );
  });
});

describe("retry ceilings", () => {
  /**
   * A page that never answers used to cost 30+2+30+4+30 ≈ 96 seconds, and one
   * Chevening run spent about four and a half minutes on three of them. A
   * server that has sent nothing in fifteen seconds is gone, and unlike a 503 —
   * which is an explicit "come back" — a timeout promises nothing.
   */
  test("a timeout is retried once, not twice", async () => {
    pageModule.clearPageCache();
    const url = `${freshOrigin("")}/slow`;
    pageFetches = 0;
    timeoutPages = true;

    await assert.rejects(() => pageModule.fetchPage(url));
    timeoutPages = false;

    assert.equal(pageFetches, 2, `made ${pageFetches} attempts on a dead page`);
  });
});
