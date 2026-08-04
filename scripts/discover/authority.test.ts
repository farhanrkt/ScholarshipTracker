import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  classifyAuthority,
  registrableDomain,
  sameOrganisation,
  strongerAuthority,
} from "./authority.ts";

/**
 * This module decides which sources may establish a fact and who wins a
 * disagreement. Getting it wrong in one direction lets a content farm set a
 * student's deadline; in the other it demotes a funder's own words to hearsay.
 */

describe("registrable domain", () => {
  test("subdomains collapse to the organisation", () => {
    assert.equal(registrableDomain("oga.snu.ac.kr"), "snu.ac.kr");
    assert.equal(registrableDomain("www.chevening.org"), "chevening.org");
    assert.equal(registrableDomain("apply.chevening.org"), "chevening.org");
    assert.equal(registrableDomain("global.sjtu.edu.cn"), "sjtu.edu.cn");
  });

  test("a two-label public suffix is not somebody's domain", () => {
    // The bug this prevents: treating "ac.uk" as an organisation would make
    // every British university the same source.
    assert.notEqual(registrableDomain("ox.ac.uk"), registrableDomain("cam.ac.uk"));
    assert.equal(registrableDomain("www.ox.ac.uk"), "ox.ac.uk");
  });
});

describe("same organisation", () => {
  test("a subdomain of the funder is still the funder", () => {
    assert.equal(
      sameOrganisation("https://apply.chevening.org/x", "https://www.chevening.org/"),
      true,
    );
  });

  test("two universities are not each other", () => {
    assert.equal(
      sameOrganisation("https://www.ox.ac.uk/a", "https://www.cam.ac.uk/b"),
      false,
    );
  });
});

describe("authority tiers", () => {
  const funderUrl = "https://www.chevening.org/scholarships/";

  test("the programme's own site is the funder, subdomain or not", () => {
    assert.equal(
      classifyAuthority("https://www.chevening.org/scholarships/who-can-apply", { funderUrl }),
      "funder",
    );
    assert.equal(
      classifyAuthority("https://apply.chevening.org/guidance", { funderUrl }),
      "funder",
    );
  });

  test("registry-controlled suffixes are official", () => {
    for (const url of [
      "https://www.ed.ac.uk/student-funding",
      "https://gradschool.unc.edu/funding/",
      "https://www.studyinjapan.go.jp/en/",
      "https://oga.snu.ac.kr/students",
      "https://www.a-star.edu.sg/Scholarships",
      "https://www.moe.gov.sg/financial-matters",
      "https://en.pku.edu.cn/admissions",
    ]) {
      assert.equal(classifyAuthority(url), "official", url);
    }
  });

  test("a funder on a plain .org is still official", () => {
    // These bodies run programmes in this database from domains that say
    // nothing about them. Without the curated list they would rank alongside
    // the blogs that write about them.
    assert.equal(classifyAuthority("https://www.chevening.org/x"), "official");
    assert.equal(classifyAuthority("https://www.rotary.org/en/our-programs"), "official");
  });

  test("anyone can buy a .org, so .org alone is not official", () => {
    assert.equal(classifyAuthority("https://scholarship-news.org/chevening-2026"), "other");
    assert.equal(classifyAuthority("https://someblog.com/best-scholarships"), "other");
  });

  test("a known aggregator can never be promoted", () => {
    // This one is real: 231 programme-shaped links, an SEO site impersonating
    // the official China Scholarship Council. It must not become a source.
    assert.equal(classifyAuthority("https://www.chinesescholarshipcouncil.com/"), "other");
    assert.equal(
      classifyAuthority("https://www.scholarship-positions.com/chevening", {
        knownInstitutions: new Set(["scholarship-positions.com"]),
      }),
      "other",
      "the denylist must beat the institution registry",
    );
  });

  test("a registry of institutions promotes hosts the suffixes miss", () => {
    // ROR knows an accredited body when its domain does not advertise one.
    assert.equal(
      classifyAuthority("https://www.dukekunshan.edu.cn/admissions", {
        knownInstitutions: new Set(["dukekunshan.edu.cn"]),
      }),
      "official",
    );
  });

  test("a different university is official but never the funder", () => {
    // The distinction the whole reconciliation rests on: Bristol writing about
    // Chevening is a good source and is not Chevening.
    assert.equal(
      classifyAuthority("https://www.bristol.ac.uk/scholarships/chevening", { funderUrl }),
      "official",
    );
  });

  test("a malformed URL is never trusted", () => {
    assert.equal(classifyAuthority("not a url"), "other");
    assert.equal(classifyAuthority(""), "other");
  });
});

describe("conflict resolution", () => {
  test("the funder outranks everything", () => {
    assert.equal(strongerAuthority("funder", "official"), "funder");
    assert.equal(strongerAuthority("other", "funder"), "funder");
    assert.equal(strongerAuthority("official", "other"), "official");
  });
});

describe("institution ranking", () => {
  test("universities outrank professional colleges", async () => {
    // The UK run surfaced the Royal College of Obstetricians (50 award pages)
    // and the Royal College of Surgeons (11) above actual universities, because
    // the first ranking preferred the word "college". Those awards are travel
    // fellowships for the college's own medical trainees — real, institutional,
    // and not a scholarship any applicant can use for a degree.
    const { rankInstitutionName } = await import("./institutions.ts");

    const university = rankInstitutionName("Harper Adams University");
    for (const body of [
      "Royal College of Obstetricians and Gynaecologists",
      "Royal College of Surgeons of Edinburgh",
      "Korea Children's Rights Society",
      "Association of Commonwealth Universities",
    ]) {
      assert.ok(
        rankInstitutionName(body) < university,
        `"${body}" ranked at or above a university`,
      );
    }
  });

  test("a plain college still beats an unrecognised name", async () => {
    const { rankInstitutionName } = await import("./institutions.ts");
    assert.ok(rankInstitutionName("St Mary's University College") > rankInstitutionName("KSUM"));
  });
});
