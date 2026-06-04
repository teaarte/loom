// The client-side `(backend, model)` compatibility mirror. It is driven by the
// `/providers` roster as DATA — so it stays correct on a fabricated roster and
// hardcodes no backend / family name. Mirrors the server gate it pre-empts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseFamily, validateModelRef } from "../src/lib/validatePair.js";
import type { ProviderInfo } from "../src/lib/types.js";

// A fabricated roster — intentionally NOT the real backend names — to prove the
// mirror reads providers as data.
const PROVIDERS: ProviderInfo[] = [
  { backend: "alpha", families: ["red"], available: true },
  { backend: "beta", families: ["red", "blue"], available: null },
  { backend: "gamma", families: ["green"], available: false, reason: "no key" },
];

describe("parseFamily", () => {
  it("extracts the family before the first colon", () => {
    assert.equal(parseFamily("red:model-x"), "red");
  });
  it("returns undefined for a bare value (a tier / concrete model)", () => {
    assert.equal(parseFamily("premium"), undefined);
    assert.equal(parseFamily(":x"), undefined);
    assert.equal(parseFamily("x:"), undefined);
  });
});

describe("validateModelRef", () => {
  it("accepts anything when the backend mode is auto", () => {
    assert.deepEqual(validateModelRef("auto", PROVIDERS, "green:foo"), { ok: true });
  });

  it("accepts a bare ref (family resolves within the backend)", () => {
    assert.deepEqual(validateModelRef("alpha", PROVIDERS, "premium"), { ok: true });
  });

  it("accepts a compatible pair", () => {
    assert.deepEqual(validateModelRef("beta", PROVIDERS, "blue:m"), { ok: true });
  });

  it("rejects an incompatible pair and suggests a backend that can run it", () => {
    const r = validateModelRef("alpha", PROVIDERS, "green:m");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /can't run a green model/);
      assert.match(r.message, /use gamma/);
    }
  });

  it("rejects an unknown backend (typo guard)", () => {
    const r = validateModelRef("delta", PROVIDERS, "red:m");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /unknown backend 'delta'/);
  });
});
