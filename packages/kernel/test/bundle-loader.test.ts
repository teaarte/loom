import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { topoSortHooks } from "../src/hook-topo.js";
import {
  KernelError,
  captureNow,
  closeDb,
  openDb,
} from "../src/state.js";
import { buildVocabularies } from "../src/vocabularies.js";
import {
  loadBundle,
  reconcileExtensions,
} from "../src/index.js";
import type {
  DiscoveredManifest,
  ExtensionManifest,
} from "../src/index.js";
import type { Bundle } from "../src/types/bundle.js";
import type { Invariant } from "../src/types/invariants.js";
import type { NowToken } from "../src/types/now.js";
import type {
  Agent,
  Hook,
  Stage,
  StepStage,
} from "../src/types/plugins.js";
import type {
  GatePolicyResolver,
  PolicyName,
} from "../src/types/policy.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { GateRole } from "../src/types/row-types.js";
import type { PipelineState } from "../src/types/state.js";

// ============================================================================
// Fixtures
// ============================================================================

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-bundle-loader-"));
}

function cleanup(projectDir: string): void {
  try { closeDb(projectDir); } catch { /* may have already closed */ }
  rmSync(projectDir, { recursive: true, force: true });
}

function stubProvider(name = "stub"): LLMProvider {
  return {
    name,
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() { throw new Error("stub — spawn must not run in loader tests"); },
  };
}

function makeManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return {
    manifest_version: "1.0",
    name: "code",
    display_name: "Code pipeline",
    description: "Code task workflows.",
    version: "3.0.0",
    kind: "bundle",
    publisher: "@loom",
    capabilities: ["state.read"],
    requires: { kernel_api: "^3.0" },
    ...overrides,
  };
}

function asDiscovered(raw: unknown, path = "/fixture/manifest.json"): DiscoveredManifest {
  return { path, raw };
}

async function installManifest(
  projectDir: string,
  m: ExtensionManifest,
  now: NowToken,
): Promise<void> {
  await reconcileExtensions({
    manifests: [asDiscovered(m)],
    project_dir: projectDir,
    now,
  });
}

function noopAgent(name: string): Agent {
  return { name, template_path: `agents/${name}.md`, output_kind: "nonreview" };
}

function spawnStage(name: string, agent: string, phase = "p1"): Stage {
  return { kind: "spawn", name, phase, agent };
}

function stepStage(opts: {
  name: string;
  phase?: string;
  position?: "positional" | "event";
  effects?: StepStage["effects"];
}): Stage {
  return {
    kind: "step",
    name: opts.name,
    phase: opts.phase ?? "p1",
    position: opts.position ?? "positional",
    effects: opts.effects ?? [],
  };
}

function noopInvariant(name: string): Invariant {
  const fn = function (): null { return null; } as unknown as Invariant;
  Object.defineProperty(fn, "name", { value: name });
  return Object.assign(fn, { reads: [] as readonly string[] }) as Invariant;
}

function noopHook(name: string, requires?: string[]): Hook {
  const h: Hook = {
    name,
    event: "after-spawn",
    async run() { /* noop */ },
  };
  if (requires !== undefined) h.requires = requires;
  return h;
}

interface BundleOverrides {
  name?: string;
  agents?: Agent[];
  stages?: Record<string, Stage>;
  flows?: Record<string, string[]>;
  default_flow?: string;
  hooks?: Hook[];
  invariants?: Invariant[];
  phases?: string[];
  gate_roles?: Record<string, GateRole>;
  default_gate_policies?: Partial<Record<GateRole, PolicyName>>;
  policyResolver?: GatePolicyResolver;
  extends_vocab?: Bundle["extends_vocab"] & Record<string, unknown>;
}

function makeBundle(o: BundleOverrides = {}): Bundle {
  return {
    name: o.name ?? "code",
    version: "3.0.0",
    description: "fixture",
    phases: o.phases ?? ["p1"],
    default_flow: o.default_flow ?? "default",
    default_gate_policies: (o.default_gate_policies ?? {}) as Record<GateRole, PolicyName>,
    ...(o.policyResolver !== undefined ? { policyResolver: o.policyResolver } : {}),
    agents: o.agents ?? [],
    stages: o.stages ?? {},
    flows: o.flows ?? { default: [] },
    hooks: o.hooks ?? [],
    invariants: o.invariants ?? [],
    gate_roles: o.gate_roles ?? {},
    ...(o.extends_vocab !== undefined ? { extends_vocab: o.extends_vocab } : {}),
  };
}

// ============================================================================
// happy path
// ============================================================================

