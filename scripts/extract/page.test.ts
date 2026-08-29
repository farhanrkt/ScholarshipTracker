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
/** Every User-agent a page request carried, in order, for the refusal tests. */
let userAgents: string[] = [];
/** When set, the stub answers 403 to anything that does not look like a browser. */
let refuseNonBrowser = false;
/** When set, every page request answers with this status. */
let statusOverride: number | null = null;

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

    const headers = (init?.headers ?? {}) as Record<string, string>;
    lastAccept = String(headers.accept ?? "");
    const userAgent = String(headers["user-agent"] ?? "");
    userAgents.push(userAgent);

    pageFetches++;
    if (statusOverride !== null) {
      return new Response("no", { status: statusOverride });
    }
    if (refuseNonBrowser && !userAgent.startsWith("Mozilla/")) {
      return new Response("forbidden", { status: 403 });
    }
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
    assert.ok(!urls.some((url) => url.startsWith("mailto")));
    assert.equal(urls.filter((url) => url === "https://x.example/apply").length, 1);
  });

  test("a PDF is a page now, not a binary to skip", () => {
    // MEXT and the Global Korea Scholarship publish a short HTML overview and
    // put the eligibility limits, the stipend and the document checklist in a
    // PDF guideline. Skipping those is why the Japan and Korea rows were thin.
    // (Whether a given PDF is worth FETCHING is the crawler's decision — see
    // the vocabulary gate in crawl.ts. This only says the link survives.)
    const links = pageModule.extractLinks({
      url: "https://x.example/page",
      text: "",
      html: '<a href="/guidelines.pdf">Application guidelines</a>' +
        '<a href="/prospectus.docx">Prospectus</a>' +
        '<a href="/photo.jpg">Photo</a>',
      sha256: "",
      fetchedAt: "",
    });
    const urls = links.map((link) => link.url);

    assert.ok(urls.includes("https://x.example/guidelines.pdf"));
    assert.ok(!urls.some((url) => url.endsWith(".docx")));
    assert.ok(!urls.some((url) => url.endsWith(".jpg")));
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

describe("being turned away", () => {
  /**
   * A large share of the 4xx failures in a run are a WAF scoring the REQUEST,
   * not the URL: no Accept-Language, a bare bot token, no Sec-Fetch headers.
   * The page is public and robots.txt allows it — a person opening the same
   * address gets it instantly. One retry with browser-shaped headers is what
   * turns those pages back into data, and it is one retry: a host that refuses
   * both identities is left alone.
   */
  test("a 403 is retried once with browser-shaped headers", async () => {
    pageModule.clearPageCache();
    const url = `${freshOrigin("")}/scholarships`;
    pageFetches = 0;
    userAgents = [];
    refuseNonBrowser = true;

    const page = await pageModule.fetchPage(url);
    refuseNonBrowser = false;

    assert.ok(page.text.includes("Scholarship funding details"));
    assert.equal(pageFetches, 2, `made ${pageFetches} requests`);
    assert.ok(
      !userAgents[0]?.startsWith("Mozilla/"),
      "the first request should announce us honestly",
    );
    assert.ok(
      userAgents[1]?.startsWith("Mozilla/"),
      "the retry should be browser-shaped",
    );
    assert.match(
      userAgents[1] ?? "",
      /ScholarTrackBot/,
      "the retry must still identify us and carry the contact URL",
    );
  });

  test("a host that refuses twice is not asked a third time", async () => {
    pageModule.clearPageCache();
    const origin = freshOrigin("");
    pageFetches = 0;
    statusOverride = 403;

    await assert.rejects(() => pageModule.fetchPage(`${origin}/a`));
    statusOverride = null;

    assert.equal(pageFetches, 2, `made ${pageFetches} requests on a firm refusal`);
  });

  test("every request states a language preference", async () => {
    // Multilingual sites 406 or redirect-loop a request that expresses none.
    pageModule.clearPageCache();
    let seen = "";
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!String(input).endsWith("/robots.txt")) {
        seen = String(headers["accept-language"] ?? "");
      }
      return original(input, init);
    }) as typeof fetch;

    await pageModule.fetchPage(`${freshOrigin("")}/x`);
    globalThis.fetch = original;

    assert.match(seen, /en/);
  });
});

describe("per-host politeness", () => {
  /**
   * The scheduler is the one place where "fast" and "well-behaved" are traded
   * off, so both halves of the trade are pinned here.
   *
   * The rate a site experiences is unchanged — one request per gap — but the
   * gap is now measured between request STARTS, so it overlaps the latency
   * instead of following it. Serially, twenty pages of a two-second site cost
   * twenty times two-and-a-bit seconds, and the crawl above it queued behind
   * itself no matter how many lanes it opened.
   */
  test("requests to one host overlap, up to the connection limit", async () => {
    pageModule.clearPageCache();
    const origin = freshOrigin("");

    let open = 0;
    let peak = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(input).endsWith("/robots.txt")) return original(input, init);
      open++;
      peak = Math.max(peak, open);
      // Deliberately longer than the gap between starts: overlap is what a slow
      // site produces, and a slow site is the case this exists for. Under the
      // old scheduler these three requests could never be open at once, however
      // long each took.
      await new Promise((resolve) => setTimeout(resolve, 900));
      open--;
      return original(input, init);
    }) as typeof fetch;

    await Promise.all([
      pageModule.fetchPage(`${origin}/a`),
      pageModule.fetchPage(`${origin}/b`),
      pageModule.fetchPage(`${origin}/c`),
    ]);
    globalThis.fetch = original;

    assert.ok(peak > 1, "requests to one host never overlapped at all");
    assert.ok(peak <= 2, `${peak} connections open to one host at once`);
  });

  test("a published Crawl-delay drops the host to one connection", async () => {
    // An explicit request for spacing outranks our throughput. A site that says
    // how it wants to be crawled gets exactly that, serially.
    pageModule.clearPageCache();
    const origin = freshOrigin("User-agent: *\nCrawl-delay: 1");

    let open = 0;
    let peak = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(input).endsWith("/robots.txt")) return original(input, init);
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 50));
      open--;
      return original(input, init);
    }) as typeof fetch;

    await Promise.all([
      pageModule.fetchPage(`${origin}/a`),
      pageModule.fetchPage(`${origin}/b`),
    ]);
    globalThis.fetch = original;

    assert.equal(peak, 1, "a site asking for a Crawl-delay got parallel hits");
  });

  test("different hosts do not wait for each other", async () => {
    pageModule.clearPageCache();
    const first = freshOrigin("");
    const second = freshOrigin("");

    const started = Date.now();
    await Promise.all([
      pageModule.fetchPage(`${first}/a`),
      pageModule.fetchPage(`${second}/a`),
    ]);

    // Two hosts must not serialise: the gap belongs to a host, not to the run.
    assert.ok(
      Date.now() - started < 700,
      `two hosts took ${Date.now() - started}ms, so they queued behind each other`,
    );
  });
});

