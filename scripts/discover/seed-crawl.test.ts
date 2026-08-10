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