describe("loadBundle — happy path", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("returns a Registry with all maps populated from a valid bundle", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      agents: [noopAgent("classifier"), noopAgent("planner")],
      stages: {
        "init": stepStage({ name: "init" }),
        "classify": spawnStage("classify", "classifier"),
        "plan": spawnStage("plan", "planner"),
      },
      flows: { default: ["init", "classify", "plan"] },
    });

    const registry = await loadBundle({
      bundle,
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });

    assert.equal(registry.agents.size, 2);
    assert.ok(registry.agents.has("classifier"));
    assert.ok(registry.agents.has("planner"));
    assert.equal(registry.stages.size, 3);
    assert.equal(registry.flows.size, 1);
    assert.deepEqual(registry.flows.get("default"), ["init", "classify", "plan"]);
    assert.equal(registry.hooks.length, 0);
    assert.equal(registry.invariants.length, 0);
    assert.equal(registry.mcp_clients.size, 0);
    assert.equal(registry.providers.all.length, 1);
  });

  it("populates Registry.vocabularies with kernel defaults + bundle extends_vocab", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      extends_vocab: {
        error_classes: ["impl-blockers", "code-impl-blocker"],
        audit_types: ["bundle-emitted-event"],
      },
    });

    const registry = await loadBundle({
      bundle,
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });

    assert.ok(registry.vocabularies.error_classes.has("hook-failure"));
    assert.ok(registry.vocabularies.error_classes.has("impl-blockers"));
    assert.ok(registry.vocabularies.audit_types.has("extension-installed"));
    assert.ok(registry.vocabularies.audit_types.has("bundle-emitted-event"));
    assert.ok(registry.vocabularies.gate_roles.has("classify"));
  });

  it("populates Registry.policyFactories with kernel stock + bundle-registered", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const customFactory = () => async () => ({ type: "human-required" as const, reason: "fixture" });
    const bundle: Bundle = {
      ...makeBundle(),
      policy_factories: { "custom-rule": customFactory } as unknown as Record<PolicyName, () => import("../src/types/policy.js").Policy>,
    };

    const registry = await loadBundle({
      bundle,
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });

    assert.ok(registry.policyFactories.has("human"));
    assert.ok(registry.policyFactories.has("on-blockers"));
    assert.ok(registry.policyFactories.has("auto"));
    assert.ok(registry.policyFactories.has("custom-rule"));
  });
});

// ============================================================================
// providers_config — per-agent / per-phase provider + model routing
// ============================================================================

describe("loadBundle — providers_config routing", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  const anyState = {} as unknown as PipelineState;

  it("routes a per-agent provider + tier model; an unrouted agent falls to the default", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      agents: [noopAgent("classifier"), noopAgent("reviewer")],
      stages: {
        classify: spawnStage("classify", "classifier"),
        review: spawnStage("review", "reviewer"),
      },
      flows: { default: ["classify", "review"] },
    });

    const registry = await loadBundle({
      bundle,
      project_dir: projectDir,
      providers: [stubProvider("fast"), stubProvider("deep")],
      providers_config: {
        agent_routing: { reviewer: { provider: "deep", tier: "big" } },
        tier_aliases: { big: { model: "deep-xl" } },
        default_provider: "fast",
      },
      now,
    });

    // reviewer → routed provider + the tier's model.
    assert.equal(registry.providers.resolve("reviewer", anyState).name, "deep");
    assert.equal(registry.providers.resolveModel?.("reviewer", anyState), "deep-xl");
    // classifier → default_provider, no tier → null model (spawn falls back
    // to the agent default).
    assert.equal(registry.providers.resolve("classifier", anyState).name, "fast");
    assert.equal(registry.providers.resolveModel?.("classifier", anyState), null);
  });

  it("with no providers_config, every agent resolves to providers[0] (unchanged)", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const registry = await loadBundle({
      bundle: makeBundle({ agents: [noopAgent("classifier")] }),
      project_dir: projectDir,
      providers: [stubProvider("only")],
      now,
    });

    assert.equal(registry.providers.resolve("classifier", anyState).name, "only");
    assert.equal(registry.providers.resolveModel?.("classifier", anyState), null);
  });

  it("a route to an unregistered provider is refused when that agent resolves", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const registry = await loadBundle({
      bundle: makeBundle({ agents: [noopAgent("classifier")] }),
      project_dir: projectDir,
      providers: [stubProvider("only")],
      providers_config: {
        agent_routing: { classifier: { provider: "ghost", tier: "t" } },
        tier_aliases: { t: { model: "m" } },
      },
      now,
    });

    assert.throws(
      () => registry.providers.resolve("classifier", anyState),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "PROVIDER_NOT_FOUND");
        return true;
      },
    );
  });
});

// ============================================================================
// BUNDLE_NOT_INSTALLED
// ============================================================================

