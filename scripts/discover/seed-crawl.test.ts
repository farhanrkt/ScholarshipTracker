import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { buildKnowledge, matchKnownProgramme } from "./seed-crawl.ts";

/**
 * Discovery's dedupe decides what becomes a row, and it is where the catalogue's
 * duplicates came from: an exact-title check let `Chevening Scholarship` and
 * `Chevening Scholarships` both through, and three Humphrey rows after that.
 *
 * The direction of error matters here more than the rate. A missed duplicate
 * reaches the merge page and a human fixes it. A WRONG match is a programme
 * silently never staged, and nothing records what discovery declined — so the
 * "must not match" cases are the ones that earn their place.
 */

function knowledgeOf(...rows: Array<[string, string]>) {
  return buildKnowledge({
    scholarships: rows.map(([title, official_portal_url], index) => ({
      id: `row-${index}`,
      title,
      official_portal_url,
      source_url: null,
    })),
    candidates: [],
  });
}

const CHEVENING = "https://www.chevening.org/scholarships/";

describe("recognising a programme we already have", () => {
  test("an exact title still matches, from any site", () => {
    const match = matchKnownProgramme(
      knowledgeOf(["Chevening Scholarships", CHEVENING]),
      "Chevening Scholarships",
      "https://www.some-university.ac.uk/funding/chevening",
    );

    assert.equal(match?.reason, "same title");
    assert.equal(match?.row?.id, "row-0");
  });

  test("plurals no longer create a second row", () => {
    const match = matchKnownProgramme(
      knowledgeOf(["Chevening Scholarships", CHEVENING]),
      "Chevening Scholarship",
      CHEVENING,
    );

    assert.notEqual(match, null);
  });

  test("a qualifier on the same site is recognised", () => {
    const match = matchKnownProgramme(
      knowledgeOf(["Humphrey Fellowship Program", "https://www.humphreyfellowship.org/"]),
      "Hubert H. Humphrey Fellowship Program",
      "https://www.humphreyfellowship.org/how-to-apply/",
    );

    assert.match(match?.reason ?? "", /likely match/);
    // Reported, but not acted on — see the `likely` describe below. This pair
    // really is one programme; the rule that found it is wrong more often than
    // it is right, so a person decides.
    assert.equal(match?.confidence, "likely");
  });

  test("a fellowship is not the scholarship of the same name", () => {
    assert.equal(
      matchKnownProgramme(
        knowledgeOf(["Chevening Scholarships", CHEVENING]),
        "Chevening Fellowships",
        "https://www.chevening.org/fellowships/",
      ),
      null,
    );
  });

  test("a merely possible match is staged, not silently dropped", () => {
    // Nothing records what discovery declines to stage, so a wrong drop is
    // invisible and permanent. "Possible" belongs on the duplicates page, in
    // front of a person, not in an automatic filter.
    // Two of three distinctive words shared, and neither name contains the
    // other — the shape of a "possible" match.
    assert.equal(
      matchKnownProgramme(
        knowledgeOf(["Rockefeller Brothers Fund Fellowship", "https://example.org/a"]),
        "Rockefeller Brothers Trust Fellowship",
        "https://example.org/b",
      ),
      null,
    );
  });

  test("a genuinely new programme on a known site is staged", () => {
    assert.equal(
      matchKnownProgramme(
        knowledgeOf(["Dissertation Completion Fellowships", "https://gsas.harvard.edu/a"]),
        "Foreign Language and Area Studies Fellowships",
        "https://gsas.harvard.edu/b",
      ),
      null,
    );
  });

  test("the same name on a different funder's site is a different programme", () => {
    assert.equal(
      matchKnownProgramme(
        knowledgeOf(["Vernova STAR Scholarship", "https://www.iie.org/a"]),
        "Vernova STAR Scholarship Fund",
        "https://example.edu/b",
      ),
      null,
    );
  });

  test("a row with no portal URL cannot be near-matched", () => {
    // buildKnowledge only records an address when there is one, and a match
    // without an address would be a name comparison across the whole internet.
    const knowledge = buildKnowledge({
      scholarships: [
        { id: "row-0", title: "Chevening Scholarships", official_portal_url: null, source_url: null },
      ],
      candidates: [],
    });

    assert.equal(knowledge.rows.length, 0);
    assert.equal(
      matchKnownProgramme(knowledge, "Chevening SIDS Scholarship", CHEVENING),
      null,
    );
  });
});

