/**
 * What the public API actually hands out.
 *
 * The RLS policies in supabase/migrations say one thing; a view created without
 * `security_invoker` can say another, because a view reads its underlying
 * tables with its OWNER's rights. docs/architecture.md:136-142 states the rule.
 * This checks the live project against it.
 *
 * READS ONLY. It never inserts, updates, deletes or calls an RPC — including to
 * test whether a write would be refused. Write paths are established by reading
 * the SQL, because a probe that succeeds has already changed production.
 *
 *   node --env-file=.env.local scripts/audit/rls-exposure.ts
 */

import { AS_OF, requireEnv, writeEvidence } from "./lib.ts";

/** Everything PostgREST exposes, read from the live OpenAPI document. */
async function exposedRelations(url: string, key: string): Promise<string[]> {
  const response = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
  });
  const spec = (await response.json()) as { paths?: Record<string, unknown> };
  return Object.keys(spec.paths ?? {})
    .filter((path) => path !== "/" && !path.startsWith("/rpc/"))
    .map((path) => path.slice(1))
    .sort();
}

async function countAsAnon(url: string, anon: string, relation: string) {
  const response = await fetch(`${url}/rest/v1/${relation}?select=*`, {
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  const range = response.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  return {
    status: response.status,
    rows_visible: Number.isFinite(total) ? total : 0,
    body: response.ok ? undefined : (await response.text()).slice(0, 160),
  };
}

async function main() {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anon = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const service = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const relations = await exposedRelations(url, service);
  console.log(`\nRLS EXPOSURE — ${relations.length} relations exposed, as of ${AS_OF}`);
  console.log("Reading each one with the anon key, signed in as nobody.\n");

  const results: Record<string, Awaited<ReturnType<typeof countAsAnon>> & { total?: number }> = {};

  for (const relation of relations) {
    const asAnon = await countAsAnon(url, anon, relation);

    const full = await fetch(`${url}/rest/v1/${relation}?select=*`, {
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
    });
    const total = Number((full.headers.get("content-range") ?? "").split("/")[1]);

    results[relation] = { ...asAnon, total: Number.isFinite(total) ? total : 0 };
    const leak = asAnon.rows_visible > 0 ? "  <-- READABLE BY ANYONE" : "";
    console.log(
      `  ${relation.padEnd(34)} anon=${String(asAnon.rows_visible).padStart(4)} / ` +
        `${String(results[relation].total).padStart(4)} total  (${asAnon.status})${leak}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const leaking = Object.entries(results).filter(([, r]) => r.rows_visible > 0);
  console.log(`\n${leaking.length} relations return rows to an anonymous caller:`);
  for (const [name] of leaking) console.log(`  ${name}`);

  writeEvidence("rls-exposure.json", {
    as_of: AS_OF,
    method:
      "GET only, with the published anon key and no session. Write paths were read from " +
      "supabase/migrations rather than probed, so nothing here touched production data.",
    relations: results,
    readable_anonymously: leaking.map(([name]) => name),
  });
}

await main();