describe("loadBundle — BUNDLE_NOT_INSTALLED", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses when no installed_extensions row exists", async () => {
    const now = captureNow();
    // Open the DB so migrations land but skip reconcile — the row should not exist.
    openDb(projectDir);

    await assert.rejects(
      loadBundle({
        bundle: makeBundle(),
        project_dir: projectDir,
        providers: [stubProvider()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "BUNDLE_NOT_INSTALLED");
        const detail = (err as KernelError).detail;
        assert.ok(detail !== undefined);
        assert.equal(detail["expected_id"], "bundle:code");
        assert.equal(detail["actual_status"], null);
        return true;
      },
    );
  });

  it("refuses when installed row exists with status='failed'", async () => {
    const now = captureNow();
    // Reconcile a manifest with a bad publisher → lands as status='failed'.
    await reconcileExtensions({
      manifests: [asDiscovered(makeManifest({ publisher: "rogue-vendor" }))],
      project_dir: projectDir,
      now,
    });

    await assert.rejects(
      loadBundle({
        bundle: makeBundle(),
        project_dir: projectDir,
        providers: [stubProvider()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "BUNDLE_NOT_INSTALLED");
        const detail = (err as KernelError).detail;
        assert.equal(detail?.["actual_status"], "failed");
        return true;
      },
    );
  });

  it("refuses when installed row exists with status='disabled' (removal sweep)", async () => {
    const now = captureNow();
    // First reconcile lands the row enabled, second reconcile with empty list
    // sweeps it to disabled — exercising the manifest-layer removal path.
    await installManifest(projectDir, makeManifest(), now);
    await reconcileExtensions({ manifests: [], project_dir: projectDir, now });

    await assert.rejects(
      loadBundle({
        bundle: makeBundle(),
        project_dir: projectDir,
        providers: [stubProvider()],
        now,
      }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_NOT_INSTALLED");
        const detail = (err as KernelError).detail;
        assert.equal(detail?.["actual_status"], "disabled");
        return true;
      },
    );
  });
});

// ============================================================================
// BUNDLE_STAGE_NAME_MISMATCH
// ============================================================================

describe("loadBundle — BUNDLE_STAGE_NAME_MISMATCH", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses when stages map key disagrees with Stage.name", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      stages: {
        "foo": { kind: "step", name: "bar", phase: "p1", position: "positional", effects: [] },
      },
      flows: { default: [] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_STAGE_NAME_MISMATCH");
        const detail = (err as KernelError).detail;
        assert.equal(detail?.["key"], "foo");
        assert.equal(detail?.["name"], "bar");
        return true;
      },
    );
  });
});

// ============================================================================
// BUNDLE_AGENT_UNKNOWN
// ============================================================================

describe("loadBundle — BUNDLE_AGENT_UNKNOWN", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses a SpawnStage that references a missing agent", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      stages: { "classify": spawnStage("classify", "ghost") },
      flows: { default: ["classify"] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_AGENT_UNKNOWN");
        assert.equal((err as KernelError).detail?.["agent"], "ghost");
        return true;
      },
    );
  });

  it("refuses a FanoutStage whose agents[] has one missing entry", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      agents: [noopAgent("real")],
      stages: {
        "review": { kind: "fanout", name: "review", phase: "p1", agents: ["real", "ghost"] },
      },
      flows: { default: ["review"] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_AGENT_UNKNOWN");
        assert.equal((err as KernelError).detail?.["agent"], "ghost");
        return true;
      },
    );
  });
});

// ============================================================================
// BUNDLE_FLOW_UNKNOWN_STAGE
// ============================================================================

describe("loadBundle — BUNDLE_FLOW_UNKNOWN_STAGE", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses a flow entry that does not exist in stages", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      stages: { "init": stepStage({ name: "init" }) },
      flows: { default: ["init", "missing-step"] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_FLOW_UNKNOWN_STAGE");
        assert.equal((err as KernelError).detail?.["missing_stage"], "missing-step");
        return true;
      },
    );
  });

  it("refuses a default_flow that is not a registered flow", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      default_flow: "ghost-flow",
      flows: { default: [] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_FLOW_UNKNOWN_STAGE");
        assert.equal((err as KernelError).detail?.["default_flow"], "ghost-flow");
        return true;
      },
    );
  });
});

// ============================================================================
// BUNDLE_PHASE_UNKNOWN
// ============================================================================

describe("loadBundle — BUNDLE_PHASE_UNKNOWN", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses a SpawnStage whose phase is not in bundle.phases", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      phases: ["p1"],
      agents: [noopAgent("classifier")],
      stages: {
        "classify": { kind: "spawn", name: "classify", phase: "p9-not-real", agent: "classifier" },
      },
      flows: { default: ["classify"] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_PHASE_UNKNOWN");
        assert.equal((err as KernelError).detail?.["phase"], "p9-not-real");
        return true;
      },
    );
  });
});

// ============================================================================
// GATE_ROLE_UNKNOWN
// ============================================================================

