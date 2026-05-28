import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runFSM } from "../src/fsm.js";
import { resolveGatePolicy } from "../src/gate-policy.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import {
  buildPolicyContext,
  buildPolicyFactoryRegistry,
  derivedRolePhase,
  policies,
} from "../src/policies/index.js";
import { buildVocabularies } from "../src/vocabularies.js";
import {
  KernelError,
  captureNow,
  closeDb,
  withStateTransaction,
} from "../src/state.js";
import type { Bundle } from "../src/types/bundle.js";
import type {
  AgentRecordsAccess,
  AuditAccess,
  FindingsAccess,
  StageContext,
} from "../src/types/context.js";
import type { NowToken } from "../src/types/now.js";
import type {
  GatePolicyResolver,
  Policy,
  PolicyContext,
  PolicyName,
} from "../src/types/policy.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { Registry } from "../src/types/registry.js";
import type {
  AgentVerdictRow,
  GateRole,
  Phase,
} from "../src/types/row-types.js";
import type { Stage } from "../src/types/plugins.js";
import type { BundleStateView, PipelineState } from "../src/types/state.js";

// ============================================================================
// Fixtures
// ============================================================================

function emptyFindings(blockingCount = 0, phase?: Phase): FindingsAccess {
  return {
    query: () => [],
    countBlocking(filter) {
      if (filter?.phase !== undefined && filter.phase !== phase) return 0;
      return blockingCount;
    },
    queryByPhase: () => [],
  };
}

const emptyAudit: AuditAccess = { recent: () => [] };
const emptyAgents: AgentRecordsAccess = { query: () => [] };

const NOW: NowToken = "2026-05-28T12:00:00.000Z" as NowToken;

function makeBundle(opts: {
  gate_roles?: Record<string, GateRole>;
  policyResolver?: GatePolicyResolver;
  stages?: Record<string, Stage>;
} = {}): Bundle {
  const bundle: Bundle = {
    name: "test-bundle",
    version: "0.0.1",
    description: "policy-test fixture",
    phases: ["planning", "implementing"],
    default_flow: "default",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: opts.gate_roles ?? {
      "gate-classify": "classify",
      "gate-plan": "plan",
      "gate-final": "final",
    },
    agents: [],
    stages: opts.stages ?? {
      "gate-classify": {
        kind: "gate",
        name: "gate-classify",
        phase: "planning",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
      "gate-plan": {
        kind: "gate",
        name: "gate-plan",
        phase: "planning",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
      "gate-final": {
        kind: "gate",
        name: "gate-final",
        phase: "implementing",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    },
    flows: { default: [] },
    hooks: [],
    invariants: [],
  };
  if (opts.policyResolver !== undefined) {
    bundle.policyResolver = opts.policyResolver;
  }
  return bundle;
}

function makeState(opts: {
  gate_policies?: Record<GateRole, PolicyName>;
  gate_auto_rejections?: Record<GateRole, number>;
  agent_verdicts?: AgentVerdictRow[];
} = {}): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-test",
    driver_state_id: "d-test",
    project_dir: "/tmp/test",
    bundle: "test-bundle",
    task: "test",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: NOW,
    ended_at: null,
    gate_policies: opts.gate_policies ?? ({} as Record<GateRole, PolicyName>),
    decisions: {},
    bundle_state: null,
    stack: null,
    pipeline_violation: null,
    force_used: false,
    agents_count: 0,
    gate_revisions: {} as Record<GateRole, number>,
    gate_auto_rejections:
      opts.gate_auto_rejections ?? ({} as Record<GateRole, number>),
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
    agent_verdicts: opts.agent_verdicts ?? [],
    pending_agents: [],
    now: NOW,
  };
}

function makeRegistry(bundle: Bundle): Registry {
  return {
    bundle,
    agents: new Map(),
    stages: new Map(),
    flows: new Map(),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => {
        throw new Error("provider lookup not expected in policy tests");
      },
      all: [],
      health_check_all: Promise.resolve([]),
    },
    policyFactories: buildPolicyFactoryRegistry(bundle),
    vocabularies: buildVocabularies(bundle),
  };
}

