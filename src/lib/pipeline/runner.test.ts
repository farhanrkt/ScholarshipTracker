import assert from "node:assert/strict";
import { test, describe, before } from "node:test";

/**
 * The job state machine, without a database or a network.
 *
 * What is worth testing here is not the crawling — that has its own tests and
 * its own module — but the bookkeeping that makes a multi-minute run survive a
 * host where nothing lives longer than a request: which units a run will do,
 * that the cursor only ever moves forward, and that a finished job is written
 * back as finished.
 *
 * The Supabase client is faked because the alternative is a live database, and
 * a test that needs one is a test nobody runs.
 */

type Row = Record<string, unknown>;

interface Recorded {
  table: string;
  op: "insert" | "update";
  payload: unknown;
}

/**
 * Enough of postgrest-js to satisfy the runner.
 *
 * Every builder method returns `this` and the object is awaitable, which is how
 * the real client behaves for the subset used here: chain filters, then await.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const recorded: Recorded[] = [];

  const builder = (table: string) => {
    let rows = [...(tables[table] ?? [])];

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      neq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] !== value);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      gt: () => chain,
      lt: (column: string, value: unknown) => {
        rows = rows.filter(
          (row) => row[column] !== null && String(row[column]) < String(value),
        );
        return chain;
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator === "is" && value === null) {
          rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
        }
        return chain;
      },
      /**
       * Enough of PostgREST's `or=` to cover the staleness query: a
       * comma-separated list of `column.op.value` terms, ORed together.
       */
      or: (expression: string) => {
        const terms = expression.split(",").map((term) => term.split("."));
        rows = rows.filter((row) =>
          terms.some(([column, operator, ...rest]) => {
            const value = rest.join(".");
            const cell = row[column!];
            if (operator === "is" && value === "null") {
              return cell === null || cell === undefined;
            }
            if (operator === "lt") {
              return cell !== null && cell !== undefined && String(cell) < value;
            }
            return false;
          }),
        );
        return chain;
      },
      ilike: () => chain,
      order: () => chain,
      limit: (count: number) => {
        rows = rows.slice(0, count);
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      insert: (payload: unknown) => {
        recorded.push({ table, op: "insert", payload });
        return chain;
      },
      update: (payload: unknown) => {
        recorded.push({ table, op: "update", payload });
        return chain;
      },
      upsert: (payload: unknown) => {
        recorded.push({ table, op: "insert", payload });
        return chain;
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };

    return chain;
  };

  return {
    db: { from: (table: string) => builder(table) },
    recorded,
    updatesTo(table: string) {
      return recorded.filter((entry) => entry.table === table && entry.op === "update");
    },
  };
}

type RunnerModule = typeof import("./runner.ts");
let runner: RunnerModule;

before(async () => {
  // pickProvider throws when no key is configured, and the runner reads it at
  // tick time. A dummy is enough: no tick in this file reaches a model call.
  process.env.GEMINI_API_KEY ||= "test-key";
  runner = await import("./runner.ts");
});

const EXTRACT_ARGS = {
  kind: "extract" as const,
  dryRun: true,
  title: null,
  limit: 50,
  pages: 20,
  datesOnly: false,
  escalate: false,
  verify: false,
  force: false,
  fixUrls: true,
  gapFill: true,
  gapCrawl: true,
  staleOnly: false,
};