describe("loadBundle — GATE_ROLE_UNKNOWN", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses a GateStage with no entry in bundle.gate_roles", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      stages: {
        "gate-plan": {
          kind: "gate",
          name: "gate-plan",
          phase: "p1",
          message: () => "msg",
          valid_answers: () => ({
            options: [
              { verbs: ["approve"], label: "Approve", produces: { decision: "accept" } },
            ],
          }),
        },
      },
      flows: { default: ["gate-plan"] },
      gate_roles: {},
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "GATE_ROLE_UNKNOWN");
        assert.equal((err as KernelError).detail?.["gate"], "gate-plan");
        return true;
      },
    );
  });

  it("refuses a gate_roles entry that names an unknown role", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      stages: {
        "gate-x": {
          kind: "gate",
          name: "gate-x",
          phase: "p1",
          message: () => "msg",
          valid_answers: () => ({
            options: [
              { verbs: ["approve"], label: "Approve", produces: { decision: "accept" } },
            ],
          }),
        },
      },
      flows: { default: ["gate-x"] },
      gate_roles: { "gate-x": "rogue-role" as GateRole },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "GATE_ROLE_UNKNOWN");
        assert.equal((err as KernelError).detail?.["role"], "rogue-role");
        return true;
      },
    );
  });
});

// ============================================================================
// STEP_EFFECT_COLLISION
// ============================================================================

describe("loadBundle — STEP_EFFECT_COLLISION", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses two StepStages declaring the same audit.emit effect", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      stages: {
        "a": stepStage({ name: "a", effects: [{ kind: "audit.emit", type: "shared" }] }),
        "b": stepStage({ name: "b", effects: [{ kind: "audit.emit", type: "shared" }] }),
      },
      flows: { default: ["a", "b"] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "STEP_EFFECT_COLLISION");
        const detail = (err as KernelError).detail;
        assert.equal(detail?.["effect"], "audit.emit:shared");
        return true;
      },
    );
  });
});

// ============================================================================
// HOOK_CYCLE
// ============================================================================

describe("loadBundle — HOOK_CYCLE", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses bundles whose hooks form a dependency cycle", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest({ capabilities: ["state.read", "hook.side_effect"] }), now);

    const bundle = makeBundle({
      hooks: [noopHook("A", ["B"]), noopHook("B", ["A"])],
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "HOOK_CYCLE");
        const cycle = (err as KernelError).detail?.["cycle"] as string[];
        assert.deepEqual(new Set(cycle), new Set(["A", "B"]));
        return true;
      },
    );
  });
});

// ============================================================================
// AUTO_POLICY_INCOMPLETE
// ============================================================================

describe("loadBundle — AUTO_POLICY_INCOMPLETE", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("lists 'policyResolver' when auto is set but resolver is missing", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest({ capabilities: ["state.read", "invariant.bundle"] }), now);

    const bundle = makeBundle({
      default_gate_policies: { final: "auto" } as Record<GateRole, PolicyName>,
      invariants: [noopInvariant("INV_safety_floor_final")],
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "AUTO_POLICY_INCOMPLETE");
        const missing = (err as KernelError).detail?.["missing"] as string[];
        assert.deepEqual(missing, ["policyResolver"]);
        return true;
      },
    );
  });

  it("lists 'safety_floor_invariant' when auto is set but the matching invariant is missing", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const resolver: GatePolicyResolver = async () => ({ type: "auto-approve", reason: "fixture" });
    const bundle = makeBundle({
      default_gate_policies: { final: "auto" } as Record<GateRole, PolicyName>,
      policyResolver: resolver,
      invariants: [],
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "AUTO_POLICY_INCOMPLETE");
        const missing = (err as KernelError).detail?.["missing"] as string[];
        assert.deepEqual(missing, ["safety_floor_invariant"]);
        assert.equal((err as KernelError).detail?.["expected_invariant"], "INV_safety_floor_final");
        return true;
      },
    );
  });

  it("lists both pieces when auto is set and resolver + invariant are missing", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      default_gate_policies: { plan: "auto" } as Record<GateRole, PolicyName>,
      invariants: [],
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "AUTO_POLICY_INCOMPLETE");
        const missing = (err as KernelError).detail?.["missing"] as string[];
        assert.deepEqual(missing, ["policyResolver", "safety_floor_invariant"]);
        return true;
      },
    );
  });
});

// ============================================================================
// VOCAB_SUNSET_CONTRADICTION
// ============================================================================

describe("loadBundle — VOCAB_SUNSET_CONTRADICTION", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses a value that appears in both extends_vocab.<kind> and sunset", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      extends_vocab: {
        error_classes: ["impl-blockers"],
        sunset: [{ kind: "error_classes", value: "impl-blockers", retired_at: "2026-05-01" }],
      } as unknown as Bundle["extends_vocab"] & Record<string, unknown>,
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "VOCAB_SUNSET_CONTRADICTION");
        assert.equal((err as KernelError).detail?.["value"], "impl-blockers");
        return true;
      },
    );
  });
});

// ============================================================================
// MANIFEST_CAPABILITY_MISSING
// ============================================================================

