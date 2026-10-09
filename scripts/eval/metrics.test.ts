import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  ANTHROPIC_PRICES,
  callCost,
  classifyDiscards,
  countKeptValues,
  summarise,
  type RunMetrics,
} from "./metrics.ts";

describe("countKeptValues", () => {
  test("counts scalars once, lists per item, objects per key", () => {
    const proposed = {
      cycle_label: "2027 intake",
      opens_date: "2026-11-01",
      deadline_date: null,
      timeline: [{ key: "opens" }, { key: "closes" }],
      coverage_matrix: { tuition: { covered: true }, airfare: { covered: false } },
      eligibility_flags: { max_age: 35, min_gpa_4_scale: null },
      document_checklist: [{ key: "cv" }],
      fields_of_study: [],
      award_duration: "2 years",
      language_training_included: false,
    };
    // 2 scalars + 2 stages + 2 coverage + 2 flags + 1 document + 1 duration + 1 boolean
    assert.equal(countKeptValues(proposed), 11);
  });

  test("bookkeeping keys are not values", () => {
    assert.equal(
      countKeptValues({ not_stated: ["airfare"], eligibility_silent: ["max_age"], field_sources: { a: 1 } }),
      0,
    );
  });

  test("an empty proposal keeps nothing", () => {
    assert.equal(countKeptValues({}), 0);
  });
});

describe("classifyDiscards", () => {
  test("separates missing quotes from failed checks", () => {
    const counts = classifyDiscards([
      'deadline_date (claimed "2026-12-01", quote not found on any fetched page)',
      'opens_date (malformed date "spring")',
      'deadline_date (claimed "2026-12-01", but the quote does not state the day — "…")',
      "coverage_matrix.tuition (quote not found on any fetched page)",
    ]);
    assert.deepEqual(counts, { quoteNotFound: 2, otherCheck: 2 });
  });
});

describe("callCost", () => {
  test("Sonnet 5.5 at list price", () => {
    // 15k in at $2/M + 3k out at $10/M
    assert.equal(callCost(ANTHROPIC_PRICES["claude-sonnet-5-5"]!, 15_000, 3_000), 0.06);
  });

  test("Haiku 5.5 switches to the long-prompt rate above 100k input tokens", () => {
    const haiku = ANTHROPIC_PRICES["claude-haiku-5-5"]!;
    assert.equal(callCost(haiku, 100_000, 0), 0.01);
    assert.equal(callCost(haiku, 100_001, 0), (100_001 * 0.5) / 1_000_000);
  });

  test("a free-tier price costs nothing", () => {
    assert.equal(callCost({ input: 0, output: 0 }, 50_000, 5_000), 0);
  });
});

describe("summarise", () => {
  const run = (provider: string, patch: Partial<RunMetrics>): RunMetrics => ({
    provider, programme: "p", ok: true, error: null, calls: 2, inputTokens: 1000,
    outputTokens: 100, cost: 0.01, kept: 8, discarded: { quoteNotFound: 1, otherCheck: 1 },
    seconds: 1, ...patch,
  });

  test("rolls runs up per provider and computes the keep rate", () => {
    const [gemini, haiku] = summarise([
      run("gemini", {}),
      run("haiku", { kept: 3, discarded: { quoteNotFound: 1, otherCheck: 0 } }),
      run("gemini", { ok: false, error: "boom", kept: 0, discarded: { quoteNotFound: 0, otherCheck: 0 } }),
    ]);
    assert.equal(gemini!.runs, 2);
    assert.equal(gemini!.failed, 1);
    assert.equal(gemini!.extracted, 10);
    assert.equal(gemini!.keepRate, 0.8);
    assert.equal(haiku!.keepRate, 0.75);
  });

  test("keep rate is null when nothing was extracted", () => {
    const [only] = summarise([run("x", { kept: 0, discarded: { quoteNotFound: 0, otherCheck: 0 } })]);
    assert.equal(only!.keepRate, null);
  });
});
