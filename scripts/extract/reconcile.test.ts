import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { describeConflict, isSecondHand, reconcileField, type SourcedValue } from "./reconcile.ts";
import type { Authority } from "../discover/authority.ts";

/**
 * Reconciliation decides what a student is told when sources disagree. The
 * expensive failure is not picking the wrong date — it is picking one silently,
 * so nobody ever learns the sources differed.
 */

const claim = (
  value: string,
  authority: Authority,
  url: string,
): SourcedValue<string> => ({ value, authority, sourceUrl: url, quote: `…${value}…` });

describe("authority wins", () => {
  test("the funder beats a university beats a blog", () => {
    const result = reconcileField([
      claim("2026-10-12", "other", "https://blog.example/chevening"),
      claim("2026-10-06", "funder", "https://www.chevening.org/timeline"),
      claim("2026-10-09", "official", "https://www.bristol.ac.uk/chevening"),
    ]);

    assert.equal(result.value, "2026-10-06");
    assert.equal(result.authority, "funder");
    assert.equal(result.conflicts.length, 2);
  });

  test("weight of numbers never beats authority", () => {
    // Ten aggregators copying each other is one mistake ten times. Treating it
    // as ten confirmations is how a stale deadline reaches a student.
    const copies = Array.from({ length: 10 }, (_, i) =>
      claim("2026-10-12", "other", `https://farm${i}.example/x`),
    );

    const result = reconcileField([
      ...copies,
      claim("2026-10-06", "funder", "https://www.chevening.org/timeline"),
    ]);

    assert.equal(result.value, "2026-10-06");
    assert.equal(result.authority, "funder");
    assert.equal(result.conflicts.length, 10);
  });
});

describe("corroboration", () => {
  test("agreement is recorded, not duplicated", () => {
    const result = reconcileField([
      claim("2026-10-06", "funder", "https://www.chevening.org/timeline"),
      claim("2026-10-06", "official", "https://www.bristol.ac.uk/chevening"),
      claim("2026-10-06", "official", "https://www.leeds.ac.uk/chevening"),
    ]);

    assert.equal(result.value, "2026-10-06");
    assert.equal(result.sourceUrl, "https://www.chevening.org/timeline");
    assert.equal(result.corroboratedBy.length, 2);
    assert.deepEqual(result.conflicts, []);
  });

  test("capitalisation is not a disagreement", () => {
    // A spurious conflict costs a reviewer's attention exactly as much as a
    // real one, so sameness uses the normalisation grounding already applies.
    const result = reconcileField([
      claim("6 October 2026", "funder", "https://a.example/x"),
      claim("6 october  2026", "official", "https://b.example/y"),
    ]);

    assert.deepEqual(result.conflicts, []);
    assert.equal(result.corroboratedBy.length, 1);
  });

  test("corroboration only breaks a tie between equals", () => {
    const result = reconcileField([
      claim("A", "official", "https://one.ac.uk/x"),
      claim("A", "official", "https://two.ac.uk/y"),
      claim("B", "official", "https://three.ac.uk/z"),
    ]);

    assert.equal(result.value, "A");
    assert.equal(result.corroboratedBy.length, 1);
    assert.equal(result.conflicts.length, 1);
  });
});

describe("gap filling", () => {
  test("a value only a university states is kept and labelled", () => {
    // The trust policy: fill the gap, but never let it read as the funder's
    // own word.
    const result = reconcileField([
      claim("2026-10-06", "official", "https://www.bristol.ac.uk/chevening"),
    ]);

    assert.equal(result.value, "2026-10-06");
    assert.equal(result.authority, "official");
    assert.equal(isSecondHand(result), true);
  });

  test("a value only an aggregator states is labelled as such", () => {
    const result = reconcileField([
      claim("2026-10-12", "other", "https://scholarshipfarm.example/x"),
    ]);

    assert.equal(result.authority, "other");
    assert.equal(isSecondHand(result), true, "must not pass as the funder's own");
  });

  test("the funder's own value is not second-hand", () => {
    const result = reconcileField([claim("x", "funder", "https://f.example/a")]);
    assert.equal(isSecondHand(result), false);
  });

  test("no sources means no value, not an empty string", () => {
    const result = reconcileField<string>([]);
    assert.equal(result.value, null);
    assert.equal(result.authority, null);
    assert.deepEqual(result.conflicts, []);
  });
});

describe("reviewer reporting", () => {
  test("a conflict names both readings, their tiers and their URLs", () => {
    const result = reconcileField([
      claim("2026-10-06", "funder", "https://www.chevening.org/timeline"),
      claim("2026-10-12", "other", "https://blog.example/chevening"),
    ]);

    const line = describeConflict("deadline_date", result);
    assert.ok(line);
    assert.match(line, /2026-10-06/);
    assert.match(line, /2026-10-12/);
    assert.match(line, /blog\.example/);
    assert.match(line, /funder/);
  });

  test("agreement produces no caveat", () => {
    const result = reconcileField([
      claim("2026-10-06", "funder", "https://a.example/x"),
      claim("2026-10-06", "official", "https://b.ac.uk/y"),
    ]);

    assert.equal(describeConflict("deadline_date", result), null);
  });
});
