// The schema→form-model classifier — the genericity core of the config form. It
// reads schema STRUCTURE, never field names, so it must classify a fabricated
// schema (a hypothetical bundle's config, different record keys) exactly as it
// classifies the real one. That domain-blindness IS the release gate: the form
// works on a 2nd, non-code bundle with zero hardcoding.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pruneEmpty, rootFields, type FormNode } from "../src/lib/schemaForm.js";
import type { JsonSchema } from "../src/lib/types.js";

// The shape `GET /config/schema` emits (derived from the Zod config schema):
// scalars, fixed-field objects, open-keyed records, an array.
const CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    backend: { type: "string", minLength: 1 },
    bundles: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          agents: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
        },
      },
    },
    notify: {
      type: "object",
      properties: {
        webhook_url: { type: "string" },
        events: { type: "array", items: { type: "string" } },
        timeout_ms: { type: "integer", minimum: 0 },
      },
    },
    credentials: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { key_ref: { type: "string" }, base_url_ref: { type: "string" } },
      },
    },
  },
};

function fieldNode(fields: { key: string; node: FormNode }[], key: string): FormNode {
  const f = fields.find((x) => x.key === key);
  assert.ok(f, `expected a field '${key}'`);
  return f.node;
}

describe("classify (config schema)", () => {
  const fields = rootFields(CONFIG_SCHEMA);

  it("classifies a scalar string", () => {
    assert.deepEqual(fieldNode(fields, "backend"), { kind: "string" });
  });

  it("classifies an open-keyed record (bundles) as a record of objects", () => {
    const bundles = fieldNode(fields, "bundles");
    assert.equal(bundles.kind, "record");
    if (bundles.kind === "record") {
      assert.equal(bundles.value.kind, "object");
      if (bundles.value.kind === "object") {
        // a nested record of strings (agents) — proves recursion, no name baked in
        assert.deepEqual(bundles.value.fields, [{ key: "agents", node: { kind: "record", value: { kind: "string" } } }]);
      }
    }
  });

  it("classifies a fixed-field object (notify) with an array + integer leaf", () => {
    const notify = fieldNode(fields, "notify");
    assert.equal(notify.kind, "object");
    if (notify.kind === "object") {
      assert.deepEqual(fieldNode(notify.fields, "webhook_url"), { kind: "string" });
      assert.deepEqual(fieldNode(notify.fields, "events"), { kind: "string-array" });
      assert.deepEqual(fieldNode(notify.fields, "timeout_ms"), { kind: "number", integer: true });
    }
  });

  it("classifies credentials as a record of fixed objects", () => {
    const creds = fieldNode(fields, "credentials");
    assert.equal(creds.kind, "record");
    if (creds.kind === "record") assert.equal(creds.value.kind, "object");
  });
});

describe("classify (genericity — a fabricated bundle's schema)", () => {
  // A completely different config schema: different record key names, a boolean,
  // a number. The classifier must produce the SAME structural kinds, naming
  // nothing — this is what proves the form is domain-blind.
  const FABRICATED: JsonSchema = {
    type: "object",
    properties: {
      widgets: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: { knobs: { type: "object", additionalProperties: { type: "number" } } },
        },
      },
      enabled: { type: "boolean" },
      threshold: { type: "number" },
    },
  };
  const fields = rootFields(FABRICATED);

  it("classifies the unknown record exactly like the real one", () => {
    const widgets = fieldNode(fields, "widgets");
    assert.equal(widgets.kind, "record");
    if (widgets.kind === "record") {
      assert.equal(widgets.value.kind, "object");
      if (widgets.value.kind === "object") {
        assert.deepEqual(widgets.value.fields, [
          { key: "knobs", node: { kind: "record", value: { kind: "number", integer: false } } },
        ]);
      }
    }
  });

  it("classifies a boolean + number", () => {
    assert.deepEqual(fieldNode(fields, "enabled"), { kind: "boolean" });
    assert.deepEqual(fieldNode(fields, "threshold"), { kind: "number", integer: false });
  });
});

describe("pruneEmpty", () => {
  it("drops empty strings, arrays, and objects", () => {
    assert.equal(pruneEmpty(""), undefined);
    assert.equal(pruneEmpty([]), undefined);
    assert.equal(pruneEmpty({}), undefined);
    assert.equal(pruneEmpty({ a: "" }), undefined);
  });
  it("keeps non-empty leaves and collapses partially-empty objects", () => {
    assert.deepEqual(pruneEmpty({ a: "x", b: "", c: { d: "" } }), { a: "x" });
    assert.deepEqual(pruneEmpty({ backend: "auto", bundles: { code: { agents: {} } } }), { backend: "auto" });
  });
  it("preserves numbers and booleans (including 0 / false)", () => {
    assert.deepEqual(pruneEmpty({ n: 0, b: false }), { n: 0, b: false });
  });
});
