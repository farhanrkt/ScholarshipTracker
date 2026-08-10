import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  GAP_FIELDS,
  describeGaps,
  mergeProfiles,
  profileCompleteness,
  profileGaps,
  selectGapPassages,
  type GapField,
} from "./gaps.ts";
import type { GroundedProfile } from "./ground.ts";
import type { FetchedPage } from "./page.ts";
import type { Passage } from "./passages.ts";

/**
 * The second look is the pass that decides whether a staged row is a deadline
 * and a column of blanks or something a student can plan against. Two things
 * have to hold for it to be worth its model call: it must know exactly what is
 * missing, and it must be able to find the one sentence that answers it in a
 * page that already lost the budget contest.
 */

function proposed(
  patch: Partial<GroundedProfile["proposed"]> = {},
): GroundedProfile["proposed"] {
  return {
    coverage_matrix: {},
    eligibility_flags: {},
    document_checklist: [],
    post_study_obligations: null,
    language_training_included: null,
    fields_of_study: [],
    award_duration: null,
    number_of_awards: null,
    ...patch,
  };
}

function grounded(patch: Partial<GroundedProfile> = {}): GroundedProfile {
  return {
    proposed: proposed(),
    evidence: {},
    ungroundedFields: [],
    caveats: [],
    eligibilitySilent: [],
    ...patch,
  };
}

function page(text: string, url = "https://example.org/a"): FetchedPage {
  return { url, text, html: "", sha256: "x", fetchedAt: "2026-08-03T00:00:00Z" };
}

describe("knowing what is missing", () => {
  test("an unread programme is every slot", () => {
    assert.equal(profileGaps(null).length, GAP_FIELDS.length);
    assert.deepEqual(profileCompleteness(null), { filled: 0, total: GAP_FIELDS.length });
  });

  test("a filled slot stops being a gap", () => {
    const gaps = profileGaps(
      proposed({
        coverage_matrix: { tuition: { covered: true, detail: "Full fees" } },
        eligibility_flags: { max_age: 35 },
        award_duration: "up to 3 years",
      }),
    );

    assert.equal(gaps.includes("coverage.tuition"), false);
    assert.equal(gaps.includes("eligibility.max_age"), false);
    assert.equal(gaps.includes("award_duration"), false);
    assert.equal(gaps.includes("coverage.airfare"), true);
  });

  test("a coverage line the pages denied still counts as answered", () => {
    // covered=false is a fact the page stated, not a hole. Asking again would
    // spend a model call re-reading a sentence we already have.
    const gaps = profileGaps(
      proposed({ coverage_matrix: { airfare: { covered: false, detail: null } } }),
    );

    assert.equal(gaps.includes("coverage.airfare"), false);
  });

  test("false is an answer and an empty array is not", () => {
    // `requires_government_nomination: false` means the pages said no
    // nomination is needed. `accepted_language_tests: []` means nothing was
    // found — which is what a gap is.
    const gaps = profileGaps(
      proposed({
        eligibility_flags: {
          requires_government_nomination: false,
          accepted_language_tests: [],
        },
      }),
    );

    assert.equal(gaps.includes("eligibility.requires_government_nomination"), false);
    assert.equal(gaps.includes("eligibility.accepted_language_tests"), true);
  });

  test("min_work_experience_years of zero is an answer", () => {
    // "No work experience is required" is a real, quotable fact, and zero is
    // how it is stored. A falsy check would ask for it again forever.
    const gaps = profileGaps(
      proposed({ eligibility_flags: { min_work_experience_years: 0 } }),
    );

    assert.equal(gaps.includes("eligibility.min_work_experience_years"), false);
  });

  test("the prompt names each gap in words a page would use", () => {
    const described = describeGaps(["eligibility.max_age", "coverage.airfare"]);

    assert.match(described, /eligibility\.max_age: .*age/);
    assert.match(described, /coverage\.airfare: .*(flight|travel)/);
  });
});

describe("retrieving passages for the gaps", () => {
  const AGE_SENTENCE =
    "Applicants must be under the age of 35 on the closing date of the round.";

  test("finds the one sentence that answers a gap", () => {
    const passages = selectGapPassages(
      [
        page(
          `Our history and our founders.\n\nA long paragraph about the campus and the city.\n\n${AGE_SENTENCE}\n\nMore about parking and the bus routes serving the campus.`,
        ),
      ],
      ["eligibility.max_age"],
      { budgetChars: 4_000 },
    );

    assert.equal(passages.length > 0, true);
    assert.equal(
      passages.some((passage) => passage.text.includes("under the age of 35")),
      true,
    );
  });

  test("a page with none of the gap vocabulary contributes nothing", () => {
    // Otherwise the second call receives the first call's context again and
    // answers it the same way, for the price of a model call.
    const passages = selectGapPassages(
      [page("Our history, our founders, and directions to the campus by bus.")],
      ["eligibility.max_age", "coverage.airfare"],
      { budgetChars: 4_000 },
    );

    assert.deepEqual(passages, []);
  });

  test("new material wins the budget over text the first call already read", () => {
    // Blocks have to clear toBlocks' soft minimum to stay separate — the gap
    // pass deliberately cuts the page exactly as the first pass did.
    const filler =
      "This paragraph exists to carry the block past the length at which a paragraph break is allowed to end it, so that the two candidates below are scored and ranked separately rather than glued into one.";
    const seen = `${AGE_SENTENCE} ${filler}`;
    const unseen = `Applicants may be no older than 35 years of age at the closing date. ${filler}`;

    const alreadySent: Passage[] = [
      { url: "https://example.org/a", text: seen, score: 1, topic: "eligibility", index: 0 },
    ];

    // Room for one of the two. The one the model has not read wins it.
    const passages = selectGapPassages(
      [page(`${seen}\n\n${unseen}`)],
      ["eligibility.max_age"],
      { budgetChars: seen.length + 10, alreadySent },
    );

    assert.deepEqual(
      passages.map((passage) => passage.text),
      [unseen],
    );
  });

  test("the budget is respected", () => {
    const passages = selectGapPassages(
      [page(`${AGE_SENTENCE}\n\n${AGE_SENTENCE}\n\n${AGE_SENTENCE}`)],
      ["eligibility.max_age"],
      { budgetChars: 40 },
    );

    const used = passages.reduce((sum, passage) => sum + passage.text.length, 0);
    assert.equal(used <= 40, true);
  });

  test("no gaps means no retrieval and no call", () => {
    assert.deepEqual(
      selectGapPassages([page(AGE_SENTENCE)], [] as GapField[], { budgetChars: 4_000 }),
      [],
    );
  });
});

