// Backend ↔ model compatibility. A compatible pair passes; an incompatible one
// is rejected at entry with a helpful suggestion; `auto`, a bare tier, and an
// unknown backend each behave as specified.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { knownBackends, parseModelRef, validatePair } from "../src/index.js";

describe("parseModelRef", () => {
  it("splits provider:model into family + model", () => {
    assert.deepEqual(parseModelRef("anthropic:claude-x"), { family: "anthropic", model: "claude-x" });
  });
  it("treats a bare value as a model with no family", () => {
    assert.deepEqual(parseModelRef("premiumish"), { model: "premiumish" });
  });
  it("does not split a dangling colon", () => {
    assert.deepEqual(parseModelRef("foo:"), { model: "foo:" });
  });
});

describe("validatePair", () => {
  it("accepts a compatible pair", () => {
    assert.equal(validatePair("claude-code", "anthropic:some-model").ok, true);
    assert.equal(validatePair("openrouter", "openrouter:deep").ok, true);
    assert.equal(validatePair("aider", "google:g-model").ok, true);
  });

  it("rejects an incompatible pair with a suggestion", () => {
    const r = validatePair("codex", "google:g-model");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /codex/);
    assert.match(r.message, /google/);
    // Suggests the backends that CAN run a google model.
    assert.match(r.message, /gemini|aider/);
  });

  it("accepts auto for any model (resolved at dispatch later)", () => {
    assert.equal(validatePair("auto", "google:g-model").ok, true);
    assert.equal(validatePair("auto", "anything").ok, true);
  });

  it("accepts a bare tier / concrete model (no family to check)", () => {
    assert.equal(validatePair("codex", "some-tier").ok, true);
  });

  it("rejects an unknown backend (typo guard)", () => {
    const r = validatePair("codecs", "anthropic:m");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.message, /unknown backend/);
  });

  it("knownBackends lists auto plus every table entry", () => {
    const backends = knownBackends();
    assert.ok(backends.includes("auto"));
    assert.ok(backends.includes("claude-code"));
    assert.ok(backends.includes("aider"));
  });
});
