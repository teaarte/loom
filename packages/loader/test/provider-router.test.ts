import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProviderRouter } from "../src/index.js";
import type { ProvidersConfig } from "../src/index.js";
import {
  KernelError,
  buildVocabularies,
  resolveSpawnModel,
} from "@loomfsm/kernel";
import type {
  Agent,
  Bundle,
  GateRole,
  LLMProvider,
  PipelineState,
  PolicyName,
  Registry,
} from "@loomfsm/kernel";

function stubProvider(name: string): LLMProvider {
  return {
    name,
    capabilities: {
      execution: "shuttle",
      idempotent_spawn: true,
      reports_usage: false,
    },
    async spawn() {
      throw new Error(`stub provider '${name}' — spawn must not run in this test`);
    },
  };
}

function fixtureBundle(opts: { default_provider?: string } = {}): Bundle {
  const b: Bundle = {
    name: "stub",
    version: "0.0.0",
    description: "router test fixture",
    phases: ["p1", "p2"],
    default_flow: "default",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages: {},
    flows: { default: [] },
    hooks: [],
    invariants: [],
  };
  if (opts.default_provider !== undefined) b.default_provider = opts.default_provider;
  return b;
}

function fixtureState(bundle_state: Record<string, unknown> | null = null): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: null,
    driver_state_id: "d-router",
    project_dir: "/tmp/router",
    bundle: "stub",
    task: "router fixture",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    work_result: null,
    started_at: "2026-05-28T00:00:00.000Z" as PipelineState["started_at"],
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: {},
    bundle_state,
    pipeline_violation: null,
    force_used: false,
    agents_count: 0,
    gate_revisions: {} as Record<GateRole, number>,
    gate_auto_rejections: {} as Record<GateRole, number>,
    files_created: [],
    files_modified: [],
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens_cached: 0,
    driver: {
      flow_name: "default",
      step_index: 0,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now: "2026-05-28T00:00:00.000Z" as PipelineState["now"],
  };
}

function fixtureRegistry(opts: {
  agents: Agent[];
  default_model_tiers?: Record<string, string>;
  config?: ProvidersConfig;
}): Registry {
  const providers = [stubProvider("a"), stubProvider("b")];
  const bundle = fixtureBundle();
  bundle.agents = opts.agents;
  if (opts.default_model_tiers !== undefined) bundle.default_model_tiers = opts.default_model_tiers;
  return {
    bundle,
    agents: new Map(opts.agents.map((a) => [a.name, a])),
    stages: new Map(),
    flows: new Map(),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: createProviderRouter({ providers, bundle, config: opts.config ?? {} }),
    policyFactories: new Map(),
    vocabularies: buildVocabularies(bundle),
  };
}

describe("resolveSpawnModel — config override > bundle tier > passthrough", () => {
  const agents: Agent[] = [
    { name: "c", template_path: "t.md", output_kind: "nonreview", default_model: "fast" },
    { name: "concrete", template_path: "t.md", output_kind: "nonreview", default_model: "opus" },
    { name: "untiered", template_path: "t.md", output_kind: "nonreview" },
  ];

  it("maps an agent's bundle tier through default_model_tiers (zero config)", () => {
    const reg = fixtureRegistry({ agents, default_model_tiers: { fast: "haiku" } });
    assert.equal(resolveSpawnModel(reg, "c", "p1", fixtureState()), "haiku");
  });

  it("config routing overrides the bundle default", () => {
    const reg = fixtureRegistry({
      agents,
      default_model_tiers: { fast: "haiku" },
      config: {
        agent_routing: { c: { provider: "a", tier: "big" } },
        tier_aliases: { big: { model: "opus-cfg" } },
      },
    });
    assert.equal(resolveSpawnModel(reg, "c", "p1", fixtureState()), "opus-cfg");
  });

  it("passes a concrete/unknown model through unchanged", () => {
    const reg = fixtureRegistry({ agents, default_model_tiers: { fast: "haiku" } });
    assert.equal(resolveSpawnModel(reg, "concrete", "p1", fixtureState()), "opus");
  });

  it("falls back to 'default' when the agent has no tier and no mapping", () => {
    const reg = fixtureRegistry({ agents });
    assert.equal(resolveSpawnModel(reg, "untiered", "p1", fixtureState()), "default");
  });
});

