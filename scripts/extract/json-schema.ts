import { z } from "zod";

type JsonObject = Record<string, unknown>;

/**
 * Strict-mode JSON Schema from a Zod schema.
 *
 * Both providers' structured-output modes demand the same thing: every property
 * listed in `required`, and `additionalProperties: false` on every object. Zod
 * does not emit that by default, so we walk the tree and enforce it.
 *
 * Nullability is expressed as a nullable type rather than an optional field —
 * "the page does not say" has to be a value the model can return, not a key it
 * can silently omit.
 */
function enforceStrict(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) enforceStrict(child);
    return;
  }
  if (!node || typeof node !== "object") return;

  const schema = node as JsonObject;

  if (schema.type === "object" || schema.properties) {
    const properties = (schema.properties ?? {}) as JsonObject;
    schema.additionalProperties = false;
    schema.required = Object.keys(properties);
    for (const value of Object.values(properties)) enforceStrict(value);
  }

  for (const key of ["items", "anyOf", "allOf", "oneOf", "$defs", "definitions"]) {
    if (key in schema) enforceStrict(schema[key]);
  }
}

/**
 * Gemini's `responseSchema` is an OpenAPI 3.0 subset, NOT JSON Schema.
 *
 * Two differences bite immediately, and both would silently produce a broken
 * schema rather than an error:
 *
 *  - Nullability is a `nullable: true` flag, not `anyOf: [T, {type: "null"}]`.
 *    Left as anyOf, every "the page does not say" field becomes unrepresentable
 *    — which is the one answer this pipeline most needs the model to be able to
 *    give.
 *  - `additionalProperties` is not part of the subset and is rejected.
 *
 * Types are emitted uppercase (STRING, OBJECT) to match the OpenAPI enum.
 */
function toGeminiNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiNode);
  if (!node || typeof node !== "object") return node;

  const schema = { ...(node as JsonObject) };

  // anyOf [T, null] is Zod's nullable — collapse it into Gemini's flag.
  const anyOf = schema.anyOf as JsonObject[] | undefined;
  if (Array.isArray(anyOf)) {
    const nonNull = anyOf.filter((entry) => entry?.type !== "null");
    if (nonNull.length === 1 && nonNull.length < anyOf.length) {
      const merged: JsonObject = {
        ...(toGeminiNode(nonNull[0]) as JsonObject),
        nullable: true,
      };
      if (schema.description) merged.description = schema.description;
      return merged;
    }
    schema.anyOf = anyOf.map(toGeminiNode);
  }

  delete schema.additionalProperties;
  delete schema.$schema;

  if (typeof schema.type === "string") {
    schema.type = schema.type.toUpperCase();
  }

  if (schema.properties && typeof schema.properties === "object") {
    const properties = schema.properties as JsonObject;
    schema.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, toGeminiNode(value)]),
    );
    // Gemini honours field order; keeping it stable makes outputs comparable.
    schema.propertyOrdering = Object.keys(properties);
  }

  if (schema.items) schema.items = toGeminiNode(schema.items);

  return schema;
}

export function toGeminiSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, {
    io: "output",
    reused: "inline",
  }) as JsonObject;

  return toGeminiNode(json) as JsonObject;
}

export function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, {
    io: "output",
    // Inline everything: some providers reject $ref/$defs in strict mode.
    reused: "inline",
  }) as JsonObject;

  delete json.$schema;
  enforceStrict(json);
  return json;
}