function makeCtx(
  bundle: Bundle,
  opts: {
    blockingCount?: number;
    rolePhase?: Phase | null;
    findings?: FindingsAccess;
  } = {},
): PolicyContext {
  return {
    bundle,
    findings:
      opts.findings ?? emptyFindings(opts.blockingCount ?? 0, opts.rolePhase ?? undefined),
    agents_query: emptyAgents,
    latest_verdict: () => null,
    rolePhase: () => opts.rolePhase ?? null,
    now: NOW,
  };
}

function makeStageContextStub(bundle: Bundle): StageContext {
  // buildPolicyContext only reads `bundle`, `findings`, `agents_query`,
  // `now` off the StageContext — the rest is irrelevant. Cast is safe
  // because the helper never reaches into the omitted fields.
  return {
    bundle,
    findings: emptyFindings(),
    agents_query: emptyAgents,
    now: NOW,
  } as unknown as StageContext;
}

// ============================================================================
// Stock factories
// ============================================================================

describe("policies.human()", () => {
  it("returns human-required and embeds role in reason", () => {
    const policy = policies.human();
    const result = policy(makeState(), "plan", makeCtx(makeBundle()));
    assert.equal((result as { type: string }).type, "human-required");
    assert.match(
      (result as { reason: string }).reason,
      /policy\[plan\]=human/,
    );
  });
});

describe("policies.bundle()", () => {
  it("delegates to bundle.policyResolver with role + narrowed state pass-through", async () => {
    const policy = policies.bundle();
    const calls: Array<{ role: string; task_id: string | null }> = [];
    const bundle = makeBundle({
      policyResolver: (s, role) => {
        calls.push({ role, task_id: s.task_id });
        return { type: "auto-approve", reason: "ok" };
      },
    });
    const result = await Promise.resolve(
      policy(makeState(), "final", makeCtx(bundle)),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.role, "final");
    // The resolver receives the BundleStateView; `task_id` is a known
    // value on the snapshot we built. Verifies state was actually
    // threaded — not just role.
    assert.equal(calls[0]?.task_id, "t-test");
    assert.equal(result.type, "auto-approve");
  });

  it("defensive human-required when resolver absent", async () => {
    const policy = policies.bundle();
    const bundle = makeBundle(); // no resolver
    const result = await Promise.resolve(
      policy(makeState(), "plan", makeCtx(bundle)),
    );
    assert.equal(result.type, "human-required");
    assert.match(result.reason, /without bundle resolver/);
  });
});

describe("policies.onBlockers()", () => {
  it("human-required when blockers > 0 in the role's phase", async () => {
    const policy = policies.onBlockers();
    const bundle = makeBundle();
    const result = await Promise.resolve(
      policy(
        makeState(),
        "plan",
        makeCtx(bundle, { blockingCount: 2, rolePhase: "planning" }),
      ),
    );
    assert.equal(result.type, "human-required");
    assert.match(result.reason, /2 open blocking finding/);
  });

  it("auto-approve when blockers=0 and no resolver", async () => {
    const policy = policies.onBlockers();
    const bundle = makeBundle();
    const result = await Promise.resolve(
      policy(makeState(), "plan", makeCtx(bundle, { blockingCount: 0 })),
    );
    assert.equal(result.type, "auto-approve");
    assert.match(result.reason, /clean state/);
  });

  it("delegates to bundle resolver when blockers=0 (role passed through)", async () => {
    const policy = policies.onBlockers();
    let calledWithRole: string | null = null;
    const bundle = makeBundle({
      policyResolver: (_s, r) => {
        calledWithRole = r;
        return {
          type: "auto-reject",
          reason: "resolver said so",
          reject_intent: "revise",
        };
      },
    });
    const result = await Promise.resolve(
      policy(makeState(), "plan", makeCtx(bundle, { blockingCount: 0 })),
    );
    assert.equal(calledWithRole, "plan");
    assert.equal(result.type, "auto-reject");
  });

  it("calls countBlocking with rolePhase(role) as the phase filter", async () => {
    const policy = policies.onBlockers();
    const seen: Array<{ phase?: Phase }> = [];
    const findings: FindingsAccess = {
      query: () => [],
      countBlocking(filter) {
        seen.push(filter ?? {});
        return 0;
      },
      queryByPhase: () => [],
    };
    const bundle = makeBundle();
    const ctx: PolicyContext = {
      bundle,
      findings,
      agents_query: emptyAgents,
      latest_verdict: () => null,
      rolePhase: (role) => (role === "plan" ? "planning" : null),
      now: NOW,
    };
    await Promise.resolve(policy(makeState(), "plan", ctx));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.phase, "planning");
  });

  it("calls countBlocking with no phase filter when rolePhase returns null", async () => {
    const policy = policies.onBlockers();
    const seen: Array<{ phase?: Phase }> = [];
    const findings: FindingsAccess = {
      query: () => [],
      countBlocking(filter) {
        seen.push(filter ?? {});
        return 0;
      },
      queryByPhase: () => [],
    };
    const bundle = makeBundle();
    const ctx: PolicyContext = {
      bundle,
      findings,
      agents_query: emptyAgents,
      latest_verdict: () => null,
      rolePhase: () => null,
      now: NOW,
    };
    await Promise.resolve(policy(makeState(), "plan", ctx));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.phase, undefined);
  });
});

