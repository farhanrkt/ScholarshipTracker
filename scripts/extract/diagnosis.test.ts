import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  describeCauses,
  diagnoseGaps,
  gapPhrases,
  notStatedFields,
  recoverableCount,
  starvedTopics,
} from "./diagnosis.ts";
import type { GapField } from "./gaps.ts";
import type { FetchedPage } from "./page.ts";
import type { Passage } from "./passages.ts";
import type { Topic } from "./relevance.ts";

/**
 * These decide what an operator does next, and every wrong answer sends them
 * somewhere useless: a `not-published` that should have been `never-crawled`
 * means a recoverable blank is filed as the funder's decision and never looked
 * at again, and the reverse means somebody re-runs a crawl over a page that
 * does not contain the answer. The `not-published` direction is the dangerous
 * one, because it also reaches a student as "the programme does not state
 * this" — a claim about the funder made on the strength of our own failure.
 */

function page(text: string, url = "https://example.org/a"): FetchedPage {
  return { url, text, html: "", sha256: "x", fetchedAt: "2026-08-03T00:00:00Z" };
}

function passage(text: string, url = "https://example.org/a"): Passage {
  return { url, text, score: 10, topic: "benefits", index: 0 };
}

const counts = (patch: Partial<Record<Topic, number>> = {}) => ({
  dates: 0,
  eligibility: 0,
  benefits: 0,
  documents: 0,
  process: 0,
  ...patch,
});

const base = {
  pages: [] as FetchedPage[],
  sent: [] as Passage[],
  topicCounts: counts(),
  ungrounded: [] as string[],
  silent: [] as string[],
};

describe("diagnosing why a field is blank", () => {
  test("a topic with no pages fetched is never-crawled, not not-published", () => {
    // The whole point. `coverage.airfare` needs a `benefits` page and none was
    // fetched, so nothing could have answered it — reporting that as "the
    // programme does not state it" would tell a student we checked when the
    // crawler never downloaded a page that could have said so.
    const causes = diagnoseGaps({
      ...base,
      gaps: ["coverage.airfare"],
      topicCounts: counts({ dates: 3 }),
    });

    assert.equal(causes["coverage.airfare"], "never-crawled");
  });

  test("a crawled topic whose vocabulary is absent everywhere is not-published", () => {
    // The benefits page was read and says nothing about flights anywhere in it.
    // That is as close to "the funder does not publish this" as a crawler gets,
    // and it is the only cause allowed to reach a student as an answer.
    const causes = diagnoseGaps({
      ...base,
      gaps: ["coverage.airfare"],
      pages: [page("The award covers tuition in full and a monthly stipend.")],
      topicCounts: counts({ benefits: 2 }),
    });

    assert.equal(causes["coverage.airfare"], "not-published");
  });

  test("vocabulary in the crawl that never reached a passage is not-retrieved", () => {
    // The fix for this one is in retrieval, not in the crawl and not in the
    // prompt. Reporting it as model-silent would send somebody to rewrite a
    // prompt that never received the sentence.
    const causes = diagnoseGaps({
      ...base,
      gaps: ["coverage.airfare"],
      pages: [page("Scholars receive a return airfare to their home country.")],
      sent: [passage("The award covers tuition fees in full.")],
      topicCounts: counts({ benefits: 2 }),
    });

    assert.equal(causes["coverage.airfare"], "not-retrieved");
  });

  test("vocabulary the model was actually sent and did not answer is model-silent", () => {
    const causes = diagnoseGaps({
      ...base,
      gaps: ["coverage.airfare"],
      pages: [page("Scholars receive a return airfare to their home country.")],
      sent: [passage("Scholars receive a return airfare to their home country.")],
      topicCounts: counts({ benefits: 2 }),
    });

    assert.equal(causes["coverage.airfare"], "model-silent");
  });

  test("a value grounding threw away is reported as such, not as a retrieval bug", () => {
    // Grounding rejecting a claim is the pipeline WORKING — the model produced
    // a quote that was not on the page. Filing it under `not-retrieved` would
    // put a correctly-rejected fabrication on the list of things to go and
    // fetch harder.
    const causes = diagnoseGaps({
      ...base,
      gaps: ["coverage.monthly_stipend"],
      pages: [page("A monthly stipend is paid to every scholar.")],
      sent: [passage("A monthly stipend is paid to every scholar.")],
      topicCounts: counts({ benefits: 2 }),
      ungrounded: [
        'coverage.monthly_stipend detail (claimed "GBP 1,347", but the quote does not contain that figure)',
      ],
    });

    assert.equal(causes["coverage.monthly_stipend"], "grounding-rejected");
  });

  test("documents map back from the indexed form grounding reports them in", () => {
    // `ungroundedFields` says `documents[0] (claimed "Transcript"…)`, and the
    // gap slot is called `document_checklist`. Without the mapping a rejected
    // checklist reads as a crawl failure.
    const causes = diagnoseGaps({
      ...base,
      gaps: ["document_checklist"],
      pages: [page("Upload your transcript and two reference letters.")],
      sent: [passage("Upload your transcript and two reference letters.")],
      topicCounts: counts({ documents: 1 }),
      ungrounded: ['documents[0] (claimed "Transcript", quote not found)'],
    });

    assert.equal(causes.document_checklist, "grounding-rejected");
  });

  test("an explicit 'the pages do not say' outranks every inference", () => {
    // The reader had the passages and reported the silence. That is a stronger
    // answer than anything the vocabulary search can infer, so it wins even
    // where the phrases ARE present on a page.
    const causes = diagnoseGaps({
      ...base,
      gaps: ["eligibility.max_age"],
      pages: [page("There is no upper age limit mentioned; aged applicants welcome.")],
      sent: [passage("aged applicants welcome")],
      topicCounts: counts({ eligibility: 2 }),
      silent: ["max_age"],
    });

    assert.equal(causes["eligibility.max_age"], "not-published");
  });

  test("silence markers arrive bare for eligibility and prefixed for the rest", () => {
    const causes = diagnoseGaps({
      ...base,
      gaps: ["eligibility.max_age", "award_duration"],
      topicCounts: counts({ eligibility: 1, benefits: 1 }),
      silent: ["max_age", "award_duration"],
    });

    assert.equal(causes["eligibility.max_age"], "not-published");
    assert.equal(causes.award_duration, "not-published");
  });
});

