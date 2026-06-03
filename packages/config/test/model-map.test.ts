// Model-map resolution + the leaf's genericity. The resolver is fed a
// FABRICATED roster whose bundle name, agent names, and tier names match NO real
// bundle — proving the leaf binds whatever roster it is handed and hardcodes
// none of it. (The end-to-end run against the real second bundle lives in the
// consumer's integration test.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bundleAgentMap,
  resolveBundleModels,
  resolveModelRef,
  type BundleRoster,
  type LoomConfig,
} from "../src/index.js";

describe("resolveModelRef", () => {
  const tiers = { cheap: "model-cheap", deep: "model-deep" };
  it("returns family + model for provider:model", () => {
    assert.deepEqual(resolveModelRef("openrouter:r1", tiers), { family: "openrouter", model: "r1" });
  });
  it("expands a bare tier via the roster's tier map", () => {
    assert.deepEqual(resolveModelRef("deep", tiers), { model: "model-deep" });
  });
  it("passes a bare concrete model (or unmapped tier) through unchanged", () => {
    assert.deepEqual(resolveModelRef("some-model", tiers), { model: "some-model" });
    assert.deepEqual(resolveModelRef("unknown-tier", tiers), { model: "unknown-tier" });
  });
});

describe("genericity — a fabricated, non-code roster resolves with zero hardcode", () => {
  // Names chosen to match neither the code bundle nor the spec bundle.
  const roster: BundleRoster = {
    name: "atlas",
    agents: [
      { name: "scout", default_model: "cheap" },
      { name: "oracle", default_model: "deep" },
    ],
    default_model_tiers: { cheap: "model-cheap", deep: "model-deep" },
    default_provider: "some-provider",
  };

  const config: LoomConfig = {
    bundles: {
      atlas: { agents: { scout: "deep", oracle: "openrouter:r1" } },
    },
  };

  it("reads the bundle's agent map by name", () => {
    assert.deepEqual(bundleAgentMap(config, "atlas"), { scout: "deep", oracle: "openrouter:r1" });
    assert.deepEqual(bundleAgentMap(config, "not-loaded"), {});
  });

  it("resolves each configured agent to a concrete model + family", () => {
    const resolved = resolveBundleModels(config, roster);
    assert.deepEqual(resolved["scout"], { model: "model-deep" }); // tier expanded via roster
    assert.deepEqual(resolved["oracle"], { family: "openrouter", model: "r1" });
  });

  it("omits agents the config does not mention (they keep bundle defaults)", () => {
    const partial: LoomConfig = { bundles: { atlas: { agents: { scout: "cheap" } } } };
    const resolved = resolveBundleModels(partial, roster);
    assert.ok("scout" in resolved);
    assert.ok(!("oracle" in resolved));
  });
});
