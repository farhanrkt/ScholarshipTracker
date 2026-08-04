import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { isStudentFunding } from "./student-funding.ts";

/**
 * Every rejection below is a URL the first UK seed survey actually proposed as
 * evidence that a site was worth crawling on every future run. They all matched
 * on "award" or "funding", which is why neither word is in the predicate.
 */

describe("student funding URLs", () => {
  test("rejects what fooled the first survey", () => {
    const cases: Array<[string, string]> = [
      ["a BBC archive page about a BAFTA", "http://www.ravensbourne.ac.uk/bbc-motion-graphics-archive/bafta-alexander-korda-award-ident-2003"],
      ["a professional body's awards committee", "http://www.rcgp.org.uk/about/awards/fellowship-awards-committee"],
      ["a course fee table", "https://www.stmarys-belfast.ac.uk/study/bed-primary/bed-primary-irish-irish-lang/fees-funding"],
      ["a college's fellowships for its own trainees", "https://www.rcog.org.uk/careers-and-training/awards-grants-and-prizes/awards-grants-and-prizes-for-rcog-fellows-members-and-trainees/lindsay-stewart-travelling-fellowship"],
    ];

    for (const [why, url] of cases) {
      assert.equal(isStudentFunding(url), false, `${why}: ${url}`);
    }
  });

  test("keeps real student funding", () => {
    for (const url of [
      "http://www.bpp.com/study/postgraduate/funding/scholarships",
      "http://www.harper-adams.ac.uk/apply/finance/scholarships/scholarship/201065/butchers-and-drovers-charitable-institution-bursary-202526",
      "https://www.bristol.ac.uk/students/support/finances/scholarships/liv-sidse-jansen-studentship",
      "https://www.ed.ac.uk/studying/postgraduate/fees-finance/funding-your-studies/scholarships",
      "https://www.nottingham.ac.uk/cdt-transformative-pharmaceutical-technologies/phd-studentships/funding",
    ]) {
      assert.equal(isStudentFunding(url), true, url);
    }
  });

  test("a members-only path is rescued when it is also applicant-facing", () => {
    // Universities do keep scholarships under /students/, and that must not be
    // read as "internal" the way a professional body's /members/ is.
    assert.equal(
      isStudentFunding("https://x.ac.uk/students/finance/scholarships/chevening"),
      true,
    );
  });

  test("a malformed URL is not funding", () => {
    assert.equal(isStudentFunding("not a url"), false);
  });
});
