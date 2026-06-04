// Classify a JSON Schema node into a small form-model the renderer walks. This
// is the genericity core of the config form: it reads the schema STRUCTURE
// (string / number / array / fixed-object / open-keyed record) and never the
// names of any field — so the SAME form renders a code bundle's config and a
// fabricated bundle's config with zero hardcoding. The `GET /config/schema`
// document (derived from the one Zod schema) is the only input.
//
// Pure (no DOM) so it is node-testable: a test feeds a fabricated schema and
// asserts the classification, which is what proves domain-blindness.

import type { JsonSchema } from "./types.js";

export type FormNode =
  // a free-text value (string, or any shape we don't specialise)
  | { kind: "string" }
  // a numeric value; `integer` picks the input step / validation
  | { kind: "number"; integer: boolean }
  // a boolean toggle
  | { kind: "boolean" }
  // an array of scalar strings, edited as a list / comma field
  | { kind: "string-array" }
  // an object with a FIXED set of known fields (e.g. notify, resilience)
  | { kind: "object"; fields: FormField[] }
  // an open-keyed map: the user adds/removes keys, each value of `value` shape
  // (e.g. bundles, bundles[*].agents, credentials)
  | { kind: "record"; value: FormNode };

export interface FormField {
  key: string;
  node: FormNode;
}

function typeOf(schema: JsonSchema): string | undefined {
  const t = schema.type;
  if (typeof t === "string") return t;
  // A union type (e.g. ["string","null"]) → the first non-null member.
  if (Array.isArray(t)) return t.find((x) => x !== "null");
  return undefined;
}

// Classify one schema node. Order matters: an object with `properties` is a
// fixed-field object; an object whose `additionalProperties` is a schema (not
// `false`) is an open-keyed record; a bare object falls back to free text.
export function classify(schema: JsonSchema): FormNode {
  const t = typeOf(schema);

  if (t === "object" || schema.properties !== undefined || isRecordSchema(schema)) {
    const props = schema.properties;
    if (props !== undefined && Object.keys(props).length > 0) {
      const fields: FormField[] = Object.entries(props).map(([key, sub]) => ({
        key,
        node: classify(sub),
      }));
      return { kind: "object", fields };
    }
    const add = schema.additionalProperties;
    if (add !== undefined && add !== false && typeof add === "object") {
      return { kind: "record", value: classify(add) };
    }
    // An object with neither known fields nor a value schema — edit as text.
    return { kind: "string" };
  }

  if (t === "array") {
    return { kind: "string-array" };
  }
  if (t === "integer") return { kind: "number", integer: true };
  if (t === "number") return { kind: "number", integer: false };
  if (t === "boolean") return { kind: "boolean" };
  return { kind: "string" };
}

function isRecordSchema(schema: JsonSchema): boolean {
  const add = schema.additionalProperties;
  return add !== undefined && add !== false && typeof add === "object";
}

// The top-level fields of the config document, in schema order. Convenience for
// the form (which renders the root object's fields directly).
export function rootFields(schema: JsonSchema): FormField[] {
  const node = classify(schema);
  return node.kind === "object" ? node.fields : [];
}

// Drop empty leaves so a PUT never sends `""` for a `min(1)` field or an empty
// object the schema would reject — an absent key is the canonical "unset". Pure
// (no DOM) so it is node-testable.
export function pruneEmpty(value: unknown): unknown {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    const arr = value.map(pruneEmpty).filter((x) => x !== undefined);
    return arr.length > 0 ? arr : undefined;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pruned = pruneEmpty(v);
      if (pruned !== undefined) out[k] = pruned;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}