// ============================================================================
// derivedRolePhase
// ============================================================================

describe("derivedRolePhase", () => {
  it("returns the phase of the gate that maps to the role", () => {
    const bundle = makeBundle();
    assert.equal(derivedRolePhase(bundle, "plan"), "planning");
    assert.equal(derivedRolePhase(bundle, "final"), "implementing");
    assert.equal(derivedRolePhase(bundle, "classify"), "planning");
  });

  it("returns null when no gate maps the role", () => {
    const bundle = makeBundle({ gate_roles: {} as Record<string, GateRole> });
    assert.equal(derivedRolePhase(bundle, "plan"), null);
  });

  it("returns the FIRST in insertion order when multiple gates share a role", () => {
    const stages: Record<string, Stage> = {
      "gate-plan-a": {
        kind: "gate",
        name: "gate-plan-a",
        phase: "first-phase",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
      "gate-plan-b": {
        kind: "gate",
        name: "gate-plan-b",
        phase: "second-phase",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const bundle = makeBundle({
      gate_roles: {
        "gate-plan-a": "plan",
        "gate-plan-b": "plan",
      },
      stages,
    });
    assert.equal(derivedRolePhase(bundle, "plan"), "first-phase");
  });

  it("skips non-gate stages when scanning", () => {
    const stages: Record<string, Stage> = {
      "step-1": {
        kind: "step",
        name: "step-1",
        phase: "planning",
        position: "positional",
        effects: [],
      },
      "gate-plan": {
        kind: "gate",
        name: "gate-plan",
        phase: "implementing",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const bundle = makeBundle({
      gate_roles: { "gate-plan": "plan" },
      stages,
    });
    assert.equal(derivedRolePhase(bundle, "plan"), "implementing");
  });
});

// ============================================================================
// buildPolicyContext
// ============================================================================

describe("buildPolicyContext", () => {
  it("rolePhase delegates to derivedRolePhase(bundle, role)", () => {
    const bundle = makeBundle();
    const polCtx = buildPolicyContext(makeStageContextStub(bundle));
    assert.equal(polCtx.rolePhase("plan"), "planning");
    assert.equal(polCtx.rolePhase("final"), "implementing");
    assert.equal(polCtx.rolePhase("nonexistent" as GateRole), null);
  });

  it("latest_verdict returns the LAST matching row, scoped to the agent", () => {
    const verdicts: AgentVerdictRow[] = [
      {
        phase: "planning",
        agent: "rev-a",
        iteration: 1,
        verdict: "FAIL",
        summary_line: null,
        blocking_issues: 1,
        warn_issues: 0,
        info_issues: 0,
        categories_seen: [],
        recorded_at: "2026-05-28T10:00:00.000Z",
      },
      {
        phase: "planning",
        agent: "rev-a",
        iteration: 2,
        verdict: "PASS",
        summary_line: "ok",
        blocking_issues: 0,
        warn_issues: 0,
        info_issues: 0,
        categories_seen: [],
        recorded_at: "2026-05-28T11:00:00.000Z",
      },
      {
        phase: "planning",
        agent: "rev-b",
        iteration: 1,
        verdict: "FAIL",
        summary_line: null,
        blocking_issues: 1,
        warn_issues: 0,
        info_issues: 0,
        categories_seen: [],
        recorded_at: "2026-05-28T12:00:00.000Z",
      },
    ];
    const bundle = makeBundle();
    const polCtx = buildPolicyContext(makeStageContextStub(bundle));
    const state = makeState({ agent_verdicts: verdicts }) as PipelineState;
    const view = state as unknown as BundleStateView;
    const latest = polCtx.latest_verdict(view, "rev-a");
    assert.equal(latest?.iteration, 2);
    assert.equal(latest?.verdict, "PASS");
  });

  it("latest_verdict returns null when no row matches", () => {
    const bundle = makeBundle();
    const polCtx = buildPolicyContext(makeStageContextStub(bundle));
    const view = makeState() as unknown as BundleStateView;
    assert.equal(polCtx.latest_verdict(view, "nobody"), null);
  });
});

// ============================================================================
// resolveGatePolicy — cap, dispatch, identity-fallback, unresolved
// ============================================================================

describe("resolveGatePolicy", () => {
  it("applies replan cap before factory runs (on_exhaustion=human)", async () => {
    const bundle = makeBundle({
      policyResolver: () => {
        throw new Error("resolver should NOT run past the cap");
      },
    });
    const registry = makeRegistry(bundle);
    // Default cap is min(3, 10) = 3; seed sum at 5 to force exhaustion.
    const state = makeState({
      gate_policies: { plan: "auto" } as Record<GateRole, PolicyName>,
      gate_auto_rejections: { plan: 5 } as Record<GateRole, number>,
    });
    const result = await resolveGatePolicy(
      state,
      "gate-plan",
      makeCtx(bundle),
      registry,
    );
    assert.equal(result.type, "human-required");
    assert.match(result.reason, /auto-replan-capped/);
  });

  it("on_exhaustion=audit-only → auto-approve at the cap", async () => {
    const bundle = makeBundle();
    bundle.replan_budget = {
      kind: "attempt",
      max_iterations: 2,
      on_exhaustion: "audit-only",
    };
    const registry = makeRegistry(bundle);
    const state = makeState({
      gate_auto_rejections: { plan: 2 } as Record<GateRole, number>,
    });
    const result = await resolveGatePolicy(
      state,
      "gate-plan",
      makeCtx(bundle),
      registry,
    );
    assert.equal(result.type, "auto-approve");
    assert.match(result.reason, /auto-replan-capped/);
  });

  it("on_exhaustion=abandon → auto-reject with abandon intent", async () => {
    const bundle = makeBundle();
    bundle.replan_budget = {
      kind: "attempt",
      max_iterations: 1,
      on_exhaustion: "abandon",
    };
    const registry = makeRegistry(bundle);
    const state = makeState({
      gate_auto_rejections: { plan: 1 } as Record<GateRole, number>,
    });
    const result = await resolveGatePolicy(
      state,
      "gate-plan",
      makeCtx(bundle),
      registry,
    );
    assert.equal(result.type, "auto-reject");
    assert.equal(result.reject_intent, "abandon");
  });

  it("kernel ceiling clamps bundle.replan_budget.max_iterations", async () => {
    // Bundle declares 100; kernel ceiling is 10. Effective cap = 10.
    // Sum at 10 must trip exhaustion even though the bundle would
    // otherwise allow 100 attempts.
    const bundle = makeBundle({
      policyResolver: () => {
        throw new Error("resolver MUST NOT run past the kernel ceiling");
      },
    });
    bundle.replan_budget = {
      kind: "attempt",
      max_iterations: 100,
      on_exhaustion: "human",
    };
    const registry = makeRegistry(bundle);
    const state = makeState({
      gate_policies: { plan: "auto" } as Record<GateRole, PolicyName>,
      gate_auto_rejections: { plan: 10 } as Record<GateRole, number>,
    });
    const result = await resolveGatePolicy(
      state,
      "gate-plan",
      makeCtx(bundle),
      registry,
    );
    assert.equal(result.type, "human-required");
    assert.match(result.reason, /auto-replan-capped at 10/);
  });

  it("identity-fallback: gate name used as role when not mapped", async () => {
    const bundle = makeBundle({ gate_roles: {} as Record<string, GateRole> });
    const registry = makeRegistry(bundle);
    const state = makeState({
      gate_policies: { "custom-gate": "human" } as unknown as Record<
        GateRole,
        PolicyName
      >,
    });
    const result = await resolveGatePolicy(
      state,
      "custom-gate",
      makeCtx(bundle),
      registry,
    );
    assert.equal(result.type, "human-required");
  });

  it("defaults to 'human' when gate_policies[role] is unset", async () => {
    const bundle = makeBundle();
    const registry = makeRegistry(bundle);
    const state = makeState(); // empty gate_policies
    const result = await resolveGatePolicy(
      state,
      "gate-plan",
      makeCtx(bundle),
      registry,
    );
    assert.equal(result.type, "human-required");
  });

  it("POLICY_UNRESOLVED when state names a missing factory", async () => {
    const bundle = makeBundle();
    const registry = makeRegistry(bundle);
    const state = makeState({
      gate_policies: { plan: "ghost-policy" } as Record<GateRole, PolicyName>,
    });
    await assert.rejects(
      () => resolveGatePolicy(state, "gate-plan", makeCtx(bundle), registry),
      (err: unknown) =>
        err instanceof KernelError && err.code === "POLICY_UNRESOLVED",
    );
  });

  it("dispatches to a bundle-registered factory by wire name", async () => {
    let called = false;
    const customFactory: () => Policy = () => () => {
      called = true;
      return { type: "auto-approve", reason: "custom" };
    };
    const bundle = makeBundle();
    bundle.policy_factories = {
      "custom-name": customFactory,
    } as unknown as Record<PolicyName, () => Policy>;
    const registry = makeRegistry(bundle);
    const state = makeState({
      gate_policies: { plan: "custom-name" } as unknown as Record<
        GateRole,
        PolicyName
      >,
    });
    const result = await resolveGatePolicy(
      state,
      "gate-plan",
      makeCtx(bundle),
      registry,
    );
    assert.equal(called, true);
    assert.equal(result.type, "auto-approve");
  });
});

// ============================================================================
// buildPolicyFactoryRegistry
// ============================================================================

describe("buildPolicyFactoryRegistry", () => {
  it("seeds the three kernel-shipped factories", () => {
    const m = buildPolicyFactoryRegistry(makeBundle());
    assert.ok(m.has("human"));
    assert.ok(m.has("on-blockers"));
    assert.ok(m.has("auto"));
  });

  it("merges bundle-registered factories alongside the seeds", () => {
    const bundle = makeBundle();
    bundle.policy_factories = {
      "cost-bounded": () => () => ({ type: "auto-approve", reason: "cb" }),
    } as unknown as Record<PolicyName, () => Policy>;
    const m = buildPolicyFactoryRegistry(bundle);
    assert.ok(m.has("human")); // seed still present
    assert.ok(m.has("cost-bounded"));
  });

  it("refuses bundle re-binding a kernel-shipped name", () => {
    const bundle = makeBundle();
    bundle.policy_factories = {
      human: () => () => ({ type: "auto-approve", reason: "no" }),
    } as unknown as Record<PolicyName, () => Policy>;
    assert.throws(
      () => buildPolicyFactoryRegistry(bundle),
      (err: unknown) =>
        err instanceof KernelError && err.code === "POLICY_NAME_COLLISION",
    );
  });
});

// ============================================================================
// End-to-end via runFSM — proves the gate-policy wiring lands through
// the full tick loop, not just the unit-tested dispatcher.
// ============================================================================

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-gate-policy-e2e-"));
}

function cleanupProject(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may already be closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

function makeStubProvider(): LLMProvider {
  return {
    name: "stub",
    capabilities: {
      execution: "shuttle",
      idempotent_spawn: true,
      reports_usage: true,
    },
    async spawn() {
      throw new Error("stub provider — spawn must not run in this test");
    },
  };
}

async function seedBaseline(
  projectDir: string,
  flow_name: string,
): Promise<NowToken> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, task_id, driver_state_id, status, verdict, started_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "stub-bundle",
        "e2e fixture",
        "t-2026-05-28-e2e",
        "d-e2e",
        "in_progress",
        null,
        now,
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) VALUES (1, ?, 0, 0)",
      [flow_name],
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES ('p1', 'pending', NULL, ?)",
      [now],
    );
  });
  return now;
}

