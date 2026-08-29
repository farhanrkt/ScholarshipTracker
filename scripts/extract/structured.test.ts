import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readJsonLd, readMeta, readTables, structuredText } from "./structured.ts";

/**
 * Everything this module emits becomes page TEXT, which means two things at
 * once: a quote found in it grounds a value onto a student's card, and every
 * character of it competes with real prose for the passage budget. So both
 * directions are failures worth testing — a benefits table that does not
 * survive is a coverage matrix nobody can fill, and a page's worth of
 * breadcrumbs that does survive is the passage budget spent on navigation.
 */

describe("JSON-LD", () => {
  test("renders an award's own structured description", () => {
    const lines = readJsonLd(`
      <script type="application/ld+json">
      {"@type":"EducationalOccupationalProgram",
       "name":"Example Global Scholarship",
       "applicationDeadline":"2026-10-06",
       "educationalCredentialAwarded":"Master's degree"}
      </script>
    `);

    assert.ok(lines.includes("Name: Example Global Scholarship"));
    assert.ok(lines.includes("Application deadline: 2026-10-06"));
    assert.ok(lines.includes("Credential awarded: Master's degree"));
  });

  test("follows @graph, which is how most sites actually ship it", () => {
    const lines = readJsonLd(`
      <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"WebPage","name":"Ignore me"},
        {"@type":"Course","name":"Example Scholarship","timeToComplete":"P3Y"}
      ]}
      </script>
    `);

    assert.ok(lines.includes("Duration: P3Y"));
  });

  test("a deeply nested graph terminates instead of hanging the crawl", () => {
    // `provider.parentOrganization.provider` is an ordinary schema.org shape,
    // and an unbounded walk over one never returns — which on a crawl is not a
    // wrong answer, it is a run that never finishes.
    let nested: Record<string, unknown> = { name: "Deepest name value" };
    for (let index = 0; index < 30; index++) nested = { provider: nested };

    const lines = readJsonLd(
      `<script type="application/ld+json">${JSON.stringify(nested)}</script>`,
    );
    assert.ok(Array.isArray(lines));
  });

  test("invalid JSON-LD is skipped, not thrown", () => {
    // Broken JSON-LD is extremely common and is not our problem to report. A
    // throw here would lose the whole page over a stray comma in a script tag.
    assert.deepEqual(
      readJsonLd(`<script type="application/ld+json">{ nope, }</script>`),
      [],
    );
  });

  test("keys outside the allowlist stay out", () => {
    // Breadcrumbs, logos and a publisher's postal address are thousands of
    // characters of chrome. Letting them through is the passage budget spent
    // on exactly the material `htmlToText` strips nav to avoid.
    const lines = readJsonLd(`
      <script type="application/ld+json">
      {"@type":"WebPage","breadcrumb":"Home > Funding > Awards",
       "logo":"https://example.org/logo.png","name":"Example Scholarship"}
      </script>
    `);

    assert.ok(lines.some((line) => line.startsWith("Name:")));
    assert.ok(!lines.some((line) => line.includes("Home > Funding")));
  });
});

describe("tables", () => {
  test("a two-column benefits table becomes label/value sentences", () => {
    // This is where funders put the coverage matrix. Flattened by the generic
    // text converter it arrives as a column of orphaned cells — "Tuition" on
    // one line, "Covered in full" on another — and the pairing that made the
    // grid readable is gone, which is why coverage came back empty on pages
    // that plainly stated it.
    const lines = readTables(`
      <table>
        <tr><td>Tuition</td><td>Covered in full</td></tr>
        <tr><td>Monthly stipend</td><td>GBP 1,347 per month</td></tr>
      </table>
    `);

    assert.deepEqual(lines, [
      "Tuition: Covered in full",
      "Monthly stipend: GBP 1,347 per month",
    ]);
  });

  test("a wider table pairs each cell with its own column header", () => {
    const lines = readTables(`
      <table>
        <tr><th>Benefit</th><th>Masters</th><th>PhD</th></tr>
        <tr><td>Stipend</td><td>1,000</td><td>1,400</td></tr>
      </table>
    `);

    assert.deepEqual(lines, ["Stipend: Masters 1,000, PhD 1,400"]);
  });

  test("markup inside a cell does not leak into the text", () => {
    const lines = readTables(
      `<table><tr><td><strong>Airfare</strong></td><td>Return <em>economy</em> flight</td></tr></table>`,
    );

    assert.deepEqual(lines, ["Airfare: Return economy flight"]);
  });
});

describe("meta", () => {
  test("a description carrying the deadline is kept", () => {
    const lines = readMeta(
      `<meta name="description" content="The Example Scholarship closes on 6 October 2026 for the 2027/28 intake.">`,
    );

    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.includes("6 October 2026"));
  });

  test("a short or duplicated description is dropped", () => {
    const lines = readMeta(`
      <meta name="description" content="Scholarships">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    `);

    assert.deepEqual(lines, []);
  });
});

describe("the combined block", () => {
  test("is labelled so a reviewer knows where to look on the page", () => {
    // A reviewer who cannot find the sentence rejects a correct extraction. The
    // fact is equally real whether it came from markup or visible copy, but
    // "where do I look to check this" has a different answer.
    const text = structuredText(
      `<table><tr><td>Tuition</td><td>Covered in full</td></tr></table>`,
    );

    assert.ok(text.startsWith("Published page data"));
    assert.ok(text.includes("Tuition: Covered in full"));
  });

  test("a page with no structured data contributes nothing", () => {
    // Not an empty heading — nothing at all. A bare label appended to every
    // page in the crawl is noise in every passage that happens to include it.
    assert.equal(structuredText("<p>Just prose here.</p>"), "");
  });

  test("the same line from two sources appears once", () => {
    const text = structuredText(`
      <meta name="description" content="The Example Scholarship covers full tuition and a stipend.">
      <meta property="og:description" content="The Example Scholarship covers full tuition and a stipend.">
    `);

    const occurrences = text.split("The Example Scholarship covers").length - 1;
    assert.equal(occurrences, 1);
  });
});
