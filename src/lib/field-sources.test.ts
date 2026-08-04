import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { readFieldSource } from "./field-sources.ts";
import type { FieldSources } from "./types/database.ts";

/** JSONB is not typed at runtime; these fixtures are what the column can hold. */
const raw = (value: unknown) => value as FieldSources;

describe("field provenance", () => {
  test("reads a well-formed entry", () => {
    const entry = readFieldSource(
      raw({
        deadline_date: {
          authority: "official",
          source_url: "https://www.bristol.ac.uk/x",
          conflicts: [{ url: "https://blog.example/y", authority: "other", value: "2026-10-12" }],
        },
      }),
      "deadline_date",
    );

    assert.equal(entry?.authority, "official");
    assert.equal(entry?.conflicts?.length, 1);
  });

  test("an unknown field is silence, not a crash", () => {
    assert.equal(readFieldSource(raw({}), "deadline_date"), null);
    assert.equal(readFieldSource(null, "deadline_date"), null);
    assert.equal(readFieldSource(undefined, "deadline_date"), null);
  });

  test("a bogus authority is rejected rather than rendered", () => {
    // An unrecognised tier would index AUTHORITY_LABELS to undefined and print
    // "From undefined" next to a deadline.
    assert.equal(
      readFieldSource(raw({ deadline_date: { authority: "trustworthy" } }), "deadline_date"),
      null,
    );
  });

  test("non-array corroboration degrades to empty", () => {
    const entry = readFieldSource(
      raw({ deadline_date: { authority: "funder", corroborated_by: "lots" } }),
      "deadline_date",
    );
    assert.deepEqual(entry?.corroborated_by, []);
  });

  test("an array where an object belongs is not provenance", () => {
    assert.equal(readFieldSource(raw([{ authority: "funder" }]), "deadline_date"), null);
  });
});
