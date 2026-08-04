import assert from "node:assert/strict";
import { test, describe } from "node:test";

// Explicit .ts extensions: Node's test runner resolves these itself, without
// the bundler's extensionless resolution.
import {
  describeCommitment,
  displayCountry,
  hasProfileData,
  recordList,
  safeText,
  summariseChecklist,
  textList,
} from "./format.ts";
import type { Scholarship } from "./types/database.ts";

/**
 * These helpers decide what a card CLAIMS. Getting them wrong is not a cosmetic
 * bug: "No bond" on a programme nobody has read is a promise the data cannot
 * keep, and a student reads it as a fact about their next five years.
 */

type CommitmentInput = Parameters<typeof describeCommitment>[0];

function row(patch: Partial<Scholarship> = {}): CommitmentInput {
  return {
    post_study_obligations: null,
    coverage_matrix: {},
    eligibility_flags: {} as Scholarship["eligibility_flags"],
    document_checklist: [],
    ...patch,
  } as CommitmentInput;
}

describe("post-study commitment", () => {
  test("a stated obligation is reported", () => {
    const info = describeCommitment(row({ post_study_obligations: "Return home for two years" }));
    assert.equal(info.state, "obligation");
  });

  test("an unread programme says so instead of promising freedom", () => {
    // The bug: every skeleton row from discovery advertised "No bond", so the
    // dashboard showed the same programme with opposite badges.
    const info = describeCommitment(row());
    assert.equal(info.state, "unknown");
    assert.match(info.label, /not stated/i);
  });

  test("a profiled programme with no obligation found is a real 'no bond'", () => {
    const info = describeCommitment(row({ coverage_matrix: { tuition: { covered: true } } }));
    assert.equal(info.state, "none");
  });

  test("whitespace is not an obligation", () => {
    assert.equal(describeCommitment(row({ post_study_obligations: "   " })).state, "unknown");
  });
});

describe("profile detection", () => {
  test("any one of the three sections counts", () => {
    assert.equal(hasProfileData(row()), false);
    assert.equal(hasProfileData(row({ document_checklist: [{ key: "a", label: "A", required: true }] })), true);
    assert.equal(
      hasProfileData(row({ eligibility_flags: { max_age: 35 } as Scholarship["eligibility_flags"] })),
      true,
    );
  });
});

describe("country display", () => {
  test("folds the spellings that split a filter facet", () => {
    assert.equal(displayCountry("United Kingdom"), "UK");
    assert.equal(displayCountry("United States"), "USA");
  });

  test("passes anything else through untouched", () => {
    assert.equal(displayCountry("Japan"), "Japan");
    assert.equal(displayCountry("Germany"), "Germany");
  });
});

describe("checklist summary", () => {
  test("survives a column that is not the array the type promises", () => {
    // Rows arrive from seed.sql, promote_candidate() and apply_extraction(),
    // which do not agree on shape. A throw here is a blank page.
    const stats = summariseChecklist({} as never, {});
    assert.equal(stats.total, 0);
    assert.equal(stats.percent, 0);
  });

  test("counts required documents separately from optional ones", () => {
    const stats = summariseChecklist(
      [
        { key: "a", label: "A", required: true },
        { key: "b", label: "B", required: false },
      ],
      { a: true },
    );
    assert.equal(stats.requiredTotal, 1);
    assert.equal(stats.requiredCompleted, 1);
    assert.equal(stats.total, 2);
    assert.equal(stats.percent, 50);
  });
});

/**
 * The rendering guards. Every case below is a value the TYPES say cannot exist
 * and the database will happily store: JSONB has no shape constraint, a row
 * promoted from discovery starts empty, and a truncated model response leaves
 * half-built objects behind. Each one used to be a blank page rather than a
 * missing badge, because an exception in a card takes the whole route down.
 */
describe("rendering guards", () => {
  describe("textList", () => {
    test("survives every shape a column is not supposed to hold", () => {
      for (const value of [null, undefined, {}, "Masters", 42, true]) {
        assert.deepEqual(textList(value), [], `failed on ${JSON.stringify(value)}`);
      }
    });

    test("keeps the strings and drops everything else in a mixed array", () => {
      assert.deepEqual(
        textList(["Masters", null, { level: "PhD" }, "", "  ", "PhD", 7]),
        ["Masters", "PhD"],
      );
    });
  });

  describe("recordList", () => {
    test("a non-array is an empty list, not a crash", () => {
      for (const value of [null, undefined, {}, "[]", 0]) {
        assert.deepEqual(recordList(value), [], `failed on ${JSON.stringify(value)}`);
      }
    });

    test("null elements are dropped before anything reads a property off them", () => {
      // The actual failure: a stage array with a null in it threw on
      // `stage.key` and blanked the detail sheet.
      const stages = recordList<{ key?: string }>([
        { key: "opens" },
        null,
        "closes",
        { key: "results" },
      ]);
      assert.equal(stages.length, 2);
      assert.deepEqual(stages.map((stage) => stage.key), ["opens", "results"]);
    });
  });

  describe("safeText", () => {
    test("an object never reaches React as a child", () => {
      // "Objects are not valid as a React child" is a thrown error, not a
      // warning, and it takes the page with it.
      for (const value of [{}, { note: "x" }, [], null, undefined, "", "   ", NaN]) {
        assert.equal(safeText(value), null, `failed on ${JSON.stringify(value)}`);
      }
    });

    test("real text and real numbers come through", () => {
      assert.equal(safeText("  Return home for two years "), "Return home for two years");
      assert.equal(safeText(2026), "2026");
    });
  });
});