/**
 * Which matches discovery acts on by itself.
 *
 * `certain` means the fingerprints are equal, and the caller drops the
 * candidate. `likely` means "same site, and one title is the other plus a
 * qualifier" — which, read against all 14 grouped rows in the live catalogue
 * (docs/duplicate-verdicts.md), was right once in six. It is right about the
 * two Humphrey rows and wrong about the five below, each a separate award with
 * its own eligibility.
 *
 * So the caller stages a `likely` and lets /admin/duplicates ask a person. The
 * asymmetry is the whole argument: a duplicate row is visible and one click to
 * fix, while a dropped programme leaves no trace anywhere and is gone for good.
 */
describe("only an exact match is acted on", () => {
  test("an exact title is certain", () => {
    assert.equal(
      matchKnownProgramme(
        knowledgeOf(["Chevening Scholarships", CHEVENING]),
        "Chevening Scholarships",
        CHEVENING,
      )?.confidence,
      "certain",
    );
  });

  test("a plural is certain — this is the pair that made two rows", () => {
    assert.equal(
      matchKnownProgramme(
        knowledgeOf(["Chevening Scholarships", CHEVENING]),
        "Chevening Scholarship",
        CHEVENING,
      )?.confidence,
      "certain",
    );
  });

  // One case per row the old threshold would have silently refused to stage.
  // The funder's own words for each are quoted in docs/duplicate-verdicts.md.
  for (const [name, known, candidate, url] of [
    [
      // "from a Commonwealth Small Island Developing State (SIDS)", and listed
      // beside the standard award on chevening.org/scholarships/.
      "Chevening SIDS",
      ["Chevening Scholarships", CHEVENING],
      "Chevening SIDS Scholarship",
      "https://www.chevening.org/sids-chevening-scholarship/",
    ],
    [
      // Five months at the Oxford Centre for Islamic Studies, and its
      // eligibility list names Indonesia. The one this catalogue most needs.
      "Chevening OCIS",
      ["Chevening Fellowships", "https://www.chevening.org/fellowships/"],
      "Chevening Oxford Centre for Islamic Studies Fellowship",
      "https://www.chevening.org/fellowship/ocis/",
    ],
    [
      // "Be a citizen of China, currently live in the country".
      "Chevening LSE",
      ["Chevening Fellowships", "https://www.chevening.org/fellowships/"],
      "Chevening LSE Fellowship",
      "https://www.chevening.org/fellowship/lse/",
    ],
    [
      // Harvard's own navigation lists these as siblings under Summer
      // Fellowships.
      "Harvard's two language fellowships",
      ["Language Study Fellowships", "https://gsas.harvard.edu/academics/fellowships/a"],
      "Foreign Language and Area Studies Fellowships",
      "https://gsas.harvard.edu/academics/fellowships/b",
    ],
    [
      // "Learn how to apply to the Fulbright Foreign Student and FLTA
      // programs" — Fulbright's own front page, naming two.
      "Fulbright FLTA",
      ["Fulbright Foreign Student Program", "https://foreign.fulbrightonline.org/"],
      "Fulbright Foreign Language Teaching Assistant Program",
      "https://foreign.fulbrightonline.org/host-institutions/flta-program/",
    ],
  ] as const) {
    test(`${name} is reported as likely, never certain`, () => {
      const match = matchKnownProgramme(
        knowledgeOf(known as [string, string]),
        candidate,
        url,
      );

      assert.notEqual(match, null, "the reviewer should still be told");
      assert.equal(match?.confidence, "likely");
    });
  }
});
