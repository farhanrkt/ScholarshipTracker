/**
 * The machine-readable half of a page, which we were deleting unread.
 *
 * `htmlToText` strips `<script>` wholesale — correct for the analytics and
 * framework bundles that make up almost all of it, and it also throws away
 * `application/ld+json`, which is a funder stating its own award in structured
 * form. Tables fared no better: `</td>` became a newline, so a benefits table
 * arrived as a column of orphaned cells with the header row several lines above
 * and nothing tying the two together. "Tuition" on one line and "Covered in
 * full" on another is not a fact any reader can use, and the model duly read
 * past it.
 *
 * THE INTEGRATION IS THE POINT. This does not add an extraction path, a schema,
 * or a trust rule. It renders structured data into ordinary sentences and
 * appends them to the page's text, so:
 *
 *   - `findQuote` searches them like any other page text, which makes a value
 *     taken from JSON-LD SELF-GROUNDING — the quote is literally in the page
 *     source, so grounding succeeds by construction rather than by luck;
 *   - passage selection and the gap pass score them with the vocabulary they
 *     already have;
 *   - nothing downstream needs to know where a sentence came from.
 *
 * A funder that publishes `"educationalCredentialAwarded"` or a benefits table
 * is not being read more generously than one that writes prose. It is being
 * read at all.
 */

/** Everything ld+json can nest a payload under, in schema.org's own vocabulary. */
const CONTAINER_KEYS = ["@graph", "itemListElement", "mainEntity", "hasPart"];

/**
 * Keys worth rendering, and the words to render them with.
 *
 * An allowlist rather than a dump of every key. A page's JSON-LD routinely
 * carries breadcrumbs, logos, social profiles and a publisher's postal address
 * — thousands of characters of chrome that would crowd real prose out of the
 * passage budget, which is the exact failure `htmlToText` strips nav to avoid.
 *
 * The phrasing on the right is not cosmetic: these strings are what a quote
 * will be matched against and what a reviewer will read in the evidence panel,
 * so they use the words the topic scorers and the gap phrases already hunt for.
 */
const RENDERED_KEYS: Record<string, string> = {
  name: "Name",
  alternateName: "Also known as",
  description: "Description",
  applicationDeadline: "Application deadline",
  applicationStartDate: "Applications open",
  startDate: "Start date",
  endDate: "End date",
  validFrom: "Valid from",
  validThrough: "Valid through",
  award: "Award",
  amount: "Amount",
  value: "Value",
  currency: "Currency",
  eligibilityCriteria: "Eligibility criteria",
  eligibleRegion: "Eligible region",
  educationalCredentialAwarded: "Credential awarded",
  educationalLevel: "Educational level",
  occupationalCategory: "Field of study",
  about: "About",
  provider: "Provider",
  funder: "Funder",
  sponsor: "Sponsor",
  numberOfCredits: "Number of credits",
  timeToComplete: "Duration",
  duration: "Duration",
  courseMode: "Study mode",
  applicationContact: "Application contact",
  url: "URL",
};

/** Scalars only — an object here is a nested entity and is walked, not printed. */
function renderScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 600 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/**
 * One entity's renderable lines.
 *
 * Depth-limited because schema.org graphs are self-referential often enough to
 * matter — a `provider` whose `parentOrganization` points back at the provider
 * is an ordinary shape, and an unbounded walk over one does not terminate.
 */
function renderEntity(node: unknown, depth: number, out: string[]): void {
  if (depth > 4 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node.slice(0, 40)) renderEntity(item, depth + 1, out);
    return;
  }

  const record = node as Record<string, unknown>;

  for (const key of CONTAINER_KEYS) {
    if (key in record) renderEntity(record[key], depth + 1, out);
  }

  for (const [key, label] of Object.entries(RENDERED_KEYS)) {
    if (!(key in record)) continue;

    const raw = record[key];
    const scalar = renderScalar(raw);
    if (scalar) {
      out.push(`${label}: ${scalar}`);
      continue;
    }

    // `{ "@type": "MonetaryAmount", "value": 1347, "currency": "GBP" }` and
    // friends: one level in, print what is printable, do not recurse forever.
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const nested = raw as Record<string, unknown>;
      const parts = Object.entries(nested)
        .filter(([nestedKey]) => nestedKey in RENDERED_KEYS)
        .map(([nestedKey, nestedValue]) => {
          const text = renderScalar(nestedValue);
          return text ? `${RENDERED_KEYS[nestedKey]} ${text}` : null;
        })
        .filter((part): part is string => part !== null);
      if (parts.length > 0) out.push(`${label}: ${parts.join(", ")}`);
      continue;
    }

    if (Array.isArray(raw)) {
      const items = raw
        .map(renderScalar)
        .filter((item): item is string => item !== null);
      if (items.length > 0) out.push(`${label}: ${items.join(", ")}`);
    }
  }

  // Walk remaining objects so a Course nested under a WebPage is still reached.
  for (const [key, value] of Object.entries(record)) {
    if (key in RENDERED_KEYS || CONTAINER_KEYS.includes(key)) continue;
    if (value && typeof value === "object") renderEntity(value, depth + 1, out);
  }
}

