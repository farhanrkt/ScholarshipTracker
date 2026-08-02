import type { z } from "zod";

import { toStrictJsonSchema } from "../json-schema.ts";
import {
  DailyLimitError,
  RefusalError,
  TruncatedError,
  type CompletionRequest,
  type CompletionResult,
  type ExtractionProvider,
} from "./types.ts";

const BASE_URL = "https://api.groq.com/openai/v1";

/** Override with GROQ_MODEL. `npm run extract -- --models` lists what your key can reach. */
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

/**
 * Free-tier tokens per minute. Override with GROQ_TPM if your account differs —
 * the number is per model and shown in the console under Settings → Limits.
 */
const DEFAULT_TPM = 12_000;

/**
 * Output reservation.
 *
 * Groq counts `max_completion_tokens` against TPM whether or not the model uses
 * it, so an over-generous value spends the whole minute's budget before a
 * single character of the page is read. The extraction JSON is ~1k tokens even
 * with a long timeline, so 3k is comfortable.
 */
const OUTPUT_RESERVE = 3_000;

/**
 * Longest 429 wait worth sleeping through. Beyond this it is a day-scale quota,
 * not a burst — and a script that silently sleeps for 40 minutes looks broken.
 */
const MAX_RETRY_WAIT_SECONDS = 120;

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface ChatResponse {
  model?: string;
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; type?: string };
}

export async function listGroqModels(apiKey: string): Promise<string[]> {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => Boolean(id))
    .sort();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window limiter over the last 60 seconds.
 *
 * TPM is a rate, not a per-request cap, so right-sized calls still need pacing:
 * three 5k-token requests back to back breach a 12k limit even though none of
 * them is too big on its own.
 */
class TokensPerMinute {
  #limit: number;
  #spent: Array<{ at: number; tokens: number }> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get limit() {
    return this.#limit;
  }

  async reserve(tokens: number): Promise<void> {
    if (tokens > this.#limit) {
      throw new Error(
        `A single request needs ~${tokens.toLocaleString()} tokens but the limit is ${this.#limit.toLocaleString()} TPM. Lower --pages, or set GROQ_TPM if your account allows more.`,
      );
    }

    for (;;) {
      const now = Date.now();
      this.#spent = this.#spent.filter((entry) => now - entry.at < 60_000);
      const used = this.#spent.reduce((sum, entry) => sum + entry.tokens, 0);

      if (used + tokens <= this.#limit) {
        this.#spent.push({ at: now, tokens });
        return;
      }

      const oldest = this.#spent[0]!;
      const waitMs = 60_000 - (now - oldest.at) + 500;
      console.log(
        `    · TPM budget reached, waiting ${Math.ceil(waitMs / 1000)}s`,
      );
      await sleep(waitMs);
    }
  }
}

/** Rough but consistent; Groq bills real tokens, this only paces us. */
const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

/**
 * Groq exposes an OpenAI-compatible endpoint, so this is plain fetch rather
 * than another SDK dependency.
 *
 * Structured-output support varies by model. We ask for strict `json_schema`
 * first and fall back to `json_object` when the model rejects it — the response
 * is validated against Zod either way, and every value still has to survive
 * grounding. `openai/gpt-oss-*` models generally accept json_schema natively if
 * you want to skip the fallback; check with `--models`.
 */
export class GroqProvider implements ExtractionProvider {
  readonly name = "groq";
  readonly model: string;
  readonly promptBudgetChars: number;
  #apiKey: string;
  #supportsJsonSchema = true;
  #limiter: TokensPerMinute;
  #schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