describe("loadBundle — MANIFEST_CAPABILITY_MISSING", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses an event-position StepStage without 'stage.event' capability", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest({ capabilities: ["state.read"] }), now);

    const bundle = makeBundle({
      stages: {
        "on-spawn": stepStage({ name: "on-spawn", position: "event" }),
      },
      flows: { default: [] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "MANIFEST_CAPABILITY_MISSING");
        assert.equal((err as KernelError).detail?.["capability"], "stage.event");
        return true;
      },
    );
  });

  it("refuses a registered Hook when manifest omits 'hook.side_effect'", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest({ capabilities: ["state.read"] }), now);

    const bundle = makeBundle({ hooks: [noopHook("logger")] });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "MANIFEST_CAPABILITY_MISSING");
        assert.equal((err as KernelError).detail?.["capability"], "hook.side_effect");
        return true;
      },
    );
  });

  it("refuses registered Invariants when manifest omits 'invariant.bundle'", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest({ capabilities: ["state.read"] }), now);

    const bundle = makeBundle({ invariants: [noopInvariant("INV_example")] });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "MANIFEST_CAPABILITY_MISSING");
        assert.equal((err as KernelError).detail?.["capability"], "invariant.bundle");
        return true;
      },
    );
  });

  it("refuses a bundle dir containing migrations/ when manifest omits 'migration.bundle'", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest({ capabilities: ["state.read"] }), now);

    const bundleDir = mkdtempSync(join(tmpdir(), "loom-bundle-src-"));
    try {
      mkdirSync(join(bundleDir, "migrations"));
      writeFileSync(join(bundleDir, "migrations", "001-init.sql"), "-- noop");

      await assert.rejects(
        loadBundle({
          bundle: makeBundle(),
          bundle_source_dir: bundleDir,
          project_dir: projectDir,
          providers: [stubProvider()],
          now,
        }),
        (err: unknown) => {
          assert.equal((err as KernelError).code, "MANIFEST_CAPABILITY_MISSING");
          assert.equal((err as KernelError).detail?.["capability"], "migration.bundle");
          return true;
        },
      );
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// BUNDLE_IMPORT_SCOPE_VIOLATION
// ============================================================================

describe("loadBundle — BUNDLE_IMPORT_SCOPE_VIOLATION", () => {
  let projectDir: string;
  let bundleDir: string;
  beforeEach(() => {
    projectDir = freshProject();
    bundleDir = mkdtempSync(join(tmpdir(), "loom-bundle-src-"));
  });
  afterEach(() => {
    cleanup(projectDir);
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it("refuses a bundle source file importing the raw kernel Transaction type", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    writeFileSync(
      join(bundleDir, "stages.ts"),
      `import type { Transaction } from "@loomfsm/kernel";\nexport const x = 1;\n`,
    );

    await assert.rejects(
      loadBundle({
        bundle: makeBundle(),
        bundle_source_dir: bundleDir,
        project_dir: projectDir,
        providers: [stubProvider()],
        now,
      }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_IMPORT_SCOPE_VIOLATION");
        const violations = (err as KernelError).detail?.["violations"] as { path: string; line: number }[];
        assert.ok(violations.length >= 1);
        assert.ok(violations[0]?.path.endsWith("stages.ts"));
        assert.equal(violations[0]?.line, 1);
        return true;
      },
    );
  });
});

// ============================================================================
// topoSortHooks (the soft-API form lives in src/hook-topo.ts)
// ============================================================================

describe("topoSortHooks — tagged-union form", () => {
  it("returns {sorted} on a clean DAG with stable input-order tie-break", () => {
    const a = noopHook("A");
    const b = noopHook("B", ["A"]);
    const c = noopHook("C", ["A"]);
    const r = topoSortHooks([a, b, c]);
    assert.ok("sorted" in r);
    assert.deepEqual(("sorted" in r ? r.sorted : []).map((h) => h.name), ["A", "B", "C"]);
  });

  it("returns {cycle} listing residual vertices on a cyclic graph", () => {
    const a = noopHook("A", ["B"]);
    const b = noopHook("B", ["A"]);
    const r = topoSortHooks([a, b]);
    assert.ok("cycle" in r);
    assert.deepEqual(
      new Set("cycle" in r ? r.cycle : []),
      new Set(["A", "B"]),
    );
  });
});

// ============================================================================
// buildVocabularies — direct (not via loadBundle)
// ============================================================================

describe("buildVocabularies — merge behavior", () => {
  it("merges kernel defaults with bundle.extends_vocab.<kind>", () => {
    const bundle = makeBundle({
      extends_vocab: {
        audit_types: ["custom-audit"],
        error_classes: ["custom-error"],
        gate_roles_extra: ["custom-role" as GateRole],
      },
    });
    const v = buildVocabularies(bundle);
    assert.ok(v.audit_types.kernel_defaults.has("extension-installed"));
    assert.ok(v.audit_types.bundle_extensions.has("custom-audit"));
    assert.ok(v.audit_types.has("custom-audit"));
    assert.ok(v.error_classes.has("custom-error"));
    assert.ok(v.gate_roles.has("classify"));
    assert.ok(v.gate_roles.has("custom-role"));
  });
});

// ============================================================================
// Cascade order — first-failure-wins discipline
// ============================================================================

describe("loadBundle — cascade order", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("surfaces BUNDLE_NOT_INSTALLED before any stage-shape refusal", async () => {
    const now = captureNow();
    // No manifest installed. The bundle ALSO has a stage-name mismatch
    // that would refuse downstream; cascade discipline says
    // BUNDLE_NOT_INSTALLED wins because the installed_extensions read
    // happens first.
    openDb(projectDir);

    const bundle = makeBundle({
      stages: {
        "foo": { kind: "step", name: "bar", phase: "p1", position: "positional", effects: [] },
      },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_NOT_INSTALLED");
        return true;
      },
    );
  });

  it("surfaces BUNDLE_AGENT_UNKNOWN before HOOK_CYCLE", async () => {
    const now = captureNow();
    await installManifest(
      projectDir,
      makeManifest({ capabilities: ["state.read", "hook.side_effect"] }),
      now,
    );

    // Both faults present: spawn references a missing agent AND hooks form a
    // cycle. Stage-shape validation runs before hook DAG, so the agent
    // refusal must surface.
    const bundle = makeBundle({
      stages: { "classify": spawnStage("classify", "ghost") },
      flows: { default: ["classify"] },
      hooks: [noopHook("A", ["B"]), noopHook("B", ["A"])],
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_AGENT_UNKNOWN");
        return true;
      },
    );
  });

  it("surfaces HOOK_CYCLE before AUTO_POLICY_INCOMPLETE", async () => {
    const now = captureNow();
    await installManifest(
      projectDir,
      makeManifest({ capabilities: ["state.read", "hook.side_effect"] }),
      now,
    );

    // Hook DAG check (rule 9) runs before auto-policy completeness
    // (rule 10). A bundle with both a hook cycle AND an unfulfilled
    // auto-policy must surface HOOK_CYCLE.
    const bundle = makeBundle({
      hooks: [noopHook("A", ["B"]), noopHook("B", ["A"])],
      default_gate_policies: { final: "auto" } as Record<GateRole, PolicyName>,
      // policyResolver + INV_safety_floor_final both absent — auto-policy
      // would refuse if the cascade reached it.
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "HOOK_CYCLE");
        return true;
      },
    );
  });
});