const LD_JSON =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Rendered lines from every `application/ld+json` block on the page. */
export function readJsonLd(html: string): string[] {
  const out: string[] = [];

  for (const match of html.matchAll(LD_JSON)) {
    const body = match[1];
    if (!body || body.length > 400_000) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Invalid JSON-LD is extremely common and is not our problem to report.
      continue;
    }

    renderEntity(parsed, 0, out);
  }

  return out;
}

/**
 * `<meta>` content worth reading.
 *
 * Narrow on purpose: a description tag is a funder's own one-sentence summary
 * and routinely carries the deadline, and everything else in the head is
 * either chrome or a duplicate of the title.
 */
const META_NAMES: Record<string, string> = {
  description: "Description",
  "og:description": "Description",
  "og:title": "Title",
};

const META_TAG = /<meta\b[^>]*>/gi;
const META_ATTR = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");

export function readMeta(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const tag of html.match(META_TAG) ?? []) {
    const key =
      tag.match(META_ATTR("name"))?.[1] ?? tag.match(META_ATTR("property"))?.[1];
    if (!key) continue;

    const label = META_NAMES[key.toLowerCase()];
    if (!label) continue;

    const content = tag.match(META_ATTR("content"))?.[1]?.trim();
    if (!content || content.length < 20 || content.length > 600) continue;
    if (seen.has(content)) continue;

    seen.add(content);
    out.push(`${label}: ${content}`);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

const TABLE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi;

/** Strip markup from one cell without the block-level newlines `htmlToText` adds. */
function cellText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A table as sentences, pairing every cell with its column header.
 *
 * This is where funders put the coverage matrix. ADB-JSP, MEXT and half the
 * university pages publish `Tuition | Full` as a grid, and the generic text
 * conversion turned that into two lines nothing ties together — a header block, then
 * a value block, with the pairing carried entirely by a visual layout that does
 * not survive being flattened.
 *
 * Rendering `Tuition: Full` restores the one thing that made the grid readable,
 * and does it in the exact shape the coverage phrases look for.
 *
 * Two-column tables are treated as label/value pairs even without a header row,
 * because that is overwhelmingly what a two-column table on a funding page is.
 */
export function readTables(html: string): string[] {
  const out: string[] = [];

  for (const table of html.match(TABLE) ?? []) {
    const rows: string[][] = [];

    for (const rowMatch of table.matchAll(ROW)) {
      const cells: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(CELL)) {
        cells.push(cellText(cellMatch[2] ?? ""));
      }
      if (cells.some((cell) => cell.length > 0)) rows.push(cells);
    }

    if (rows.length === 0) continue;

    // A header row is one whose cells are all `<th>`, or failing that the first
    // row of a table with more than two rows.
    const headerIsTh = /<th\b/i.test(table.split(/<\/tr>/i)[0] ?? "");
    const header = headerIsTh || rows.length > 2 ? rows[0] : null;
    const body = header ? rows.slice(1) : rows;

    for (const row of body.slice(0, 60)) {
      if (row.length === 0) continue;

      // Two columns: label/value, the common case and the useful one.
      if (row.length === 2 && row[0] && row[1]) {
        out.push(`${row[0]}: ${row[1]}`);
        continue;
      }

      // Wider: pair each cell with its own column header so the row reads as a
      // sentence rather than as a list of unattributed values.
      const label = row[0]?.trim();
      const parts = row
        .slice(1)
        .map((cell, index) => {
          if (!cell) return null;
          const columnName = header?.[index + 1]?.trim();
          return columnName ? `${columnName} ${cell}` : cell;
        })
        .filter((part): part is string => part !== null);

      if (label && parts.length > 0) out.push(`${label}: ${parts.join(", ")}`);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */

/**
 * How much rendered structure one page may contribute.
 *
 * A cap because a course catalogue's JSON-LD can be enormous, and this text
 * competes for the same passage budget as the page's actual prose. Past this
 * the page is better read as prose.
 */
const MAX_STRUCTURED_CHARS = 8_000;

/**
 * The structured half of a page, as text ready to append to the prose half.
 *
 * Labelled with a heading so a reviewer reading an evidence quote can tell that
 * it came from the page's markup rather than its visible copy — the fact is
 * equally real either way, but "where do I look on the page to check this" has
 * a different answer, and a reviewer who cannot find the sentence is a reviewer
 * who rejects a correct extraction.
 */
export function structuredText(html: string): string {
  const lines = [...readJsonLd(html), ...readMeta(html), ...readTables(html)];

  const seen = new Set<string>();
  const unique: string[] = [];
  let used = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 6 || seen.has(trimmed)) continue;
    if (used + trimmed.length > MAX_STRUCTURED_CHARS) break;
    seen.add(trimmed);
    unique.push(trimmed);
    used += trimmed.length;
  }

  if (unique.length === 0) return "";

  return `Published page data\n${unique.join("\n")}`;
}
