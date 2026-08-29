import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { repairCycle, repairProfile } from "./extract.ts";
import { CycleExtractionSchema, ProfileExtractionSchema } from "./schema.ts";

/**
 * Repairing a response from a provider that cannot enforce a schema.
 *
 * Groq's `llama-3.3-70b-versatile` rejects `json_schema` mode and falls back to
 * plain `json_object`, so nothing constrains its output. One omitted sub-object
 * used to make zod reject the ENTIRE response — a complete, correctly quoted
 * profile thrown away, which meant `--escalate` was configured, paid for in
 * wall-clock, and could not land.
 *
 * The line these tests hold is that repairs may only ever throw information
 * away or fill in "not answered". Never a value, never a quote.
 */

describe("repairing a schema-less response", () => {
  test("an empty response becomes a valid, wholly empty extraction", () => {
    // This is also the drift guard: add a field to either schema without adding
    // it to the skeleton and this test fails, rather than escalation silently
    // breaking again on a provider nobody runs by default.
    const cycle = CycleExtractionSchema.parse(repairCycle({}));
    assert.equal(cycle.deadline_date.value, null);
    assert.deepEqual(cycle.timeline, []);

    const profile = ProfileExtractionSchema.parse(repairProfile({}));
    assert.equal(profile.eligibility.max_age.value, null);
    assert.deepEqual(profile.eligibility.accepted_language_tests.values, []);
    assert.deepEqual(profile.coverage, []);
    assert.equal(profile.award_duration.value, null);
  });

  test("a missing eligibility field does not cost the rest of the response", () => {
    const raw = {
      page_subject: "Chevening",
      page_is_about_requested_programme: true,
      coverage: [
        {
          key: "tuition",
          covered: true,
          detail: null,
          evidence_quote: "Chevening pays your university tuition fees",
        },
      ],
      eligibility: { max_age: { value: 35, evidence_quote: "under the age of 35" } },
      documents: [],
      post_study_obligations: { value: null, evidence_quote: null, confidence: "high" },
      language_training_included: { value: null, evidence_quote: null },
      fields_of_study: { values: [], evidence_quote: null },
      award_duration: { value: null, evidence_quote: null, confidence: "high" },
      number_of_awards: { value: null, evidence_quote: null, confidence: "high" },
      notes_for_reviewer: "",
    };

    const profile = ProfileExtractionSchema.parse(repairProfile(raw));

    assert.equal(profile.eligibility.max_age.value, 35);
    assert.equal(profile.eligibility.min_ielts.value, null);
    assert.equal(profile.coverage[0]?.key, "tuition");
  });

  test("an unusable confidence becomes low rather than a rejected response", () => {
    const cycle = CycleExtractionSchema.parse(
      repairCycle({
        deadline_date: {
          value: "2026-10-06",
          evidence_quote: "Applications close on 6 October 2026",
          confidence: "very high",
        },
      }),
    );

    assert.equal(cycle.deadline_date.value, "2026-10-06");
    assert.equal(cycle.deadline_date.confidence, "low");
  });

  test("a coverage entry that claims nothing is dropped, not defaulted", () => {
    // `covered: null` is how an unconstrained model says "the pages are silent".
    // Defaulting it either way would put a claim on a student's funding that
    // nothing on the page supports.
    const profile = ProfileExtractionSchema.parse(
      repairProfile({
        coverage: [
          { key: "airfare", covered: null, detail: null, evidence_quote: null },
          {
            key: "tuition",
            covered: true,
            detail: null,
            evidence_quote: "we pay your tuition",
          },
        ],
      }),
    );

    assert.equal(profile.coverage.length, 1);
    assert.equal(profile.coverage[0]?.key, "tuition");
  });

  test("silence about the page identity is not read as assent", () => {
    // The guard against redirects and cookie walls. A model that did not answer
    // has not vouched for the page, and the extraction is dropped.
    const profile = ProfileExtractionSchema.parse(repairProfile({}));
    assert.equal(profile.page_is_about_requested_programme, false);
  });

  test("a real answer is never overwritten by the skeleton", () => {
    const cycle = CycleExtractionSchema.parse(
      repairCycle({
        page_subject: "Gates Cambridge",
        page_is_about_requested_programme: true,
        notes_for_reviewer: "Two cycles are published.",
      }),
    );

    assert.equal(cycle.page_subject, "Gates Cambridge");
    assert.equal(cycle.page_is_about_requested_programme, true);
    assert.equal(cycle.notes_for_reviewer, "Two cycles are published.");
  });
});

describe("repairing the not-stated list", () => {
  test("an omitted list becomes empty, never a claim of silence", () => {
    // A model that says nothing about silence has told us nothing about
    // silence. Defaulting to a populated list would put "the programme does not
    // state this" on a card on the strength of a missing key.
    const profile = ProfileExtractionSchema.parse(repairProfile({}));
    assert.deepEqual(profile.not_stated, []);
  });

  test("a bare string is read as a list of one", () => {
    const profile = ProfileExtractionSchema.parse(
      repairProfile({ not_stated: "coverage.airfare" }),
    );
    assert.deepEqual(profile.not_stated, ["coverage.airfare"]);
  });

  test("non-string entries are dropped rather than failing the whole response", () => {
    // The same rule as every other repair here: discard information, never
    // invent it, and never lose a complete extraction over its least important
    // field.
    const profile = ProfileExtractionSchema.parse(
      repairProfile({ not_stated: ["coverage.airfare", null, 7, "", { a: 1 }] }),
    );
    assert.deepEqual(profile.not_stated, ["coverage.airfare"]);
  });
});