// ============================================================================
// BUNDLE_STAGE_UNKNOWN_KIND
// ============================================================================

describe("loadBundle — BUNDLE_STAGE_UNKNOWN_KIND", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("refuses a stage whose kind is outside the closed five-set", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    // Forge a stage with an invalid `kind`. TS type-narrows the union, so
    // we cast through `unknown` to simulate a bundle JSON-decoded from
    // disk (where the type guarantee does not hold).
    const bundle = makeBundle({
      stages: {
        "bogus": { kind: "rogue-kind", name: "bogus" } as unknown as Stage,
      },
      flows: { default: ["bogus"] },
    });

    await assert.rejects(
      loadBundle({ bundle, project_dir: projectDir, providers: [stubProvider()], now }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_STAGE_UNKNOWN_KIND");
        assert.equal((err as KernelError).detail?.["stage"], "bogus");
        assert.equal((err as KernelError).detail?.["kind"], "rogue-kind");
        return true;
      },
    );
  });
});

// ============================================================================
// Import-scope — additional coverage
// ============================================================================

describe("loadBundle — import scope: path-form and skip", () => {
  let projectDir: string;
  let bundleDir: string;
  beforeEach(() => {
    projectDir = freshProject();
    bundleDir = mkdtempSync(join(tmpdir(), "loom-bundle-src-"));
  });
  afterEach(() => {
    cleanup(projectDir);
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it("refuses a path-form import of @loomfsm/kernel/state/transaction", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    // Path-form: the binding name is innocuous but the module path itself
    // dereferences the kernel's internal transaction module — same
    // boundary violation, different import shape.
    writeFileSync(
      join(bundleDir, "writer.ts"),
      `import { foo } from "@loomfsm/kernel/state/transaction";\nexport const y = foo;\n`,
    );

    await assert.rejects(
      loadBundle({
        bundle: makeBundle(),
        bundle_source_dir: bundleDir,
        project_dir: projectDir,
        providers: [stubProvider()],
        now,
      }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_IMPORT_SCOPE_VIOLATION");
        const violations = (err as KernelError).detail?.["violations"] as { path: string }[];
        assert.ok(violations[0]?.path.endsWith("writer.ts"));
        return true;
      },
    );
  });

  it("scans nested subdirectories below the bundle source root", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    mkdirSync(join(bundleDir, "src", "stages"), { recursive: true });
    writeFileSync(
      join(bundleDir, "src", "stages", "deep.ts"),
      `import type { Transaction } from "@loomfsm/kernel";\n`,
    );

    await assert.rejects(
      loadBundle({
        bundle: makeBundle(),
        bundle_source_dir: bundleDir,
        project_dir: projectDir,
        providers: [stubProvider()],
        now,
      }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_IMPORT_SCOPE_VIOLATION");
        const violations = (err as KernelError).detail?.["violations"] as { path: string }[];
        assert.ok(violations[0]?.path.endsWith("deep.ts"));
        return true;
      },
    );
  });

  it("skips the import-scope sweep entirely when bundle_source_dir is omitted", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    // Write a violating file in a tmp dir, then load WITHOUT passing
    // bundle_source_dir. The sweep must not run; loadBundle succeeds.
    writeFileSync(
      join(bundleDir, "would-fail.ts"),
      `import type { Transaction } from "@loomfsm/kernel";\n`,
    );

    const registry = await loadBundle({
      bundle: makeBundle(),
      // bundle_source_dir intentionally omitted
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });
    assert.ok(registry !== undefined);
  });

  it("loads cleanly when bundle source has zero violating imports", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    // Two innocuous files; one mentions Transaction inside a docstring
    // far down (no top-of-file import), one is plain.
    writeFileSync(
      join(bundleDir, "a.ts"),
      `export const a = 1;\nexport const b = 2;\n`,
    );
    writeFileSync(
      join(bundleDir, "b.ts"),
      `import { something } from "@loomfsm/kernel";\nexport const c = something;\n`,
    );

    const registry = await loadBundle({
      bundle: makeBundle(),
      bundle_source_dir: bundleDir,
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });
    assert.ok(registry !== undefined);
  });
});

