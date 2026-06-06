// resolveSpawnModel is the replay-critical model resolver both spawn paths
// call (the driver's fresh intents and the kernel's re-shuttle directive). It
// stays in the substrate, so its branch logic is exercised here against a
// HAND-BUILT registry — no build-time loader, no createProviderRouter. That
// keeps the kernel suite's coverage of it self-contained: the tick path needs
// no `@loomfsm/loader` to choose a model. (The router-composed integration —
// resolveSpawnModel reading a real createProviderRouter registry — lives with
// the router in the loader's own suite.)

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSpawnModel } from "../src/resolve-spawn-model.js";
import { buildVocabularies } from "../src/vocabularies.js";
import type { Bundle } from "../src/types/bundle.js";
import type { Agent } from "../src/types/plugins.js";
import type { PolicyName } from "../src/types/policy.js";
import type { ProviderRegistry, Registry } from "../src/types/registry.js";
import type { GateRole } from "../src/types/row-types.js";
import type { PipelineState } from "../src/types/state.js";

// resolveSpawnModel only forwards `state` to the registry's resolveModel; the
// stub below ignores it, so a minimal cast is enough for these unit cases.
const STATE = {} as PipelineState;

// A ProviderRegistry whose model resolution is fixed — stands in for the
// build-time router so this test never pulls it in.
function stubProviders(routedModel: string | null): ProviderRegistry {
  return {
    all: [],
    resolve() {
      throw new Error("resolve must not run in resolveSpawnModel tests");
    },
    resolveModel: () => routedModel,
    health_check_all: Promise.resolve([]),
  };
}

function fixtureRegistry(opts: {
  agents: Agent[];
  default_model_tiers?: Record<string, string>;
  routedModel?: string | null;
}): Registry {
  const bundle: Bundle = {
    name: "stub",
    version: "0.0.0",
    description: "resolve-spawn-model fixture",
    phases: ["p1"],
    default_flow: "default",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: opts.agents,
    stages: {},
    flows: { default: [] },
    hooks: [],
    invariants: [],
  };
  if (opts.default_model_tiers !== undefined) {
    bundle.default_model_tiers = opts.default_model_tiers;
  }
  return {
    bundle,
    agents: new Map(opts.agents.map((a) => [a.name, a])),
    stages: new Map(),
    flows: new Map(),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: stubProviders(opts.routedModel ?? null),
    policyFactories: new Map(),
    vocabularies: buildVocabularies(bundle),
  };
}

describe("resolveSpawnModel — router model > bundle tier > passthrough", () => {
  const agents: Agent[] = [
    { name: "c", template_path: "t.md", output_kind: "nonreview", default_model: "fast" },
    { name: "concrete", template_path: "t.md", output_kind: "nonreview", default_model: "opus" },
    { name: "untiered", template_path: "t.md", output_kind: "nonreview" },
  ];

  it("a routed model from the registry wins outright", () => {
    const reg = fixtureRegistry({
      agents,
      default_model_tiers: { fast: "haiku" },
      routedModel: "opus-routed",
    });
    assert.equal(resolveSpawnModel(reg, "c", "p1", STATE), "opus-routed");
  });

  it("falls to the bundle tier when the registry resolves no model", () => {
    const reg = fixtureRegistry({ agents, default_model_tiers: { fast: "haiku" }, routedModel: null });
    assert.equal(resolveSpawnModel(reg, "c", "p1", STATE), "haiku");
  });

  it("treats an empty routed model the same as no model", () => {
    const reg = fixtureRegistry({ agents, default_model_tiers: { fast: "haiku" }, routedModel: "" });
    assert.equal(resolveSpawnModel(reg, "c", "p1", STATE), "haiku");
  });

  it("passes a concrete/unknown bundle tier through unchanged", () => {
    const reg = fixtureRegistry({ agents, default_model_tiers: { fast: "haiku" }, routedModel: null });
    assert.equal(resolveSpawnModel(reg, "concrete", "p1", STATE), "opus");
  });

  it("falls back to 'default' when the agent has no tier and no mapping", () => {
    const reg = fixtureRegistry({ agents, routedModel: null });
    assert.equal(resolveSpawnModel(reg, "untiered", "p1", STATE), "default");
  });
});