describe("createProviderRouter — empty config falls back to MVP cascade", () => {
  it("returns bundle.default_provider when the config is empty", () => {
    const providers = [stubProvider("a"), stubProvider("b")];
    const bundle = fixtureBundle({ default_provider: "b" });
    const router = createProviderRouter({ providers, bundle, config: {} });

    const resolved = router.resolve("classifier", fixtureState());
    assert.equal(resolved.name, "b");
  });

  it("falls back to providers[0] when no config and no bundle default", () => {
    const providers = [stubProvider("first"), stubProvider("second")];
    const bundle = fixtureBundle();
    const router = createProviderRouter({ providers, bundle, config: {} });

    assert.equal(router.resolve("classifier", fixtureState()).name, "first");
  });

  it("throws PROVIDER_NOT_FOUND when no providers and no rules", () => {
    const router = createProviderRouter({
      providers: [],
      bundle: fixtureBundle(),
      config: {},
    });

    assert.throws(
      () => router.resolve("classifier", fixtureState()),
      (err: unknown) =>
        err instanceof KernelError && err.code === "PROVIDER_NOT_FOUND",
    );
  });
});

describe("createProviderRouter — cascade rungs", () => {
  it("agent_routing wins over phase_routing and default", () => {
    const providers = [stubProvider("sdk"), stubProvider("local")];
    const config: ProvidersConfig = {
      default_provider: "sdk",
      agent_routing: { reviewer: { provider: "local", tier: "fast" } },
      phase_routing: { p1: { provider: "sdk", tier: "premium" } },
      tier_aliases: {
        fast: { model: "claude-haiku-4-5-20251001" },
        premium: { model: "claude-opus-4-7" },
      },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    const resolved = router.resolve("reviewer", fixtureState(), "p1");
    assert.equal(resolved.name, "local");
    assert.equal(router.resolveModel?.("reviewer", fixtureState(), "p1"), "claude-haiku-4-5-20251001");
  });

  it("phase_routing applies when no agent_routing matches", () => {
    const providers = [stubProvider("sdk"), stubProvider("local")];
    const config: ProvidersConfig = {
      default_provider: "sdk",
      phase_routing: { validation: { provider: "local", tier: "local-tier" } },
      tier_aliases: { "local-tier": { model: "llama3.1:8b" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    const resolved = router.resolve("reviewer", fixtureState(), "validation");
    assert.equal(resolved.name, "local");
    assert.equal(router.resolveModel?.("reviewer", fixtureState(), "validation"), "llama3.1:8b");
  });

  it("default_provider + default_model_tier resolves when nothing matches", () => {
    const providers = [stubProvider("sdk"), stubProvider("local")];
    const config: ProvidersConfig = {
      default_provider: "sdk",
      default_model_tier: "premium",
      tier_aliases: { premium: { model: "claude-opus-4-7" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    assert.equal(router.resolve("classifier", fixtureState()).name, "sdk");
    assert.equal(router.resolveModel?.("classifier", fixtureState()), "claude-opus-4-7");
  });

  it("tier alias resolution returns the configured model name", () => {
    const providers = [stubProvider("sdk")];
    const config: ProvidersConfig = {
      agent_routing: { reviewer: { provider: "sdk", tier: "premium" } },
      tier_aliases: { premium: { model: "claude-opus-4-7" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    assert.equal(router.resolveModel?.("reviewer", fixtureState()), "claude-opus-4-7");
  });

  it("model_overrides[`${agent}@${phase}`] swaps the model on top of agent_routing", () => {
    const providers = [stubProvider("sdk")];
    const config: ProvidersConfig = {
      agent_routing: { classifier: { provider: "sdk", tier: "fast" } },
      tier_aliases: { fast: { model: "claude-haiku-4-5-20251001" } },
      model_overrides: { "classifier@planning": { model: "claude-sonnet-4-6" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    assert.equal(router.resolve("classifier", fixtureState(), "planning").name, "sdk");
    assert.equal(
      router.resolveModel?.("classifier", fixtureState(), "planning"),
      "claude-sonnet-4-6",
    );
  });
});

describe("createProviderRouter — stage-time override", () => {
  it("bundle_state.provider_override wins over agent_routing", () => {
    const providers = [stubProvider("sdk"), stubProvider("local")];
    const config: ProvidersConfig = {
      agent_routing: { reviewer: { provider: "sdk", tier: "premium" } },
      tier_aliases: { premium: { model: "claude-opus-4-7" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    const state = fixtureState({
      provider_override: { agent: "reviewer", provider: "local", model: "llama3.1:8b" },
    });
    assert.equal(router.resolve("reviewer", state).name, "local");
    assert.equal(router.resolveModel?.("reviewer", state), "llama3.1:8b");
  });

  it("override for a different agent is ignored", () => {
    const providers = [stubProvider("sdk"), stubProvider("local")];
    const config: ProvidersConfig = {
      agent_routing: { reviewer: { provider: "sdk", tier: "premium" } },
      tier_aliases: { premium: { model: "claude-opus-4-7" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    const state = fixtureState({
      provider_override: { agent: "classifier", provider: "local" },
    });
    assert.equal(router.resolve("reviewer", state).name, "sdk");
  });
});

describe("createProviderRouter — refusal codes", () => {
  it("PROVIDER_NOT_FOUND when route names an unregistered provider", () => {
    const providers = [stubProvider("sdk")];
    const config: ProvidersConfig = {
      agent_routing: { reviewer: { provider: "ghost", tier: "fast" } },
      tier_aliases: { fast: { model: "x" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    assert.throws(
      () => router.resolve("reviewer", fixtureState()),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "PROVIDER_NOT_FOUND" &&
        (err.detail as { provider?: string } | undefined)?.provider === "ghost",
    );
  });

  it("PROVIDER_TIER_UNKNOWN when route names an undeclared tier", () => {
    const providers = [stubProvider("sdk")];
    const config: ProvidersConfig = {
      agent_routing: { reviewer: { provider: "sdk", tier: "mystery" } },
      tier_aliases: { fast: { model: "x" } },
    };
    const router = createProviderRouter({ providers, bundle: fixtureBundle(), config });

    assert.throws(
      () => router.resolve("reviewer", fixtureState()),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "PROVIDER_TIER_UNKNOWN" &&
        (err.detail as { tier?: string } | undefined)?.tier === "mystery",
    );
  });

  it("PROVIDER_CONFIG_INVALID when agent_routing entry lacks provider field", () => {
    assert.throws(
      () =>
        createProviderRouter({
          providers: [stubProvider("sdk")],
          bundle: fixtureBundle(),
          config: {
            agent_routing: {
              reviewer: { tier: "fast" } as unknown as ProvidersConfig["agent_routing"] extends infer T
                ? T extends Record<string, infer V>
                  ? V
                  : never
                : never,
            },
          },
        }),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "PROVIDER_CONFIG_INVALID" &&
        (err.detail as { field?: string } | undefined)?.field === "agent_routing",
    );
  });

  it("PROVIDER_CONFIG_INVALID when tier_aliases value lacks model field", () => {
    assert.throws(
      () =>
        createProviderRouter({
          providers: [stubProvider("sdk")],
          bundle: fixtureBundle(),
          config: {
            tier_aliases: { fast: {} as unknown as { model: string } },
          },
        }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "PROVIDER_CONFIG_INVALID",
    );
  });

  it("PROVIDER_CONFIG_INVALID when default_provider is not a string", () => {
    assert.throws(
      () =>
        createProviderRouter({
          providers: [stubProvider("sdk")],
          bundle: fixtureBundle(),
          config: {
            default_provider: 42 as unknown as string,
          },
        }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "PROVIDER_CONFIG_INVALID",
    );
  });
});

describe("createProviderRouter — model resolution edge cases", () => {
  it("resolveModel returns null when no tier and no override are configured", () => {
    const providers = [stubProvider("sdk")];
    const router = createProviderRouter({
      providers,
      bundle: fixtureBundle({ default_provider: "sdk" }),
      config: {},
    });
    assert.equal(router.resolveModel?.("classifier", fixtureState()), null);
  });

  it("resolveModel returns the override model even with no tier alias declared", () => {
    const providers = [stubProvider("sdk")];
    const router = createProviderRouter({
      providers,
      bundle: fixtureBundle(),
      config: {},
    });
    const state = fixtureState({
      provider_override: { agent: "x", provider: "sdk", model: "custom-model" },
    });
    assert.equal(router.resolveModel?.("x", state), "custom-model");
  });
});
