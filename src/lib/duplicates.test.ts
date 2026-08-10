import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  comparePair,
  distinctive,
  findDuplicates,
  programmeType,
  type DuplicateRow,
} from "./duplicates.ts";

/**
 * Duplicate detection proposes; a reviewer decides. So the cases that matter
 * most are the ones it must NOT propose — a false "certain" invites someone to
 * delete a programme that was never a duplicate, and the row it takes with it
 * carries other people's half-ticked checklists.
 */

let counter = 0;
function row(title: string, url: string, patch: Partial<DuplicateRow> = {}): DuplicateRow {
  return {
    id: `id-${counter++}`,
    title,
    country: "UK",
    official_portal_url: url,
    verification_status: "ai_extracted",
    is_profiled: true,
    deadline_date: null,
    created_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

const CHEVENING = "https://www.chevening.org/scholarships/";

describe("comparing two rows", () => {
  test("plurals and case are the same programme", () => {
    const verdict = comparePair(
      row("Chevening Scholarship", CHEVENING),
      row("Chevening Scholarships", CHEVENING),
    );

    assert.equal(verdict?.confidence, "certain");
  });

  test("a fellowship is not a scholarship", () => {
    // THE case that breaks a naive token overlap. Strip "fellowship" and
    // "scholarship" as noise — the obvious move, since every title has one —
    // and both titles reduce to "chevening" and look identical. They are two
    // programmes with different eligibility and different money.
    assert.equal(
      comparePair(
        row("Chevening Fellowships", CHEVENING),
        row("Chevening Scholarships", CHEVENING),
      ),
      null,
    );
  });

  test("a qualifier on the same site is worth asking about", () => {
    const verdict = comparePair(
      row("Humphrey Fellowship Program", "https://www.humphreyfellowship.org/a"),
      row("Hubert H. Humphrey Fellowship Program", "https://www.humphreyfellowship.org/b"),
    );

    assert.equal(verdict?.confidence, "likely");
  });

  test("two funders using the same words are not paired", () => {
    // "Global Scholarship" on two different sites is two programmes. Without
    // the host check this is the pair that would swallow half the catalogue.
    assert.equal(
      comparePair(
        row("Vernova STAR Scholarship", "https://www.iie.org/a"),
        row("Vernova STAR Scholarship Fund", "https://example.edu/b"),
        // ^ different host, and not an identical fingerprint
      ),
      null,
    );
  });

  test("sharing nothing but generic words is not a match", () => {
    assert.equal(
      comparePair(
        row("Dissertation Completion Fellowships", "https://gsas.harvard.edu/a"),
        row("Language Study Fellowships", "https://gsas.harvard.edu/b"),
      ),
      null,
    );
  });

  test("www is not a different site", () => {
    // The host check is what gates every rule below "certain", so a `www.`
    // prefix deciding it would silently halve what this finds.
    const verdict = comparePair(
      row("Humphrey Fellowship", "https://www.humphreyfellowship.org/a"),
      row("Humphrey Fellowship Program", "https://humphreyfellowship.org/b"),
    );

    assert.equal(verdict?.confidence, "likely");
  });
});

describe("what counts as a distinctive word", () => {
  test("the shape words are stripped and the name survives", () => {
    assert.deepEqual([...distinctive("Chevening Scholarships for International Students")], [
      "chevening",
    ]);
  });

  test("the type word is readable on its own", () => {
    assert.equal(programmeType("Chevening Fellowships"), "fellowship");
    assert.equal(programmeType("Gates Cambridge Scholarship"), "scholarship");
    assert.equal(programmeType("Knight-Hennessy Scholars"), null);
  });
});

describe("grouping a catalogue", () => {
  test("three rows for one programme arrive as one decision", () => {
    // Not three pairs for a reviewer to reconcile in their head.
    const clusters = findDuplicates([
      row("Humphrey Fellowship Program", "https://humphreyfellowship.org/a"),
      row("Hubert H. Humphrey Fellowship Program", "https://humphreyfellowship.org/b"),
      row("Distinguished Humphrey Fellowship Program", "https://humphreyfellowship.org/c"),
      row("Gates Cambridge Scholarship", "https://www.gatescambridge.org/"),
    ]);

    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.rows.length, 3);
  });

  test("a catalogue with no duplicates produces nothing", () => {
    const clusters = findDuplicates([
      row("Gates Cambridge Scholarship", "https://www.gatescambridge.org/"),
      row("Knight-Hennessy Scholars", "https://knight-hennessy.stanford.edu/"),
    ]);

    assert.deepEqual(clusters, []);
  });

  test("the row a human verified is the one suggested to keep", () => {
    // Dropping the checked row to keep the unchecked one would throw away the
    // only thing in the pair that anybody actually confirmed.
    const clusters = findDuplicates([
      row("Chevening Scholarships", CHEVENING, { verification_status: "unverified" }),
      row("Chevening Scholarship", CHEVENING, { verification_status: "verified" }),
    ]);

    assert.equal(clusters[0]?.suggestedKeep.title, "Chevening Scholarship");
  });

  test("depth breaks a tie when neither row is verified", () => {
    const clusters = findDuplicates([
      row("Chevening Scholarships", CHEVENING, {
        verification_status: "unverified",
        is_profiled: false,
      }),
      row("Chevening Scholarship", CHEVENING, {
        verification_status: "ai_extracted",
        is_profiled: true,
        deadline_date: "2026-10-06",
      }),
    ]);

    assert.equal(clusters[0]?.suggestedKeep.title, "Chevening Scholarship");
  });

  test("certain clusters are reviewed before speculative ones", () => {
    const clusters = findDuplicates([
      row("Humphrey Fellowship Program", "https://humphreyfellowship.org/a"),
      row("Hubert H. Humphrey Fellowship Program", "https://humphreyfellowship.org/b"),
      row("Chevening Scholarship", CHEVENING),
      row("Chevening Scholarships", CHEVENING),
    ]);

    assert.equal(clusters[0]?.confidence, "certain");
  });
});
