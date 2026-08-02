import { AnthropicProvider } from "./anthropic.ts";
import { GeminiProvider } from "./gemini.ts";
import { GroqProvider } from "./groq.ts";
import type { ExtractionProvider } from "./types.ts";

export * from "./types.ts";
export { listGroqModels } from "./groq.ts";
export { listGeminiModels } from "./gemini.ts";

export const PROVIDER_NAMES = ["gemini", "groq", "anthropic"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

const ENV_KEY: Record<ProviderName, string> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

function build(name: ProviderName): ExtractionProvider {
  const key = process.env[ENV_KEY[name]];
  if (!key && name !== "anthropic") {
    throw new Error(`${ENV_KEY[name]} is not set. Add it to .env.local.`);
  }
  switch (name) {
    case "gemini":
      return new GeminiProvider(key!);
    case "groq":
      return new GroqProvider(key!);
    case "anthropic":
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local.");
      return new AnthropicProvider();
  }
}

/**
 * Preference order, and why.
 *
 * Gemini first: its free tier is request-bound with a generous token
 * allowance, which suits batch crawling. Groq's free tier is 12k tokens per
 * minute with a day cap that a single discovery run can exhaust — fine for
 * extraction over a handful of programmes, not for volume. Anthropic is the
 * paid escalation path for pages the free tiers come back empty on.
 *
 * Grounding is what makes reordering this safe: a weaker model produces more
 * quotes it cannot back up, and those get discarded, so provider choice moves
 * YIELD rather than correctness.
 */
export function pickProvider(preferred?: string): ExtractionProvider {
  if (preferred) {
    if (!(PROVIDER_NAMES as readonly string[]).includes(preferred)) {
      throw new Error(
        `Unknown provider "${preferred}". One of: ${PROVIDER_NAMES.join(", ")}`,
      );
    }
    return build(preferred as ProviderName);
  }

  const available = PROVIDER_NAMES.filter((name) => process.env[ENV_KEY[name]]);
  if (available.length === 0) {
    throw new Error(
      `No model provider configured. Set one of ${Object.values(ENV_KEY).join(", ")} in .env.local.`,
    );
  }
  return build(available[0]!);
}

/** The next provider down the list — used by --escalate. */
export function pickFallbackProvider(
  current: ExtractionProvider,
): ExtractionProvider | null {
  const next = PROVIDER_NAMES.filter(
    (name) => name !== current.name && process.env[ENV_KEY[name]],
  );
  return next.length > 0 ? build(next[0]!) : null;
}
