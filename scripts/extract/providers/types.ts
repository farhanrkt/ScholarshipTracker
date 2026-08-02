import type { z } from "zod";

/**
 * The seam between "what we ask for" and "who answers".
 *
 * Grounding is what makes this seam safe to move. A weaker model produces more
 * quotes it cannot back up, and those get discarded — so provider choice
 * changes YIELD, not CORRECTNESS. That is the whole reason a free-tier model is
 * a reasonable default here.
 */

export interface CompletionRequest {
  system: string;
  user: string;
  schemaName: string;
  /**
   * The Zod schema, not a converted one — every provider speaks a different
   * dialect (JSON Schema strict mode, OpenAPI subset), and converting at the
   * call site would mean the caller knowing which provider it got.
   */
  schema: z.ZodType;
  maxTokens: number;
}

export interface CompletionResult {
  /** Raw JSON text. Callers validate it — providers do not. */
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ExtractionProvider {
  /** Short id used in logs and stored on the extraction row. */
  readonly name: string;
  readonly model: string;
  /**
   * How much page text this provider can be sent per call.
   *
   * Not a context-window figure — a budget. On a rate-limited free tier the
   * binding constraint is tokens per minute, not tokens per request, and the
   * reserved output counts against it too.
   */
  readonly promptBudgetChars: number;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/** Thrown when the provider declined rather than failed. */
export class RefusalError extends Error {
  constructor(reason: string) {
    super(`Model declined the request: ${reason}`);
    this.name = "RefusalError";
  }
}

/** Quota exhausted for the day: stop the run, do not wait it out. */
export class DailyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyLimitError";
  }
}

/** Thrown when the response was cut off — the JSON will be unparseable. */
export class TruncatedError extends Error {
  constructor(model: string) {
    super(
      `${model} hit its output limit before finishing. Lower --pages or the passage budget.`,
    );
    this.name = "TruncatedError";
  }
}
