/**
 * Do the links we show a student still work?
 *
 * Every `official_portal_url` and `source_url` in the catalogue, fetched once,
 * recording the final status and the whole redirect chain. A redirect is not a
 * failure, but a programme page that now redirects to a faculty homepage is —
 * so the chain is kept rather than just the last code.
 *
 * Politeness is the crawler's own: robots.txt is consulted through
 * `isAllowed()` before any request, the user agent is CRAWL_USER_AGENT, and no
 * host is asked more than once per CRAWL_DELAY_MS.
 *
 *   node --env-file=.env.local scripts/audit/url-health.ts
 */

import { FETCH_DELAY_MS, isAllowed } from "../extract/page.ts";
import { AS_OF, supabaseAdmin, writeEvidence } from "./lib.ts";

const USER_AGENT =
  process.env.CRAWL_USER_AGENT ||
  "ScholarTrackBot/1.0 (scholarship deadline verification; +https://github.com/)";

const lastHit = new Map<string, number>();

async function polite(host: string) {
  const previous = lastHit.get(host) ?? 0;
  const wait = previous + FETCH_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastHit.set(host, Date.now());
}

interface Result {
  url: string;
  kind: "official_portal_url" | "source_url";
  title: string;
  allowed_by_robots: boolean;
  status: number | null;
  final_url?: string;
  redirects: string[];
  content_type?: string | null;
  error?: string;
  verdict: "ok" | "redirected" | "dead" | "blocked" | "error";
}

async function check(url: string, kind: Result["kind"], title: string): Promise<Result> {
  const base: Result = { url, kind, title, allowed_by_robots: true, status: null, redirects: [], verdict: "error" };

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ...base, error: "unparseable URL", verdict: "error" };
  }

  if (!(await isAllowed(url))) {
    return { ...base, allowed_by_robots: false, verdict: "blocked" };
  }

  const redirects: string[] = [];
  let current = url;

  for (let hop = 0; hop < 6; hop++) {
    await polite(new URL(current).host);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/pdf,*/*" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      return {
        ...base,
        redirects,
        error: cause instanceof Error ? cause.message : String(cause),
        verdict: "error",
      };
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      redirects.push(current);
      continue;
    }

    const movedOffPath = redirects.length > 0 && new URL(current).pathname !== new URL(url).pathname;
    return {
      ...base,
      status: response.status,
      final_url: current,
      redirects,
      content_type: response.headers.get("content-type"),
      verdict:
        response.status >= 400 ? "dead" : movedOffPath ? "redirected" : "ok",
    };
  }

  return { ...base, redirects, error: "too many redirects", verdict: "error" };
}

async function main() {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase
    .from("scholarships")
    .select("id, title, official_portal_url, source_url");
  if (error) throw error;

  const targets: { url: string; kind: Result["kind"]; title: string }[] = [];
  for (const row of data ?? []) {
    if (row.official_portal_url) {
      targets.push({ url: row.official_portal_url, kind: "official_portal_url", title: row.title });
    }
    if (row.source_url && row.source_url !== row.official_portal_url) {
      targets.push({ url: row.source_url, kind: "source_url", title: row.title });
    }
  }

  console.log(`\nURL HEALTH — ${targets.length} links from ${data?.length} programmes, as of ${AS_OF}\n`);

  const results: Result[] = [];
  for (const target of targets) {
    const result = await check(target.url, target.kind, target.title);
    results.push(result);
    const mark = { ok: "ok  ", redirected: "->  ", dead: "DEAD", blocked: "ROBO", error: "ERR " }[result.verdict];
    console.log(`  ${mark} ${String(result.status ?? "").padStart(3)}  ${result.title.slice(0, 40).padEnd(40)} ${result.url.slice(0, 80)}`);
    if (result.verdict === "redirected") console.log(`        -> ${result.final_url}`);
    if (result.error) console.log(`        ${result.error.slice(0, 100)}`);
  }

  const tally = (v: Result["verdict"]) => results.filter((r) => r.verdict === v).length;
  console.log(
    `\nok ${tally("ok")} · redirected elsewhere ${tally("redirected")} · dead ${tally("dead")} · ` +
      `blocked by robots ${tally("blocked")} · error ${tally("error")}`,
  );

  writeEvidence("url-health.json", {
    as_of: AS_OF,
    links_checked: results.length,
    tally: {
      ok: tally("ok"),
      redirected: tally("redirected"),
      dead: tally("dead"),
      blocked: tally("blocked"),
      error: tally("error"),
    },
    results,
  });
}

await main();
