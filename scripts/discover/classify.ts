import { z } from "zod";

import { CLASSIFY_CHARS } from "./prefilter.ts";
import type { ExtractionProvider } from "../extract/providers/index.ts";

/**
 * Triage: is this page a scholarship programme worth a row?
 *
 * NO grounding here, on purpose. This is a judgement, not a fact copied off a
 * page — there is nothing to quote. A wrong answer costs a wasted fetch or a
 * rejected review card, never a wrong date on a student's calendar, because
 * discovery is forbidden from writing dates at all. That is exactly why the
 * cheapest available model is the right one for this stage.
 */

export const ClassificationSchema = z.object({
  is_scholarship_programme: z
    .boolean()
    .describe(
      "True only if this page describes a specific, named funding programme students can apply to. News articles, blog posts, and generic 'how to fund your studies' guides are false.",
    ),
  programme_name: z
    .string()
    .nullable()
    .describe("Official name of the programme, as the page gives it"),
  funder: z
    .string()
    .nullable()
    .describe("Government, university, or organisation funding it"),
  host_country: z
    .string()
    .nullable()
    .describe("Country you would study in. Null if the page does not say."),
  degree_levels: z
    .array(z.enum(["Bachelors", "Masters", "PhD"]))
    .describe("Levels this funds. Empty if the page does not say."),
  is_fully_funded: z
    .boolean()
    .nullable()
    .describe(
      "True if it covers tuition AND living costs. False if partial. Null if unclear.",
    ),
  open_to_international: z
    .boolean()
    .nullable()
    .describe("Open to international students? Null if unclear."),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string().describe("One sentence on what this funds and for whom."),
});

export type Classification = z.infer<typeof ClassificationSchema>;

const SYSTEM = `You triage web pages for a database of fully-funded international scholarships.

Decide whether a page describes a specific, named funding programme a student could apply to.

Say false for:
- News, blog posts, press releases, and success stories about a programme
- Generic advice pages ("how to fund your masters", "10 tips for applications")
- Index or listing pages that link to many programmes without being one
- Application portals with no description of what is funded
- Pages about a university in general rather than a specific award

Say true for: a named award with a described benefit and an audience who can apply.

Do not guess details the page does not give — null and empty arrays are correct answers. Never state dates or deadlines; they are not part of this task.`;

export async function classifyPage(
  provider: ExtractionProvider,
  url: string,
  text: string,
): Promise<{ classification: Classification; model: string; inputTokens: number; outputTokens: number }> {
  const result = await provider.complete({
    system: SYSTEM,
    user: `URL: ${url}\n\n--- BEGIN PAGE TEXT ---\n${text.slice(0, Math.min(provider.promptBudgetChars, CLASSIFY_CHARS))}\n--- END PAGE TEXT ---`,
    schemaName: "scholarship_page_classification",
    schema: ClassificationSchema,
    maxTokens: 4_000,
  });

  const trimmed = result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const json = JSON.parse(
    start === 0 && end === trimmed.length - 1 ? trimmed : trimmed.slice(start, end + 1),
  );

  return {
    classification: ClassificationSchema.parse(json),
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
