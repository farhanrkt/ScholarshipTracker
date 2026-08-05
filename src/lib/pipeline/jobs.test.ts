import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { describeJob, parseJobRequest, type ExtractArgs, type DiscoverArgs } from "./jobs.ts";

/**
 * Request data reaches a crawler that fetches URLs, spends a paid quota and
 * writes rows. Every test here is either "the option an operator asked for
 * survives the parse" or "the thing an attacker asked for does not".
 */

function extract(body: Record<string, unknown> = {}): ExtractArgs {
  const result = parseJobRequest({ job: "extract", ...body });
  assert.ok(result.ok, `rejected: ${result.ok ? "" : result.error}`);
  assert.equal(result.args.kind, "extract");
  return result.args as ExtractArgs;
}

function discover(body: Record<string, unknown> = {}): DiscoverArgs {
  const result = parseJobRequest({ job: "discover", ...body });
  assert.ok(result.ok, `rejected: ${result.ok ? "" : result.error}`);
  assert.equal(result.args.kind, "discover");
  return result.args as DiscoverArgs;
}

describe("pipeline job arguments", () => {
  test("dry run is the default, so a malformed request writes nothing", () => {
    assert.equal(extract().dryRun, true);
    assert.equal(extract({ dryRun: false }).dryRun, false);
    assert.equal(discover().dryRun, true);
  });

  test("the toggles survive the parse", () => {
    const args = extract({ dryRun: false, verify: true, force: true, escalate: true });
    assert.equal(args.verify, true);
    assert.equal(args.force, true);
    assert.equal(args.escalate, true);
  });

  test("toggles are opt-in, not merely truthy", () => {
    // `=== true` and not a truthiness check: a JSON body carrying
    // "verify": "true" as a STRING must not turn verification on.
    const args = extract({ verify: "true", force: 1 });
    assert.equal(args.verify, false);
    assert.equal(args.force, false);
  });

  test("URL repair is the one toggle that defaults on", () => {
    // A dead URL does not heal: leaving it means the row fails identically on
    // every future run, so this one is opt-OUT.
    assert.equal(extract().fixUrls, true);
    assert.equal(extract({ fixUrls: false }).fixUrls, false);
  });

  test("a filter that looks like a flag is refused", () => {
    const result = parseJobRequest({ job: "extract", filter: "--provider anthropic" });
    assert.equal(result.ok, false);
  });

  test("a filter with shell punctuation is refused", () => {
    for (const filter of ["a; rm -rf /", "$(whoami)", "a`b`", "a|b"]) {
      const result = parseJobRequest({ job: "extract", filter });
      assert.equal(result.ok, false, `accepted ${filter}`);
    }
  });

  test("an ordinary programme name passes", () => {
    assert.equal(extract({ filter: "Chevening (SIDS)" }).title, "Chevening (SIDS)");
    assert.equal(extract({ filter: "  " }).title, null);
  });

  test("counts are clamped, not trusted", () => {
    assert.equal(extract({ count: 999_999 }).limit, 200);
    assert.equal(extract({ count: -5 }).limit, 1);
    assert.equal(extract({ depth: 999 }).pages, 40);
    assert.equal(discover({ count: 999 }).perSeed, 100);
  });

  test("a non-numeric count is refused rather than defaulted", () => {
    assert.equal(parseJobRequest({ job: "extract", count: "many" }).ok, false);
  });

  test("confidence is matched against the known levels", () => {
    assert.equal(discover({ minConfidence: "high" }).minConfidence, "high");
    assert.equal(discover({ minConfidence: "wishful" }).minConfidence, "low");
  });

  test("an unknown job is refused", () => {
    assert.equal(parseJobRequest({ job: "rm" }).ok, false);
    assert.equal(parseJobRequest({}).ok, false);
  });

  test("the description says what will actually happen", () => {
    const line = describeJob(extract({ dryRun: false, verify: true, filter: "Chevening" }));
    assert.match(line, /extract/);
    assert.match(line, /Chevening/);
    assert.match(line, /cross-verify/);
    assert.doesNotMatch(line, /DRY RUN/);

    assert.match(describeJob(extract()), /DRY RUN/);
  });
});