// ============================================================================
// Positive cases — rules that must NOT fire when conditions are absent
// ============================================================================

describe("loadBundle — non-trigger discipline", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("does not run the phase check on FinalizeStage (kind alone signals terminator)", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      phases: ["p1"],
      stages: {
        "done": { kind: "finalize", name: "done" },
      },
      flows: { default: ["done"] },
    });

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [stubProvider()], now,
    });
    assert.equal(registry.stages.get("done")?.kind, "finalize");
  });

  it("does not run the phase check on a StepStage whose phase is undefined", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      phases: ["p1"],
      stages: {
        // Explicit undefined-phase StepStage — the type permits it; the
        // loader must not coerce undefined into a "not in phases" refusal.
        "loose": {
          kind: "step",
          name: "loose",
          position: "positional",
          effects: [],
        },
      },
      flows: { default: ["loose"] },
    });

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [stubProvider()], now,
    });
    assert.ok(registry.stages.has("loose"));
  });

  it("does not collide two StepStages whose effects share a discriminant value but differ by kind", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    // `audit.emit:foo` and `decisions.set:foo` are different effect-keys —
    // the discriminant is (kind, value), not value alone. Both Steps must
    // load cleanly.
    const bundle = makeBundle({
      stages: {
        "a": stepStage({ name: "a", effects: [{ kind: "audit.emit", type: "foo" }] }),
        "b": stepStage({ name: "b", effects: [{ kind: "decisions.set", key: "foo" }] }),
      },
      flows: { default: ["a", "b"] },
    });

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [stubProvider()], now,
    });
    assert.equal(registry.stages.size, 2);
  });

  it("accepts a GateStage whose role comes from extends_vocab.gate_roles_extra", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const bundle = makeBundle({
      stages: {
        "gate-custom": {
          kind: "gate",
          name: "gate-custom",
          phase: "p1",
          message: () => "msg",
          valid_answers: () => ({
            options: [
              { verbs: ["approve"], label: "Approve", produces: { decision: "accept" } },
            ],
          }),
        },
      },
      flows: { default: ["gate-custom"] },
      gate_roles: { "gate-custom": "triage" as GateRole },
      extends_vocab: { gate_roles_extra: ["triage" as GateRole] },
    });

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [stubProvider()], now,
    });
    assert.ok(registry.vocabularies.gate_roles.has("triage"));
  });

  it("loads cleanly when 'auto' policy ships with both resolver and INV_safety_floor_<role>", async () => {
    const now = captureNow();
    await installManifest(
      projectDir,
      makeManifest({ capabilities: ["state.read", "invariant.bundle"] }),
      now,
    );

    const resolver: GatePolicyResolver = async () => ({ type: "auto-approve", reason: "fixture" });
    const bundle = makeBundle({
      default_gate_policies: { final: "auto" } as Record<GateRole, PolicyName>,
      policyResolver: resolver,
      invariants: [noopInvariant("INV_safety_floor_final")],
    });

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [stubProvider()], now,
    });
    assert.equal(registry.invariants.length, 1);
  });

  it("does not refuse a sunset entry whose kind differs from the active extends_vocab kind", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    // 'impl-blockers' is an active error_classes extension; the sunset
    // entry retires a DIFFERENT kind (audit_types). No contradiction.
    const bundle = makeBundle({
      extends_vocab: {
        error_classes: ["impl-blockers"],
        sunset: [{ kind: "audit_types", value: "impl-blockers", retired_at: "2026-05-01" }],
      } as unknown as Bundle["extends_vocab"] & Record<string, unknown>,
    });

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [stubProvider()], now,
    });
    assert.ok(registry.vocabularies.error_classes.has("impl-blockers"));
  });

  it("loads cleanly when manifest declares every capability the runtime demands", async () => {
    const now = captureNow();
    await installManifest(
      projectDir,
      makeManifest({
        capabilities: ["state.read", "stage.event", "hook.side_effect", "invariant.bundle"],
      }),
      now,
    );

    const bundle = makeBundle({
      stages: {
        "on-spawn": stepStage({ name: "on-spawn", position: "event" }),
      },
      flows: { default: [] },
      hooks: [noopHook("logger")],
      invariants: [noopInvariant("INV_example")],
    });

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [stubProvider()], now,
    });
    assert.equal(registry.hooks.length, 1);
    assert.equal(registry.invariants.length, 1);
  });
});