describe("planning a run", () => {
  test("a programme with a proposal already waiting is left out", async () => {
    // Re-running used to stage a SECOND proposal for a row that already had one
    // pending, so the review queue filled with duplicates of one programme and
    // a reviewer had to work out which was newer.
    const { db } = fakeDb({
      scholarships: [
        { id: "a", title: "Chevening", verification_status: "ai_extracted" },
        { id: "b", title: "MEXT", verification_status: "unverified" },
      ],
      scholarship_extractions: [{ scholarship_id: "a", status: "pending" }],
    });

    const plan = await runner.planUnits(db as never, EXTRACT_ARGS);

    assert.deepEqual(
      plan.units.map((unit) => (unit.kind === "programme" ? unit.id : unit.label)),
      ["b"],
    );
    assert.match(plan.notes.join(" "), /already waiting in review/);
  });

  test("force includes it again, and says nothing about skipping", async () => {
    const { db } = fakeDb({
      scholarships: [{ id: "a", title: "Chevening", verification_status: "ai_extracted" }],
      scholarship_extractions: [{ scholarship_id: "a", status: "pending" }],
    });

    const plan = await runner.planUnits(db as never, { ...EXTRACT_ARGS, force: true });

    assert.equal(plan.units.length, 1);
    assert.deepEqual(plan.notes, []);
  });

  test("a verified row is never queued", async () => {
    // Extraction must not overwrite a row a human has confirmed.
    const { db } = fakeDb({
      scholarships: [
        { id: "a", title: "Checked", verification_status: "verified" },
        { id: "b", title: "Not checked", verification_status: "unverified" },
      ],
      scholarship_extractions: [],
    });

    const plan = await runner.planUnits(db as never, EXTRACT_ARGS);
    assert.deepEqual(plan.units.map((unit) => (unit.kind === "programme" ? unit.id : "")), [
      "b",
    ]);
  });

  test("discovery plans one unit per matching seed", async () => {
    const { db } = fakeDb({});

    const all = await runner.planUnits(db as never, {
      kind: "discover",
      dryRun: true,
      seed: null,
      perSeed: 20,
      maxListing: 8,
      minConfidence: "low",
      useSitemap: true,
    });
    assert.ok(all.units.length > 5, "expected the full seed list");
    assert.ok(all.units.every((unit) => unit.kind === "seed"));

    const filtered = await runner.planUnits(db as never, {
      kind: "discover",
      dryRun: true,
      seed: "chevening",
      perSeed: 20,
      maxListing: 8,
      minConfidence: "low",
      useSitemap: true,
    });
    assert.equal(filtered.units.length, 1);
  });

  test("a seed filter that matches nothing plans nothing, and says so", async () => {
    const { db } = fakeDb({});
    const plan = await runner.planUnits(db as never, {
      kind: "discover",
      dryRun: true,
      seed: "no such seed",
      perSeed: 20,
      maxListing: 8,
      minConfidence: "low",
      useSitemap: true,
    });

    assert.equal(plan.units.length, 0);
    assert.match(plan.notes.join(" "), /No seed matches/);
  });
});

