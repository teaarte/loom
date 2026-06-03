// Genericity acceptance — the config → model-map → routing path run against the
// REAL second (non-code) bundle.
//
// This is a release gate: the same code that binds the code bundle's roster to
// models must bind a DIFFERENT bundle's roster — different agent names, a
// different bundle name, no shared tier vocabulary — with zero code-bundle
// assumption. Here the control-layer model map is resolved for the `spec`
// bundle's roster, adapted into a kernel `ProvidersConfig` by the SAME
// `providersConfigFromModelMap` seam `loom run` uses, and fed to the real kernel
// router — proving the override reaches `resolveModel` for an agent the code
// bundle has never heard of.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import specBundle from "@loomfsm/bundle-spec";
import { resolveBundleModels, type BundleRoster, type LoomConfig } from "@loomfsm/config";
import { createProviderRouter, type LLMProvider, type PipelineState } from "@loomfsm/kernel";

import { providersConfigFromModelMap } from "../src/bootstrap.js";

// The router only reads `.name` to resolve a route's provider; a name-only stub
// is enough to exercise model resolution without a live backend.
const DEFAULT_PROVIDER = specBundle.default_provider ?? "claude-code-shuttle";
const stubProvider = { name: DEFAULT_PROVIDER } as unknown as LLMProvider;

// The router's resolveModel reads only `state.bundle_state`.
const noState = { bundle_state: null } as unknown as PipelineState;

describe("genericity — config model map resolves against the spec bundle", () => {
  const roster: BundleRoster = {
    name: specBundle.name,
    agents: specBundle.agents,
    ...(specBundle.default_provider !== undefined
      ? { default_provider: specBundle.default_provider }
      : {}),
    // The spec bundle declares NO default_model_tiers — a bare tier ref simply
    // passes through, which is the correct generic behavior.
  };

  // Names from the spec bundle's roster — `researcher`, `spec-writer` — not the
  // code bundle's. The config keys agents by THIS bundle's name.
  const config: LoomConfig = {
    bundles: {
      spec: {
        agents: {
          researcher: "anthropic:research-model",
          "spec-writer": "writer-model",
        },
      },
    },
  };

  it("adapts the resolved map into routing the kernel router honors", () => {
    const resolved = resolveBundleModels(config, roster);
    const pc = providersConfigFromModelMap(resolved, DEFAULT_PROVIDER);
    const router = createProviderRouter({ providers: [stubProvider], config: pc, bundle: specBundle });

    // Configured agents resolve to the overridden model verbatim.
    assert.equal(router.resolveModel?.("researcher", noState), "research-model");
    assert.equal(router.resolveModel?.("spec-writer", noState), "writer-model");
  });

  it("leaves an unconfigured spec agent to its bundle default (no route)", () => {
    const resolved = resolveBundleModels(config, roster);
    const pc = providersConfigFromModelMap(resolved, DEFAULT_PROVIDER);
    const router = createProviderRouter({ providers: [stubProvider], config: pc, bundle: specBundle });
    // `spec-reviewer` is in the roster but not the config — the router returns
    // null, so resolveSpawnModel would fall back to the bundle tier. The config
    // only overrides what it names; it hardcodes no agent.
    assert.equal(router.resolveModel?.("spec-reviewer", noState), null);
  });

  it("the config leaf needs no knowledge of the spec roster's names", () => {
    // An empty config produces no routing at all, for any bundle.
    const pc = providersConfigFromModelMap(resolveBundleModels({}, roster), DEFAULT_PROVIDER);
    assert.equal(Object.keys(pc).length, 0);
  });
});
