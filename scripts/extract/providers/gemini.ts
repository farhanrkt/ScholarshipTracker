import type { z } from "zod";

import { toGeminiSchema } from "../json-schema.ts";
import {
  DailyLimitError,
  RefusalError,
  TruncatedError,
  type CompletionRequest,
  type CompletionResult,
  type ExtractionProvider,
} from "./types.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Override with GEMINI_MODEL. `--models` lists what your key can reach.
 *
 * The lite model, and the `-latest` alias rather than a pinned version, because
 * this pipeline runs on the free tier and quotas are PER MODEL: a pinned id
 * silently stops being the one Google grants free capacity on. Extraction is a
 * copying task constrained by a verbatim-quote check, so model capability moves
 * yield rather than correctness — an ungrounded value is discarded either way.
 */
const DEFAULT_MODEL = "gemini-flash-lite-latest";

/**
 * Free-tier requests per minute. Gemini's free tier is request-bound rather
 * than token-bound — the token allowance is generous enough that pacing by
 * requests is what actually matters. Override with GEMINI_RPM.
 */
const DEFAULT_RPM = 15;

/**
 * How long to wait for one completion. Override with GEMINI_TIMEOUT_MS.
 *
 * Raised from 180s after every profile call in a three-programme Chevening run
 * died on `The operation was aborted due to timeout`. That is the expensive
 * failure: the profile call is the half that reads coverage, eligibility and
 * the document checklist, so a timeout costs the entire depth of a row while
 * the cycle call still succeeds and makes the run look fine.
 *
 * The profile response is several thousand tokens of JSON, each value carrying
 * its own verbatim quote, and a lite model emitting that off a 45k-character
 * prompt is simply slower than three minutes some of the time.
 */
const DEFAULT_TIMEOUT_MS = 300_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string; code?: number };
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) return [];
  const body = (await response.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  return (body.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => model.name?.replace(/^models\//, ""))
    .filter((name): name is string => Boolean(name))
    .sort();
}

/** Sliding window over the last 60 seconds, counting requests. */
class RequestsPerMinute {
  #limit: number;
  #times: number[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async reserve(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#times = this.#times.filter((at) => now - at < 60_000);

      if (this.#times.length < this.#limit) {
        this.#times.push(now);
        return;
      }

      const waitMs = 60_000 - (now - this.#times[0]!) + 500;
      console.log(`    · RPM budget reached, waiting ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

/**
 * Google's Generative Language API over plain fetch — no SDK dependency.
 *
 * Structured output goes through `responseSchema`, which is an OpenAPI subset
 * rather than JSON Schema (see `toGeminiSchema`). If a model rejects the
 * schema we fall back to JSON mode with the shape carried in the prompt, the
 * same defence used for Groq: the response is validated against Zod either
 * way, and every value still has to survive grounding.
 */
export class GeminiProvider implements ExtractionProvider {
  readonly name = "gemini";
  readonly model: string;
  /** 1M context — the constraint here is requests per minute, not size. */
  readonly promptBudgetChars = 100_000;
  #apiKey: string;
  #supportsSchema = true;
  #limiter: RequestsPerMinute;
  #schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

  constructor(apiKey: string, model = process.env.GEMINI_MODEL || DEFAULT_MODEL) {
    this.#apiKey = apiKey;
    this.model = model;
    this.#limiter = new RequestsPerMinute(
      Number(process.env.GEMINI_RPM) || DEFAULT_RPM,
    );
  }

  #schemaFor(schema: z.ZodType): Record<string, unknown> {
    let converted = this.#schemaCache.get(schema);
    if (!converted) {
      converted = toGeminiSchema(schema);
      this.#schemaCache.set(schema, converted);
    }
    return converted;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.#supportsSchema) {
      try {
        return await this.#call(request, true);
      } catch (error) {
        if (!(error instanceof SchemaUnsupportedError)) throw error;
        console.log(
          `    · ${this.model} rejected responseSchema, falling back to JSON mode`,
        );
        this.#supportsSchema = false;
      }
    }
    return this.#call(request, false);
  }

  async #call(
    request: CompletionRequest,
    useSchema: boolean,
    attempt = 0,
  ): Promise<CompletionResult> {
    const schema = this.#schemaFor(request.schema);

    const system = useSchema
      ? request.system
      : `${request.system}\n\nRespond with a single JSON object and nothing else, matching this shape exactly:\n${JSON.stringify(schema)}`;

    await this.#limiter.reserve();

    const response = await fetch(
      `${BASE_URL}/models/${this.model}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.#apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: request.user }] }],
          generationConfig: {
            responseMimeType: "application/json",
            ...(useSchema ? { responseSchema: schema } : {}),
            maxOutputTokens: request.maxTokens,
            // Extraction is a copying task, not a creative one.
            temperature: 0,
          },
        }),
        signal: AbortSignal.timeout(
          Number(process.env.GEMINI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ),
      },
    );

    const body = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      const message = body.error?.message ?? `HTTP ${response.status}`;

      if (useSchema && /schema|responseSchema|response_schema/i.test(message)) {
        throw new SchemaUnsupportedError(message);
      }

      if (response.status === 404 || /not found|not supported/i.test(message)) {
        const available = await listGeminiModels(this.#apiKey);
        throw new Error(
          `Gemini rejected model "${this.model}": ${message}\nAvailable to your key:\n  ${available.join("\n  ")}\nSet GEMINI_MODEL in .env.local.`,
        );
      }

      if (response.status === 429) {
        // Free-tier daily caps reset at midnight Pacific; there is no point
        // sleeping through that inside a run.
        if (/per day|daily|quota exceeded/i.test(message)) {
          throw new DailyLimitError(
            `Gemini daily quota reached.\n  ${message}\n  It resets at midnight Pacific. Switch GEMINI_MODEL (quotas are per model) or use --provider groq.`,
          );
        }
        if (attempt < 2) {
          const waitSeconds = 30 * (attempt + 1);
          console.log(`    · rate limited, retrying in ${waitSeconds}s`);
          await sleep(waitSeconds * 1000);
          return this.#call(request, useSchema, attempt + 1);
        }
      }

      throw new Error(`Gemini error: ${message}`);
    }

    // A blocked prompt returns 200 with no candidates at all.
    if (body.promptFeedback?.blockReason) {
      throw new RefusalError(body.promptFeedback.blockReason);
    }

    const candidate = body.candidates?.[0];
    const finish = candidate?.finishReason;

    if (finish === "MAX_TOKENS") throw new TruncatedError(this.model);
    if (finish && ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(finish)) {
      throw new RefusalError(finish);
    }

    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!text) throw new Error("Gemini returned an empty response");

    return {
      text,
      model: this.model,
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

class SchemaUnsupportedError extends Error {}
