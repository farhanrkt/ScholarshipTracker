import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  canonicalUrl,
  findPaginationLinks,
  normaliseCountry,
  scoreCandidate,
  titleFingerprint,
} from "./candidates.ts";
import type { FetchedPage } from "../extract/page.ts";

function page(html: string, url = "https://x.example/list"): FetchedPage {
  return { url, text: "", html, sha256: "", fetchedAt: "" };
}

describe("candidate scoring", () => {
  test("a programme-shaped link outscores a generic one", () => {
    const programme = scoreCandidate("Chevening Scholarships", "https://x.example/scholarships/chevening");
    const generic = scoreCandidate("About us", "https://x.example/about");
    assert.ok(programme > generic);
  });

  test("editorial paths are rejected outright", () => {
    assert.equal(scoreCandidate("A scholarship story", "https://x.example/news/scholarship-winner"), -1);
  });

  test("pages written for people already in the programme are rejected", () => {
    // Both duplicate FLTA rows came from /host-institutions/: real descriptions
    // of a real programme, written for universities hosting it, with nothing an
    // applicant needs and no funding detail at all.
    for (const path of [
      "/host-institutions/flta-program/flta-during-the-program",
      "/current-grantees/scholarship-handbook",
      "/alumni/scholarship-network",
      "/for-advisers/scholarship-guidance",
      // Whatever a funder calls its own alumni. Fulbright's actual section,
      // and the top-scoring link on its seed page.
      "/current-fulbrighters/flta-understand-your-flta-grant",
      "/current-chevening-scholars/handbook",
    ]) {
      assert.equal(scoreCandidate("Scholarship", `https://x.example${path}`), -1, path);
    }
  });

  test("a current-AWARDS index is not an internal-audience page", () => {
    // The failure mode of the rule above being too broad: `current-*` also
    // spells perfectly good listings of what is open right now, and rejecting
    // those throws away exactly what discovery is looking for.
    for (const path of [
      "/current-scholarships/",
      "/current-awards",
      "/funding/current-opportunities/",
      "/current-grants/postgraduate",
    ]) {
      assert.ok(
        scoreCandidate("Scholarships", `https://x.example${path}`) > 0,
        `${path} was rejected`,
      );
    }
  });
});

describe("title fingerprints", () => {
  test("singular and plural are the same programme", () => {
    // These were two rows on the dashboard, contradicting each other.
    assert.equal(
      titleFingerprint("Chevening Scholarship"),
      titleFingerprint("Chevening Scholarships"),
    );
  });

  test("punctuation and spacing do not create a new programme", () => {
    assert.equal(
      titleFingerprint("Fulbright Foreign Language Teaching Assistant (FLTA) Program"),
      titleFingerprint("Fulbright  Foreign-Language Teaching Assistant FLTA Program"),
    );
  });

  test("genuinely different awards stay different", () => {
    // The failure mode of a fuzzier match: these are separate programmes with
    // separate money and separate deadlines.
    assert.notEqual(
      titleFingerprint("Chevening Fellowships"),
      titleFingerprint("Chevening Scholarships"),
    );
  });
});

describe("pagination detection", () => {
  const links = (hrefs: Array<[string, string]>) =>
    hrefs.map(([url, label]) => ({ url, label }));

  test("finds a numbered pager on the same path", () => {
    const found = findPaginationLinks(
      page(""),
      links([["https://x.example/list?page=2", "2"]]),
    );
    assert.deepEqual(found, ["https://x.example/list?page=2"]);
  });

  test("finds a /page/N pager", () => {
    const found = findPaginationLinks(
      page("", "https://x.example/scholarships"),
      links([["https://x.example/scholarships/page/2", "Next"]]),
    );
    assert.deepEqual(found, ["https://x.example/scholarships/page/2"]);
  });

  test("reads rel=next straight out of the markup", () => {
    const found = findPaginationLinks(
      page('<link rel="next" href="/list?page=3">'),
      [],
    );
    assert.deepEqual(found, ["https://x.example/list?page=3"]);
  });

  test("a numbered link to somewhere else is not a pager", () => {
    const found = findPaginationLinks(
      page(""),
      links([["https://x.example/programmes/2", "2"]]),
    );
    assert.deepEqual(found, []);
  });

  test("never returns the page it was given", () => {
    const found = findPaginationLinks(
      page("", "https://x.example/list?page=2"),
      links([["https://x.example/list?page=2", "2"]]),
    );
    assert.deepEqual(found, []);
  });
});

describe("canonical urls", () => {
  test("prefers the canonical the page declares", () => {
    const found = canonicalUrl(
      page('<link rel="canonical" href="https://x.example/real">', "https://x.example/real?utm=1"),
    );
    assert.equal(found, "https://x.example/real");
  });

  test("ignores a canonical pointing at another origin", () => {
    const found = canonicalUrl(
      page('<link rel="canonical" href="https://elsewhere.example/x">', "https://x.example/mine"),
    );
    assert.equal(found, "https://x.example/mine");
  });

  test("falls back to the fetched url when nothing is declared", () => {
    assert.equal(canonicalUrl(page("<p>hi</p>", "https://x.example/a/")), "https://x.example/a");
  });
});

describe("country names", () => {
  test("folds the six targets to one spelling each", () => {
    assert.equal(normaliseCountry("United Kingdom"), "UK");
    assert.equal(normaliseCountry("  united states "), "USA");
    assert.equal(normaliseCountry("Republic of Korea"), "South Korea");
  });

  test("leaves anything else exactly as it was", () => {
    // Relabelling a German programme would be worse than the bug being fixed.
    assert.equal(normaliseCountry("Germany"), "Germany");
    assert.equal(normaliseCountry(null), null);
  });
});

describe("archive paths", () => {
  test("a dated segment is an archive, not a programme", () => {
    // All real, all from the first sitemap harvest, all scored well on
    // "funding"/"grants" before the path rule existed.
    for (const path of [
      "/september-2015/gates-foundation-grants",
      "/august-2016/free-webinar-how-to-apply-for-federal-fellowships",
      "/students/newsletter/october-2015/discretionary-funding-available",
      "/2016/scholarship-winners",
      "/2016-08/funding-news",
    ]) {
      assert.equal(scoreCandidate("", `https://x.example${path}`), -1, path);
    }
  });

  test("a year inside a name is not a date segment", () => {
    // The failure mode of the rule above being too eager.
    for (const path of [
      "/scholarships/chevening-2026",
      "/funding/2026-intake-scholarship",
      "/awards/rhodes-scholarship-2027-entry",
    ]) {
      assert.ok(
        scoreCandidate("", `https://x.example${path}`) > 0,
        `${path} was rejected`,
      );
    }
  });

  test("newsletter and research-news sections are rejected", () => {
    for (const path of [
      "/research-innovation/latest-research-news/academics-awarded-fellowships",
      "/students/newsletter/funding-available",
      "/news-and-events/scholarship-launch",
    ]) {
      assert.equal(scoreCandidate("", `https://x.example${path}`), -1, path);
    }
  });
});