describe("what the diagnosis is used for", () => {
  test("only not-published reaches the row as 'the programme does not state this'", () => {
    // The narrowness IS the safety property. A blank caused by our own crawl
    // must never be shown to a student as a fact about the funder.
    const causes = {
      "coverage.airfare": "never-crawled",
      "coverage.tuition": "not-retrieved",
      "coverage.accommodation": "model-silent",
      "coverage.visa_fees": "grounding-rejected",
      "coverage.research_grant": "not-published",
    } as const;

    assert.deepEqual(notStatedFields({ ...causes }), ["coverage.research_grant"]);
  });

  test("recoverable counts the three causes that are ours", () => {
    const causes = {
      a: "never-crawled",
      b: "not-retrieved",
      c: "model-silent",
      d: "grounding-rejected",
      e: "not-published",
    } as const;

    assert.equal(recoverableCount({ ...causes }), 3);
  });

  test("only never-crawled asks for another crawl", () => {
    // A second crawl fixes pages we never fetched. Spending one on a field the
    // model simply went past re-downloads what we already have.
    const topics = starvedTopics({
      "coverage.airfare": "never-crawled",
      "eligibility.max_age": "model-silent",
    });

    assert.deepEqual(topics, ["benefits"]);
  });

  test("the phrase list for a second crawl is deduplicated across fields", () => {
    const phrases = gapPhrases([
      "coverage.tuition",
      "coverage.tuition",
    ] as GapField[]);

    assert.equal(new Set(phrases).size, phrases.length);
    assert.ok(phrases.includes("tuition fee"));
  });

  test("the summary names every cause present and nothing else", () => {
    const line = describeCauses({
      a: "never-crawled",
      b: "never-crawled",
      c: "not-published",
    });

    assert.equal(line, "2 never-crawled · 1 not-published");
    assert.equal(describeCauses({}), "no gaps");
  });
});