function buildInMemoryState(
  projectDir: string,
  now: NowToken,
  flow_name: string,
  gate_policies: Record<string, PolicyName> = {},
): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-05-28-e2e",
    driver_state_id: "d-e2e",
    project_dir: projectDir,
    bundle: "stub-bundle",
    task: "e2e fixture",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: now,
    ended_at: null,
    gate_policies: gate_policies as Record<GateRole, PolicyName>,
    decisions: {},
    bundle_state: null,
    stack: null,
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
      flow_name,
      step_index: 0,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [
      {
        name: "p1",
        status: "pending",
        skipped_reason: null,
        phase_extension: null,
        updated_at: now,
      },
    ],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now,
  };
}

function buildE2ERegistry(opts: {
  gateName: string;
  gate_roles?: Record<string, GateRole>;
}): Registry {
  const stage: Stage = {
    kind: "gate",
    name: opts.gateName,
    phase: "p1",
    message: () => "proceed?",
    valid_answers: () => ({ options: [] }),
  };
  const provider = makeStubProvider();
  const bundle: Bundle = {
    name: "stub-bundle",
    version: "0.0.1",
    description: "e2e fixture",
    phases: ["p1"],
    default_flow: "default",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: opts.gate_roles ?? {},
    agents: [],
    stages: { [opts.gateName]: stage },
    flows: { default: [opts.gateName] },
    hooks: [],
    invariants: [],
  };
  return {
    bundle,
    agents: new Map(),
    stages: new Map([[opts.gateName, stage]]),
    flows: new Map([["default", [opts.gateName]]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => provider,
      all: [provider],
      health_check_all: Promise.resolve([{ name: "stub", healthy: true }]),
    },
    policyFactories: buildPolicyFactoryRegistry(bundle),
    vocabularies: buildVocabularies(bundle),
  };
}

describe("runFSM integration — gate-policy wiring", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanupProject(projectDir));

  it("identity-fallback: gate with no gate_roles mapping dispatches against state.gate_policies[gateName]", async () => {
    // Bundle does NOT map "custom-gate" to any role. The dispatcher
    // uses the gate name itself as the role; with no entry in
    // gate_policies it defaults to "human" → ask_user directive.
    const registry = buildE2ERegistry({
      gateName: "custom-gate",
      gate_roles: {},
    });
    const now = await seedBaseline(projectDir, "default");
    const state = buildInMemoryState(projectDir, now, "default");

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "ask-user");
    if (out.directive.kind === "ask-user") {
      assert.equal(out.directive.gate, "custom-gate");
    }
  });

  it("POLICY_UNRESOLVED rolls back the stage tx and surfaces as a rejection", async () => {
    const registry = buildE2ERegistry({
      gateName: "gate-x",
      gate_roles: { "gate-x": "plan" },
    });
    const now = await seedBaseline(projectDir, "default");
    const state = buildInMemoryState(projectDir, now, "default", {
      plan: "ghost-policy",
    });

    await assert.rejects(
      () => runFSM(state, registry),
      (err: unknown) =>
        err instanceof KernelError && err.code === "POLICY_UNRESOLVED",
    );
  });
});

// Suppress unused-import warnings for fixture-side types.
void ({} as { audit?: AuditAccess; agents?: AgentRecordsAccess });