describe("what a failed status means", () => {
  /**
   * The two failure families want opposite responses: a 404 says the URL we
   * hold is WRONG, which repair can act on, and a 403 says the URL is probably
   * fine and we were refused, which repair must not act on — guessing new
   * addresses at a host that is already turning us away is just more refusals.
   * Telling them apart needs the status, so the error has to carry it.
   */
  test("a 404 arrives as a dead link", async () => {
    pageModule.clearPageCache();
    const url = `${freshOrigin("")}/moved`;
    statusOverride = 404;

    const error = await pageModule
      .fetchPage(url)
      .then(() => null)
      .catch((cause: unknown) => cause);
    statusOverride = null;

    assert.ok(error instanceof pageModule.HttpError);
    assert.equal(error.status, 404);
    assert.equal(error.isDeadLink, true);
  });

  test("a 403 is not a dead link", async () => {
    pageModule.clearPageCache();
    const url = `${freshOrigin("")}/blocked`;
    statusOverride = 403;

    const error = await pageModule
      .fetchPage(url)
      .then(() => null)
      .catch((cause: unknown) => cause);
    statusOverride = null;

    assert.ok(error instanceof pageModule.HttpError);
    assert.equal(error.isDeadLink, false);
  });
});

describe("reading a page's full content", () => {
  const prose = (words: string) => `<p>${words.repeat(12)}</p>`;

  test("structured data is appended so grounding can quote it", () => {
    // A value taken from JSON-LD is SELF-GROUNDING: the quote is literally in
    // the page source, because that is where the funder put it. If this text is
    // not on the page, the value is discarded and the funder's own machine-
    // readable statement of its own deadline is worth nothing to us.
    const page = pageModule.readHtml(
      prose("The Example Scholarship is open to international students. ") +
        `<table><tr><td>Tuition</td><td>Covered in full</td></tr></table>`,
      "https://example.org/a",
    );

    assert.ok(page.text.includes("Tuition: Covered in full"));
    assert.ok(page.text.includes("open to international students"));
  });

  test("a shell page is recovered from its own hydration payload", () => {
    // Before this, the page threw and the programme kept every field blank —
    // the largest category of blank in the catalogue and the one furthest from
    // being the funder's fault.
    const page = pageModule.readHtml(
      `<div id="__next"></div><script id="__NEXT_DATA__" type="application/json">` +
        JSON.stringify({
          props: {
            body:
              "Applications for the 2027/28 intake close on 6 October 2026. " +
              "The award covers full tuition, a monthly stipend and return " +
              "airfare for every scholar, along with health insurance and a " +
              "settling-in allowance paid shortly after arrival.",
          },
        }) +
        `</script>`,
      "https://example.org/a",
    );

    assert.ok(page.text.includes("close on 6 October 2026"));
  });

  test("recovered content comes before the shell's own words", () => {
    // The shell's few words are chrome; the recovered text is the page. Putting
    // the chrome first spends the front of every passage on a cookie notice.
    const page = pageModule.readHtml(
      `<p>Loading…</p><script>window.__NUXT__=${JSON.stringify({
        body:
          "The Example Scholarship covers full tuition and a monthly stipend of " +
          "GBP 1,347 for every scholar on the programme, together with a return " +
          "airfare, health insurance and a one-off settling-in allowance paid on " +
          "arrival in the United Kingdom.",
      })}</script>`,
      "https://example.org/a",
    );

    assert.ok(page.text.startsWith("The Example Scholarship covers"));
  });

  test("a page with nothing recoverable still fails, and says why", () => {
    // Failing loudly is the point: an empty programme staged as a success is
    // how a row ends up looking checked when nothing read it.
    assert.throws(
      () => pageModule.readHtml("<div id=root></div>", "https://example.org/a"),
      (error: unknown) =>
        error instanceof pageModule.ShellPageError &&
        /JavaScript-rendered/.test((error as Error).message),
    );
  });

  test("the shell error carries the HTML so recovery costs no second fetch", () => {
    try {
      pageModule.readHtml("<div id=root></div>", "https://example.org/a");
      assert.fail("expected a ShellPageError");
    } catch (error) {
      assert.ok(error instanceof pageModule.ShellPageError);
      assert.equal(error.html, "<div id=root></div>");
      assert.equal(error.landedUrl, "https://example.org/a");
    }
  });
});
