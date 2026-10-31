import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  TOGGLE_DEFAULTS,
  countActiveFilters,
  isFiltered,
  parseFilters,
  readToggle,
  serialiseFilters,
  writeToggle,
  type RawSearchParams,
} from "./filters.ts";

/**
 * The filter layer had no tests at all, which is a strange place for a gap:
 * every number a student sees is whatever these functions decided to ask the
 * database for. The three-valued toggle is what finally forced the issue — a
 * default that is ON can hide rows, and "hides rows" is the one behaviour that
 * has to be pinned down rather than inferred from a checkbox.
 */

const parse = (params: RawSearchParams) => parseFilters(params);

describe("toggle defaults", () => {
  test("absent means the default, which is off for all but one", () => {
    const toggles = parse({}).toggles;
    assert.equal(toggles.upcomingOnly, true, '"Still open" is on until turned off');
    assert.equal(toggles.verifiedOnly, false);
    assert.equal(toggles.noBond, false);
    assert.equal(toggles.coversTuition, false);
  });

  test('"0" turns the default-on one off — absent cannot say that', () => {
    assert.equal(parse({ upcomingOnly: "0" }).toggles.upcomingOnly, false);
    assert.equal(parse({ upcomingOnly: "1" }).toggles.upcomingOnly, true);
  });

  test("a default-off toggle still ignores anything but 1", () => {
    assert.equal(parse({ verifiedOnly: "0" }).toggles.verifiedOnly, false);
    assert.equal(parse({ verifiedOnly: "yes" }).toggles.verifiedOnly, false);
    assert.equal(parse({ verifiedOnly: "1" }).toggles.verifiedOnly, true);
  });

  test("readToggle shrugs off the shapes a query string can really hold", () => {
    assert.equal(readToggle(undefined, "upcomingOnly"), true);
    assert.equal(readToggle(null, "upcomingOnly"), true);
    assert.equal(readToggle(["1", "0"], "upcomingOnly"), true, "repeated param falls back to the default");
    assert.equal(readToggle("", "verifiedOnly"), false);
  });
});

describe("the badge counts what the visitor changed", () => {
  test("a fresh dashboard reads as unfiltered even though a filter is on", () => {
    assert.equal(countActiveFilters(parse({})), 0);
  });

  test("turning the default-on filter OFF is itself a change", () => {
    assert.equal(countActiveFilters(parse({ upcomingOnly: "0" })), 1);
  });

  test("ordinary toggles, countries and a query all count once each", () => {
    const filters = parse({ verifiedOnly: "1", country: "USA,UK", q: "chevening" });
    assert.equal(countActiveFilters(filters), 4);
  });
});

describe("the empty state asks a different question", () => {
  test("a fresh dashboard IS narrowed, whatever the badge says", () => {
    const filters = parse({});
    assert.equal(countActiveFilters(filters), 0);
    assert.equal(isFiltered(filters), true, "else an empty list blames the database");
  });

  test("showing everything is the one state that is not narrowed", () => {
    assert.equal(isFiltered(parse({ upcomingOnly: "0" })), false);
  });
});

describe("URLs stay as short as the choice allows", () => {
  test("the default view serialises to nothing at all", () => {
    assert.equal(serialiseFilters(parse({})), "");
  });

  test("the default-on filter appears in a URL only when switched off", () => {
    assert.equal(serialiseFilters(parse({ upcomingOnly: "0" })), "upcomingOnly=0");
    assert.equal(serialiseFilters(parse({ upcomingOnly: "1" })), "");
  });

  test("writeToggle deletes a value that equals the default", () => {
    const params = new URLSearchParams("upcomingOnly=0&verifiedOnly=1");
    writeToggle(params, "upcomingOnly", TOGGLE_DEFAULTS.upcomingOnly);
    writeToggle(params, "verifiedOnly", false);
    assert.equal(params.toString(), "");
  });
});

describe("round trip", () => {
  for (const params of [
    {},
    { upcomingOnly: "0" },
    { verifiedOnly: "1", noBond: "1" },
    { country: "USA,UK", degree: "Masters", q: "fulbright", sort: "title" },
    { upcomingOnly: "0", country: "Japan", verifiedOnly: "1" },
  ] as RawSearchParams[]) {
    test(`survives ${JSON.stringify(params)}`, () => {
      const once = parse(params);
      const twice = parse(
        Object.fromEntries(new URLSearchParams(serialiseFilters(once))),
      );
      assert.deepEqual(twice, once);
    });
  }
});
