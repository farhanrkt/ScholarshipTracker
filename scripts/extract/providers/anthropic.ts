import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import { toStrictJsonSchema } from "../json-schema.ts";

import {
  RefusalError,
  TruncatedError,
  type CompletionRequest,
  type CompletionResult,
  type ExtractionProvider,
} from "./types.ts";

const DEFAULT_MODEL = "claude-opus-5";

/** The escalation path: used for pages the cheap provider came back empty on. */
export class AnthropicProvider implements ExtractionProvider {
  readonly name = "anthropic";
  readonly model: string;
  /** No per-minute squeeze here — the constraint is cost, not a rate limit. */
  readonly promptBudgetChars = 60_000;
  #client = new Anthropic();
  #schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

  #schemaFor(schema: z.ZodType): Record<string, unknown> {
    let converted = this.#schemaCache.get(schema);
    if (!converted) {
      converted = toStrictJsonSchema(schema);
      this.#schemaCache.set(schema, converted);
    }
    return converted;
  }

  constructor(model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL) {
    this.model = model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const response = await this.#client.messages.create({
      model: this.model,
      // Thinking is on by default on Opus 5 and shares this budget with the
      // response, so it needs far more headroom than the JSON itself — unlike
      // Groq, where a large reservation would eat the rate limit.
      max_tokens: Math.max(request.maxTokens, 12_000),
      system: request.system,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: this.#schemaFor(request.schema) },
      },
      messages: [{ role: "user", content: request.user }],
    });

    if (response.stop_reason === "refusal") {
      throw new RefusalError(response.stop_details?.category ?? "no category");
    }
    if (response.stop_reason === "max_tokens") {
      throw new TruncatedError(this.model);
    }

    const block = response.content.find((entry) => entry.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("No text block in the Anthropic response");
    }

    return {
      text: block.text,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
