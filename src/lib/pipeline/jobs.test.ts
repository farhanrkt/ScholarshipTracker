import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { buildJob } from "./jobs.ts";

/**
 * This turns an HTTP request into a process on the host. Every test here is
 * either "the flag an operator asked for actually reaches the script" or "the
 * thing an attacker asked for does not".
 */

const build = (body: Record<string, unknown>) => {
  const result = buildJob({ job: "extract", ...body });
  assert.ok(result.ok, `rejected: ${result.ok ? "" : result.error}`);
  return result.built.args;
};

describe("pipeline job flags", () => {
  test("dry run is the default, so a malformed request writes nothing", () => {
    assert.ok(build({}).includes("--dry-run"));
    assert.ok(!build({ dryRun: false }).includes("--dry-run"));
  });

  test("the new toggles reach the script", () => {
    const args = build({ dryRun: false, verify: true, force: true });
    assert.ok(args.includes("--verify"), "verify was not passed");
    assert.ok(args.includes("--force"), "force was not passed");
  });

  test("toggles are opt-in, not merely truthy", () => {
    // `=== true` and not a truthiness check: a JSON body carrying
    // "verify": "false" must not turn verification on.
    const args = build({ verify: "true", force: 1 });
    assert.ok(!args.includes("--verify"));
    assert.ok(!args.includes("--force"));
  });

  test("verify and force are extract-only", () => {
    const result = buildJob({ job: "discover", verify: true, force: true });
    assert.ok(result.ok);
    assert.ok(!result.built.args.includes("--verify"));
    assert.ok(!result.built.args.includes("--force"));
  });

  test("a filter that looks like a flag is refused", () => {
    const result = buildJob({ job: "extract", filter: "--provider anthropic" });
    assert.equal(result.ok, false);
  });

  test("counts are clamped, not trusted", () => {
    const args = build({ count: 999_999 });
    const index = args.indexOf("--limit");
    assert.ok(index !== -1);
    assert.equal(args[index + 1], "200");
  });

  test("an unknown job is refused", () => {
    assert.equal(buildJob({ job: "rm" }).ok, false);
  });
});