// ============================================================================
// Registry assembly — wiring details beyond happy-path .size checks
// ============================================================================

describe("loadBundle — Registry wiring details", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("topo-sorts registry.hooks by `requires` (verifies the hook-topo wiring)", async () => {
    const now = captureNow();
    await installManifest(
      projectDir,
      makeManifest({ capabilities: ["state.read", "hook.side_effect"] }),
      now,
    );

    // Register in reverse-dependency order; the loader must sort them
    // into A → B → C. A regression here would mean the loader skipped
    // topoSortHooks and stored bundle.hooks verbatim.
    const a = noopHook("A");
    const b = noopHook("B", ["A"]);
    const c = noopHook("C", ["B"]);

    const registry = await loadBundle({
      bundle: makeBundle({ hooks: [c, a, b] }),
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });
    assert.deepEqual(registry.hooks.map((h) => h.name), ["A", "B", "C"]);
  });

  it("indexes provided mcp_clients into Registry.mcp_clients by name", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const client = { name: "fs-client", endpoint: "stdio://noop", scope: "task" as const };

    const registry = await loadBundle({
      bundle: makeBundle(),
      project_dir: projectDir,
      providers: [stubProvider()],
      mcp_clients: [client],
      now,
    });
    assert.equal(registry.mcp_clients.size, 1);
    assert.equal(registry.mcp_clients.get("fs-client")?.endpoint, "stdio://noop");
  });

  it("preserves invariants pass-through into Registry.invariants", async () => {
    const now = captureNow();
    await installManifest(
      projectDir,
      makeManifest({ capabilities: ["state.read", "invariant.bundle"] }),
      now,
    );

    const inv = noopInvariant("INV_my_check");
    const registry = await loadBundle({
      bundle: makeBundle({ invariants: [inv] }),
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });
    assert.equal(registry.invariants.length, 1);
    assert.equal((registry.invariants[0] as { name?: string }).name, "INV_my_check");
  });
});

// ============================================================================
// ProviderRegistry.resolve — exercise the lookup branches
// ============================================================================

describe("loadBundle — ProviderRegistry.resolve", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  // resolve takes a PipelineState; we never read from it in the MVP shape,
  // so passing a `{}` cast is sufficient to exercise the lookup branch.
  const STATE_STUB = {} as import("../src/types/state.js").PipelineState;

  it("returns the bundle.default_provider when set and present in providers[]", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const p1 = stubProvider("p1");
    const p2 = stubProvider("p2");
    const bundle: Bundle = { ...makeBundle(), default_provider: "p2" };

    const registry = await loadBundle({
      bundle, project_dir: projectDir, providers: [p1, p2], now,
    });
    assert.equal(registry.providers.resolve("any-agent", STATE_STUB).name, "p2");
  });

  it("falls back to providers[0] when bundle.default_provider is not set", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const p1 = stubProvider("p1");
    const p2 = stubProvider("p2");

    const registry = await loadBundle({
      bundle: makeBundle(),
      project_dir: projectDir,
      providers: [p1, p2],
      now,
    });
    assert.equal(registry.providers.resolve("any-agent", STATE_STUB).name, "p1");
  });

  it("throws PROVIDER_NOT_FOUND when providers[] is empty", async () => {
    const now = captureNow();
    await installManifest(projectDir, makeManifest(), now);

    const registry = await loadBundle({
      bundle: makeBundle(),
      project_dir: projectDir,
      providers: [],
      now,
    });

    assert.throws(
      () => registry.providers.resolve("orphan-agent", STATE_STUB),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "PROVIDER_NOT_FOUND");
        assert.equal((err as KernelError).detail?.["agent"], "orphan-agent");
        return true;
      },
    );
  });
});
