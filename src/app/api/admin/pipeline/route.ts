import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { checkAdmin } from "@/components/admin/admin-gate";
import { buildJob, JOB_SCRIPTS } from "@/lib/pipeline/jobs";

/**
 * Runs a pipeline script and streams its output back to the browser.
 *
 * WHAT THIS IS: a console for the operator running the app on their own
 * machine. The scripts crawl dozens of pages over minutes and need the
 * service-role key, so this is not, and cannot be, a production endpoint — a
 * serverless function has a read-only filesystem, no repo to spawn from, and a
 * timeout measured in seconds. The runner refuses to start there rather than
 * failing halfway through a crawl with a confusing error.
 *
 * The child inherits this process's environment, which is how it reaches
 * GEMINI_API_KEY and SUPABASE_SERVICE_ROLE_KEY — the same keys `npm run
 * extract` uses. Nothing new is exposed to the browser: only the script's
 * stdout comes back, and the scripts print progress, never secrets.
 */

// Node APIs and a long-lived child process; neither survives the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// No maxDuration on purpose. Vercel validates it at BUILD time against the
// plan's ceiling (60s on Hobby), so a value long enough to be useful for a
// multi-minute crawl fails the deployment outright — and it would buy nothing,
// because this route refuses to run on a serverless host anyway. Locally,
// where it does run, there is no limit to raise.

/**
 * One run at a time, process-wide.
 *
 * Two concurrent crawls would interleave their logs, double the fetch rate
 * against the same hosts, and race each other through a free tier's per-minute
 * quota — turning one slow run into two failed ones.
 */
let running: { job: string; startedAt: number } | null = null;

function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL ?? process.env.AWS_LAMBDA_FUNCTION_NAME ?? process.env.NETLIFY,
  );
}

export async function POST(request: Request) {
  const check = await checkAdmin();
  if (!check.ok) {
    return new Response("Reviewers only.", { status: 403 });
  }

  if (isServerless()) {
    return new Response(
      "This runner only works where the repo and its scripts are on disk — run the app locally with `npm run dev`, or run the scripts from a terminal.",
      { status: 501 },
    );
  }

  if (running) {
    const seconds = Math.round((Date.now() - running.startedAt) / 1000);
    return new Response(
      `A ${running.job} run has been going for ${seconds}s. Wait for it to finish — concurrent runs fight over the same rate limits.`,
      { status: 409 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response("Expected a JSON body.", { status: 400 });
  }

  const plan = buildJob(body);
  if (!plan.ok) return new Response(plan.error, { status: 400 });

  // turbopackIgnore on every one of these: resolving paths against cwd tells
  // the bundler's file tracer that this route might read anything in the
  // project, so it traces the whole repo — node_modules included — into the
  // deployment bundle. These paths are only ever touched on a developer
  // machine (isServerless() has already returned above otherwise), so the
  // tracer has nothing useful to learn from them.
  const root = process.cwd();
  const script = path.join(/*turbopackIgnore: true*/ root, JOB_SCRIPTS[plan.job]);
  if (!existsSync(script)) {
    return new Response(
      `Cannot find ${JOB_SCRIPTS[plan.job]} under ${root}. The app has to run from the repo for this to work.`,
      { status: 501 },
    );
  }

  const envFile = path.join(/*turbopackIgnore: true*/ root, ".env.local");
  const args = [
    // The scripts read their keys from .env.local exactly as the npm scripts
    // do. Passing it explicitly keeps one source of truth for credentials.
    ...(existsSync(envFile) ? [`--env-file=${envFile}`] : []),
    script,
    ...plan.built.args,
  ];

  // No shell. `args` is an array of literals built by buildJob(), so there is
  // no string for a quote or a semicolon to escape out of.
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  running = { job: plan.job, startedAt: Date.now() };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };

      send(`$ ${plan.built.display}\n\n`);

      child.stdout.on("data", (chunk: Buffer) => send(chunk.toString()));
      // Interleaved deliberately: a crash's stack trace is the most useful
      // thing on the screen, and hiding it in a server log helps nobody.
      child.stderr.on("data", (chunk: Buffer) => send(chunk.toString()));

      child.on("error", (error: Error) => {
        send(`\n✗ could not start: ${error.message}\n`);
      });

      child.on("close", (code) => {
        send(
          code === 0
            ? `\n✓ ${plan.job} finished.\n`
            : `\n✗ ${plan.job} exited with code ${code}.\n`,
        );
        running = null;
        closed = true;
        controller.close();
      });
    },
    cancel() {
      // The browser navigated away or hit stop. Kill the child rather than
      // leaving a crawl running against someone's site with nobody watching.
      child.kill("SIGTERM");
      running = null;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // Without this a proxy can hold the whole run and deliver it at the end,
      // which defeats the point of streaming progress.
      "x-accel-buffering": "no",
    },
  });
}

/** Lets the page show whether a run is already in flight. */
export async function GET() {
  const check = await checkAdmin();
  if (!check.ok) return new Response("Reviewers only.", { status: 403 });

  return Response.json({
    available: !isServerless(),
    running: running?.job ?? null,
    startedAt: running?.startedAt ?? null,
  });
}