  #schemaFor(schema: z.ZodType): Record<string, unknown> {
    let converted = this.#schemaCache.get(schema);
    if (!converted) {
      converted = toStrictJsonSchema(schema);
      this.#schemaCache.set(schema, converted);
    }
    return converted;
  }

  constructor(apiKey: string, model = process.env.GROQ_MODEL || DEFAULT_MODEL) {
    this.#apiKey = apiKey;
    this.model = model;

    const tpm = Number(process.env.GROQ_TPM) || DEFAULT_TPM;
    this.#limiter = new TokensPerMinute(tpm);

    // Whatever is left of a minute's budget after the output reservation and
    // the fixed prompt overhead, converted back to characters.
    //
    // Deliberately spends only 85% of the limit: the token estimate is a
    // character-count approximation, and sizing to exactly 100% turns every
    // small drift into a 429. The remainder is slack, not waste.
    const promptTokens = Math.max(
      Math.floor(tpm * 0.85) - OUTPUT_RESERVE - 1_500,
      1_000,
    );
    this.promptBudgetChars = Math.floor(promptTokens * 3.5);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.#supportsJsonSchema) {
      try {
        return await this.#call(request, true);
      } catch (error) {
        if (!(error instanceof SchemaUnsupportedError)) throw error;
        console.log(
          `    · ${this.model} rejected json_schema mode, falling back to json_object`,
        );
        this.#supportsJsonSchema = false;
      }
    }
    return this.#call(request, false);
  }

  async #call(
    request: CompletionRequest,
    useSchema: boolean,
    attempt = 0,
  ): Promise<CompletionResult> {
    // In fallback mode the model has no schema enforcement, so the shape has to
    // be carried in the prompt instead — which is why this costs extra tokens.
    const schema = this.#schemaFor(request.schema);
    const system = useSchema
      ? request.system
      : `${request.system}\n\nRespond with a single JSON object and nothing else. It must match this JSON Schema exactly:\n${JSON.stringify(schema)}`;

    const maxOutput = Math.min(request.maxTokens, OUTPUT_RESERVE);
    await this.#limiter.reserve(
      estimateTokens(system) + estimateTokens(request.user) + maxOutput,
    );

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: maxOutput,
        // Extraction is a copying task, not a creative one.
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: request.user },
        ],
        response_format: useSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: request.schemaName,
                schema,
                strict: true,
              },
            }
          : { type: "json_object" },
      }),
      signal: AbortSignal.timeout(180_000),
    });

    const body = (await response.json()) as ChatResponse;

    if (!response.ok) {
      const message = body.error?.message ?? `HTTP ${response.status}`;

      if (useSchema && /response_format|json_schema|schema/i.test(message)) {
        throw new SchemaUnsupportedError(message);
      }
      if (/model .*(not found|does not exist|decommissioned)/i.test(message)) {
        const available = await listGroqModels(this.#apiKey);
        throw new Error(
          `Groq rejected model "${this.model}": ${message}\nAvailable to your key:\n  ${available.join("\n  ")}\nSet GROQ_MODEL in .env.local.`,
        );
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || 0;
        const parsed = /try again in ([\d.]+)s/i.exec(message);
        const waitSeconds = Math.ceil(retryAfter || Number(parsed?.[1]) || 20);

        // A daily cap is not something to wait out. Groq names the limit it
        // hit, and the retry hint for TPD is measured in tens of minutes —
        // sleeping through that is indistinguishable from a hung script.
        const daily = /per day|TPD|RPD/i.test(message);
        if (daily || waitSeconds > MAX_RETRY_WAIT_SECONDS) {
          throw new DailyLimitError(
            `Groq ${daily ? "daily" : "long-window"} limit reached — it suggests waiting ${Math.round(waitSeconds / 60)} minutes.\n` +
              `  ${message}\n` +
              `  Options: wait for the reset, switch GROQ_MODEL (limits are per model),\n` +
              `  or add a second provider — the pipeline is provider-agnostic.`,
          );
        }

        // A short window: our estimate drifted, or another process shares the
        // key. Honour the server's own hint rather than guessing.
        if (attempt < 2) {
          console.log(`    · rate limited, retrying in ${waitSeconds}s`);
          await sleep(waitSeconds * 1000 + 500);
          return this.#call(request, useSchema, attempt + 1);
        }
      }

      throw new Error(`Groq error: ${message}`);
    }

    const choice = body.choices?.[0];
    const finish = choice?.finish_reason;

    if (finish === "length") throw new TruncatedError(this.model);
    if (finish === "content_filter") throw new RefusalError("content filter");

    const text = choice?.message?.content;
    if (!text) throw new Error("Groq returned an empty response");

    return {
      text,
      model: body.model ?? this.model,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }
}

class SchemaUnsupportedError extends Error {}