describe("ticking a job", () => {
  test("a job with no units left finishes and is written back as done", async () => {
    const { db, updatesTo } = fakeDb({ pipeline_jobs: [{ id: "job-1", status: "running" }] });

    const result = await runner.runTick(db as never, {
      id: "job-1",
      kind: "extract",
      args: EXTRACT_ARGS,
      status: "running",
      units: [],
      cursor: 0,
      total: 0,
      staged: 0,
      failed: 0,
      skipped: 0,
    });

    assert.equal(result.status, "done");
    assert.equal(result.cursor, 0);

    const saved = updatesTo("pipeline_jobs").at(-1)?.payload as Row;
    assert.equal(saved.status, "done");
    // A finished job must carry a finish time, or the console shows it running
    // forever.
    assert.ok(saved.finished_at, "finished_at was not stamped");
  });

  test("a cancelled job stops before starting more work", async () => {
    // The status is re-read between batches precisely so Stop takes effect
    // without waiting out the whole tick budget.
    const { db } = fakeDb({
      pipeline_jobs: [{ id: "job-2", status: "cancelled" }],
    });

    const result = await runner.runTick(db as never, {
      id: "job-2",
      kind: "extract",
      args: EXTRACT_ARGS,
      status: "running",
      units: [
        { kind: "programme", id: "a", title: "Chevening" },
        { kind: "programme", id: "b", title: "MEXT" },
      ],
      cursor: 0,
      total: 2,
      staged: 0,
      failed: 0,
      skipped: 0,
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.cursor, 0, "cancelled after doing work it should not have started");
    assert.match(result.lines.join("\n"), /cancelled/);
  });

  test("the log is appended, never rewritten", async () => {
    const { db, recorded } = fakeDb({ pipeline_jobs: [{ id: "job-3", status: "running" }] });

    await runner.runTick(db as never, {
      id: "job-3",
      kind: "extract",
      args: EXTRACT_ARGS,
      status: "running",
      units: [],
      cursor: 0,
      total: 0,
      staged: 2,
      failed: 1,
      skipped: 0,
    });

    const written = recorded.find(
      (entry) => entry.table === "pipeline_job_lines" && entry.op === "insert",
    );
    assert.ok(written, "no log lines were written");
    assert.ok(Array.isArray(written.payload));
  });

  test("tallies carry across ticks rather than restarting", async () => {
    // Each tick is a separate function call: if it did not start from the
    // job's stored counts, a run's totals would reset every few minutes.
    const { db } = fakeDb({ pipeline_jobs: [{ id: "job-4", status: "running" }] });

    const result = await runner.runTick(db as never, {
      id: "job-4",
      kind: "extract",
      args: EXTRACT_ARGS,
      status: "running",
      units: [],
      cursor: 7,
      total: 7,
      staged: 5,
      failed: 2,
      skipped: 1,
    });

    assert.equal(result.staged, 5);
    assert.equal(result.failed, 2);
    assert.equal(result.skipped, 1);
  });
});

describe("planning a refresh", () => {
  /**
   * The scheduled run's whole job is to notice what has gone out of date. Six
   * of sixteen deadlines in the real catalogue had already passed with nothing
   * ever going to look at them again — that is the failure this planner exists
   * to stop, and the ordering matters as much as the selection, because a
   * passed deadline is the one actively misleading somebody.
   */
  const STALE_ARGS = { ...EXTRACT_ARGS, staleOnly: true, dryRun: false };

  const catalogue = () => [
    {
      id: "passed",
      title: "Deadline gone",
      deadline_date: "2020-01-01",
      last_verified_at: "2099-01-01T00:00:00Z",
      verification_status: "ai_extracted",
    },
    {
      id: "fresh",
      title: "Read last week",
      deadline_date: "2099-01-01",
      last_verified_at: "2099-01-01T00:00:00Z",
      verification_status: "ai_extracted",
    },
    {
      id: "never",
      title: "Never read",
      deadline_date: null,
      last_verified_at: null,
      verification_status: "unverified",
    },
    {
      id: "aged",
      title: "Read long ago",
      deadline_date: "2099-01-01",
      last_verified_at: "2000-01-01T00:00:00Z",
      verification_status: "ai_extracted",
    },
  ];

  test("picks passed deadlines, never-read rows and aged readings", async () => {
    const { db } = fakeDb({ scholarships: catalogue(), scholarship_extractions: [] });
    const plan = await runner.planUnits(db as never, STALE_ARGS);

    const ids = plan.units.map((unit) => (unit as { id: string }).id);
    assert.deepEqual(new Set(ids), new Set(["passed", "never", "aged"]));
  });

  test("a row read recently with a deadline ahead of it is left alone", async () => {
    const { db } = fakeDb({ scholarships: catalogue(), scholarship_extractions: [] });
    const plan = await runner.planUnits(db as never, STALE_ARGS);

    assert.equal(
      plan.units.some((unit) => (unit as { id: string }).id === "fresh"),
      false,
    );
  });

  test("a passed deadline is re-read even when a human verified it", async () => {
    // A verification confirms a DATE, and a date that has passed has outlived
    // its confirmation. Re-reading stages a proposal for review, so the rule
    // that a machine never edits a checked row still holds.
    const { db } = fakeDb({
      scholarships: [
        {
          id: "verified-and-expired",
          title: "Checked, then expired",
          deadline_date: "2020-01-01",
          last_verified_at: "2099-01-01T00:00:00Z",
          verification_status: "verified",
        },
      ],
      scholarship_extractions: [],
    });

    const plan = await runner.planUnits(db as never, STALE_ARGS);
    assert.equal(plan.units.length, 1);
  });

  test("a verified row does not go stale merely with time", async () => {
    const { db } = fakeDb({
      scholarships: [
        {
          id: "verified-old",
          title: "Checked long ago, deadline ahead",
          deadline_date: "2099-01-01",
          last_verified_at: "2000-01-01T00:00:00Z",
          verification_status: "verified",
        },
      ],
      scholarship_extractions: [],
    });

    const plan = await runner.planUnits(db as never, STALE_ARGS);
    assert.deepEqual(plan.units, []);
  });

  test("a fully current catalogue says so rather than planning nothing silently", async () => {
    const { db } = fakeDb({
      scholarships: [catalogue()[1]!],
      scholarship_extractions: [],
    });

    const plan = await runner.planUnits(db as never, STALE_ARGS);
    assert.deepEqual(plan.units, []);
    assert.match(plan.notes.join(" "), /Nothing is stale/);
  });
});