describe("merging the second look into the first", () => {
  test("holes are filled and nothing established is overwritten", () => {
    const base = grounded({
      proposed: proposed({
        coverage_matrix: { tuition: { covered: true, detail: "Full fees" } },
        award_duration: "up to 3 years",
      }),
    });

    const extra = grounded({
      proposed: proposed({
        // A contradictory reading of a slot the first pass already settled.
        coverage_matrix: {
          tuition: { covered: false, detail: null },
          airfare: { covered: true, detail: "One return economy flight" },
        },
        award_duration: "one academic year",
        number_of_awards: "around 1,500 each year",
      }),
    });

    const merged = mergeProfiles(base, extra);

    assert.equal(merged.proposed.coverage_matrix.tuition?.covered, true);
    assert.equal(merged.proposed.coverage_matrix.tuition?.detail, "Full fees");
    assert.equal(merged.proposed.award_duration, "up to 3 years");
    assert.equal(merged.proposed.coverage_matrix.airfare?.detail, "One return economy flight");
    assert.equal(merged.proposed.number_of_awards, "around 1,500 each year");
  });

  test("merging can only raise completeness", () => {
    const base = grounded({ proposed: proposed({ award_duration: "up to 3 years" }) });
    const extra = grounded({
      proposed: proposed({ number_of_awards: "up to 20", fields_of_study: ["Engineering"] }),
    });

    const before = profileCompleteness(base.proposed).filled;
    const after = profileCompleteness(mergeProfiles(base, extra).proposed).filled;

    assert.equal(after, before + 2);
  });

  test("a null first reading is replaced wholesale", () => {
    const extra = grounded({ proposed: proposed({ award_duration: "one academic year" }) });
    assert.equal(mergeProfiles(null, extra).proposed.award_duration, "one academic year");
  });

  test("a grounded quote is not shadowed by the failed one it replaces", () => {
    // The first pass recorded max_age with a quote that grounding rejected.
    // If that entry won the merge, the review UI would show no evidence for a
    // value the second look did in fact find on the page.
    const base = grounded({
      evidence: {
        "eligibility.max_age": {
          quote: "under 35",
          grounded: false,
          confidence: "high",
          source_url: null,
          match: null,
        },
      },
    });

    const extra = grounded({
      proposed: proposed({ eligibility_flags: { max_age: 35 } }),
      evidence: {
        "eligibility.max_age": {
          quote: "Applicants must be under the age of 35 on the closing date",
          grounded: true,
          confidence: "high",
          source_url: "https://example.org/a",
          match: "exact",
        },
      },
    });

    const merged = mergeProfiles(base, extra);

    assert.equal(merged.evidence["eligibility.max_age"]?.grounded, true);
    assert.equal(merged.proposed.eligibility_flags.max_age, 35);
  });

  test("what each pass threw away is reported together", () => {
    const base = grounded({ ungroundedFields: ["coverage.tuition (…)"] });
    const extra = grounded({ ungroundedFields: ["eligibility.max_age (…)"] });

    assert.equal(mergeProfiles(base, extra).ungroundedFields.length, 2);
  });
});

describe("recording what the pages did not answer", () => {
  test("a question answered by either pass carries no silence marker", () => {
    // A marker beside a real value is only a chance to disagree with it.
    const base = grounded({ eligibilitySilent: ["max_age", "min_ielts"] });
    const extra = grounded({
      proposed: proposed({ eligibility_flags: { max_age: 35 } }),
      eligibilitySilent: ["min_toefl_ibt"],
    });

    const merged = mergeProfiles(base, extra);

    assert.equal(merged.eligibilitySilent.includes("max_age"), false);
    assert.deepEqual(merged.eligibilitySilent.sort(), ["min_ielts", "min_toefl_ibt"]);
  });

  test("either pass hearing silence is enough to record it", () => {
    const merged = mergeProfiles(
      grounded({ eligibilitySilent: ["max_age"] }),
      grounded({ eligibilitySilent: ["max_age", "min_gpa_4_scale"] }),
    );

    assert.deepEqual(merged.eligibilitySilent.sort(), ["max_age", "min_gpa_4_scale"]);
  });
});
