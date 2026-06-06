import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KernelError,
  _resetInvariantsForTest,
  captureNow,
  closeDb,
  deliverContinue,
  initializeTask,
  loadState,
  registerInvariant,
  runFSM,
  withReadTransaction,
  withStateTransaction,
} from "@loomfsm/kernel";
import { loadBundle, reconcileExtensions } from "@loomfsm/loader";
import type {
  Bundle,
  BundleStateView,
  KernelSnapshots,
  LLMProvider,
  NowToken,
} from "@loomfsm/kernel";

import specBundle from "../src/bundle.js";
import specManifest from "../manifest.js";
import {
  invSafetyFloorApproval,
  invSpec201,
} from "../src/invariants.js";

// The compiled test lives at dist/test/; the package root (where agents/,
// src/ and manifest.ts sit) is two levels up.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-bundle-spec-"));
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

// A shuttle provider whose name matches the bundle default. The FSM only
// emits the spawn intent; the provider's `spawn` is never invoked on this
// path, so a throwing stub is the right shape for a loader / drive test.
function shuttleStub(name = "claude-code-shuttle"): LLMProvider {
  return {
    name,
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub — spawn must not run in these tests");
    },
  };
}

async function installManifest(dir: string, now: NowToken): Promise<void> {
  await reconcileExtensions({
    manifests: [{ path: "/fixture/manifest.json", raw: specManifest }],
    project_dir: dir,
    now,
  });
}

// ============================================================================
// Load-time genericity — the deliberately non-code bundle registers cleanly
// ============================================================================

describe("@loomfsm/bundle-spec — loadBundle", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("registers a non-code bundle into a populated Registry", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry = await loadBundle({
      bundle: specBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });

    // Three agents, each with a backing template read off disk.
    assert.equal(registry.agents.size, 3);
    assert.equal(registry.prompts?.size, 3);
    assert.ok((registry.prompts?.get("researcher")?.body.length ?? 0) > 0);

    // One flow, deliberately unlike the code bundle's three-flow shape.
    assert.equal(registry.flows.size, 1);
    assert.deepEqual(registry.flows.get("spec"), [
      "init", "gate-scope", "research", "gate-consult", "draft",
      "review-spec", "readiness", "gate-approval", "finalize",
    ]);

    // One observer hook, two domain + floor invariants.
    assert.equal(registry.hooks.length, 1);
    assert.equal(registry.invariants.length, 2);

    // The substrate merged this bundle's vocabulary the same way it would a
    // code bundle's: gate roles it has never seen, a non-review output kind,
    // and a non-code error class are all in the merged sets.
    assert.ok(registry.vocabularies.gate_roles.has("scope"));
    assert.ok(registry.vocabularies.gate_roles.has("consult"));
    assert.ok(registry.vocabularies.gate_roles.has("spec-approval"));
    assert.ok(registry.vocabularies.output_kinds.has("research-note"));
    assert.ok(registry.vocabularies.error_classes.has("spec-defects-open"));

    // The bundle declares no build stack; the substrate never required one.
    assert.equal(specBundle.complexity_flows, undefined);
  });

  it("maps each gate to its non-kernel role", () => {
    // The loader accepts any valid role per gate, so pin the intended map
    // here — none of these three is a substrate-baseline role.
    assert.deepEqual(specBundle.gate_roles, {
      "gate-scope": "scope",
      "gate-consult": "consult",
      "gate-approval": "spec-approval",
    });
  });

  it("every agents[] entry resolves to an existing template on disk", () => {
    for (const agent of specBundle.agents) {
      const abs = join(PKG_ROOT, agent.template_path);
      assert.ok(
        existsSync(abs) && statSync(abs).isFile(),
        `agent '${agent.name}' template missing: ${agent.template_path}`,
      );
    }
  });
});

// ============================================================================
// Load-time refusals — the validator pipeline runs on a non-code bundle too
// ============================================================================

describe("@loomfsm/bundle-spec — load-time refusals", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("refuses a gate whose role is neither kernel-known nor declared (GATE_ROLE_UNKNOWN)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...specBundle,
      gate_roles: { ...specBundle.gate_roles, "gate-approval": "undeclared-role" },
    };

    await assert.rejects(
      loadBundle({
        bundle: broken,
        bundle_source_dir: PKG_ROOT,
        project_dir: projectDir,
        providers: [shuttleStub()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "GATE_ROLE_UNKNOWN");
        assert.equal((err as KernelError).detail?.["role"], "undeclared-role");
        return true;
      },
    );
  });

  // The probe: the sign-off role resolves to `auto`, so the loader demands a
  // resolver AND a safety-floor invariant whose NAME matches the role. The
  // role name carries a hyphen, so the floor's name is stamped, not declared.
  // Stripping it must surface AUTO_POLICY_INCOMPLETE — proving the
  // name-matching gate works for a role the substrate has never seen.
  it("refuses an auto sign-off role with no name-matching safety floor (AUTO_POLICY_INCOMPLETE)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...specBundle,
      invariants: specBundle.invariants.filter(
        (inv) => (inv as { name?: string }).name !== "INV_safety_floor_spec-approval",
      ),
    };

    await assert.rejects(
      loadBundle({
        bundle: broken,
        bundle_source_dir: PKG_ROOT,
        project_dir: projectDir,
        providers: [shuttleStub()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "AUTO_POLICY_INCOMPLETE");
        assert.equal((err as KernelError).detail?.["role"], "spec-approval");
        return true;
      },
    );
  });

  it("loads cleanly with the auto sign-off role because resolver + named floor both ship", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry = await loadBundle({
      bundle: specBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });

    assert.ok(
      registry.invariants.some(
        (inv) => (inv as { name?: string }).name === "INV_safety_floor_spec-approval",
      ),
      "the name-matched safety floor admitted the auto sign-off posture",
    );
  });
});

// ============================================================================
// Domain invariants — pure-function rules over a non-code phase + the floor
// ============================================================================

describe("@loomfsm/bundle-spec — domain invariants", () => {
  const NO_SNAPSHOTS = {} as KernelSnapshots;

  // The substrate's gate-policy map type names the three baseline roles as
  // required keys, so a partial fixture cannot satisfy `Partial<...>` cleanly;
  // a loose record is enough for these pure-function rules.
  function viewWith(partial: Record<string, unknown>): BundleStateView {
    return partial as unknown as BundleStateView;
  }

  it("the safety floor's runtime name matches the role the loader looks for", () => {
    assert.equal(
      (invSafetyFloorApproval as { name?: string }).name,
      "INV_safety_floor_spec-approval",
    );
  });

  it("the sign-off rule tolerates the transient open phase at the approval tick, and passes when closed", () => {
    // Record-time safety: at the gate-approval tick the review phase is
    // legitimately still in_progress (the FSM settles it on the next tick), so
    // the rule must NOT fire there — asserting on the transient state would
    // false-fire on every clean signed-off flow (the genericity harness drives
    // catch this if it regresses).
    const open = viewWith({
      gates: { "gate-approval": { name: "gate-approval", status: "auto-approved", decided_by: "auto-policy", feedback: null, decided_at: null } },
      phases: [{ name: "review-spec", status: "in_progress", skipped_reason: null, phase_extension: null, updated_at: "t" }],
    });
    assert.equal(invSpec201(open, NO_SNAPSHOTS), null);

    const closed = viewWith({
      gates: { "gate-approval": { name: "gate-approval", status: "auto-approved", decided_by: "auto-policy", feedback: null, decided_at: null } },
      phases: [{ name: "review-spec", status: "completed", skipped_reason: null, phase_extension: null, updated_at: "t" }],
    });
    assert.equal(invSpec201(closed, NO_SNAPSHOTS), null);
  });

  it("the floor is dormant unless the sign-off role is set to auto", () => {
    // No operator override → floor returns null even on an auto-approved gate.
    const dormant = viewWith({
      gate_policies: {},
      gates: { "gate-approval": { name: "gate-approval", status: "auto-approved", decided_by: "auto-policy", feedback: null, decided_at: null } },
      bundle_state: {},
    });
    assert.equal(invSafetyFloorApproval(dormant, NO_SNAPSHOTS), null);
  });

  it("the floor blocks an autonomous sign-off until the readiness signal is ok", () => {
    const base = {
      gate_policies: { "spec-approval": "auto" },
      gates: { "gate-approval": { name: "gate-approval", status: "auto-approved", decided_by: "auto-policy", feedback: null, decided_at: null } },
    };
    const missing = viewWith({ ...base, bundle_state: {} });
    const blocked = invSafetyFloorApproval(missing, NO_SNAPSHOTS);
    assert.ok(blocked !== null);
    assert.equal(blocked?.code, "INV_safety_floor_spec-approval");

    const ready = viewWith({ ...base, bundle_state: { spec_readiness: { status: "ok" } } });
    assert.equal(invSafetyFloorApproval(ready, NO_SNAPSHOTS), null);
  });
});

// ============================================================================
// End-to-end — the skeletal flow drives to finalize on the unchanged kernel
// ============================================================================

// Stub agent outputs keyed by agent name. The researcher emits a non-review
// payload, the writer a bare draft, the reviewer a verdict + one non-blocking
// defect (so the autonomous sign-off finds the draft clean).
const STUB_OUTPUT: Record<string, string> = {
  researcher:
    '```json\n{"claims":[{"statement":"the target already exposes a config file","source":"docs/config.md","confidence":"high"}],"open_questions":[]}\n```',
  "spec-writer": "Specification draft written: goal, constraints, and 3 ordered steps.",
  "spec-reviewer":
    '```json\n{"verdict":"APPROVE","summary":"draft is implementable","findings":[{"severity":"warn","category":"clarity","summary":"step 2 acceptance criterion is a little vague"}]}\n```',
};

interface DriveResult {
  verdict: string;
  summary: string;
}

// Mirror the transport loop: load state, tick the FSM, deliver whatever it
// asked for, repeat until the kernel says the task is complete.
async function driveToFinalize(
  projectDir: string,
  registry: Awaited<ReturnType<typeof loadBundle>>,
  opts: { gate_policies?: Record<string, string> } = {},
): Promise<DriveResult> {
  const initNow = captureNow();
  await withStateTransaction(projectDir, initNow, async (tx) => {
    await initializeTask(tx, {
      project_dir: projectDir,
      task: "Specify a small configuration feature",
      task_short: "demo-spec",
      client_idempotency_uuid: "drive-1",
      // No stack, no complexity hint, no tests_mode hint — none of the
      // code-domain task-create inputs are supplied.
      phases: [...registry.bundle.phases],
      flow_name: "spec",
      ...(opts.gate_policies !== undefined ? { gate_policies: opts.gate_policies } : {}),
    });
  });

  const resolveOutputKind = (agent: string): string | undefined =>
    registry.agents.get(agent)?.output_kind;
  const vocabularies = registry.vocabularies;

  for (let guard = 0; guard < 64; guard++) {
    const state = await withReadTransaction(projectDir, (tx) => loadState(tx));
    const { directive } = await runFSM(state, registry);

    if (directive.kind === "complete") {
      return { verdict: directive.verdict, summary: directive.summary };
    }
    if (directive.kind === "error") {
      throw new Error(`drive halted: ${directive.code} — ${directive.message}`);
    }
    if (directive.kind === "shuttle") {
      const intent = directive.spawn;
      const now = captureNow();
      await withStateTransaction(projectDir, now, (tx) =>
        deliverContinue(tx, {
          input: {
            type: "agent-result",
            agent_run_id: intent.agent_run_id,
            agent_output: STUB_OUTPUT[intent.agent] ?? "ok",
          },
          driver_state_id: state.driver_state_id,
          resolveOutputKind,
          vocabularies,
          registry,
        }),
      );
      continue;
    }
    if (directive.kind === "ask-user") {
      const now = captureNow();
      await withStateTransaction(projectDir, now, (tx) =>
        deliverContinue(tx, {
          input: { type: "user-answer", gate_event_id: directive.gate_event_id, decision: "accept" },
          driver_state_id: state.driver_state_id,
          vocabularies,
          registry,
        }),
      );
      continue;
    }
    throw new Error(`unexpected directive kind: ${(directive as { kind: string }).kind}`);
  }
  throw new Error("drive did not terminate within the step budget");
}

describe("@loomfsm/bundle-spec — drives to finalize on the unchanged kernel", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => {
    _resetInvariantsForTest();
    cleanup(projectDir);
  });

  async function load(): Promise<Awaited<ReturnType<typeof loadBundle>>> {
    const now = captureNow();
    await installManifest(projectDir, now);
    return loadBundle({
      bundle: specBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });
  }

  it("runs intake → research → draft → review → finalize to an accepted verdict", async () => {
    const registry = await load();
    const result = await driveToFinalize(projectDir, registry);
    assert.equal(result.verdict, "accepted");

    // The two human checkpoints were answered; the autonomous sign-off
    // decided itself. All three are NON-kernel roles the FSM drove anyway.
    const gates = await withReadTransaction(projectDir, (tx) =>
      tx.queryAll<{ name: string; status: string; decided_by: string }>(
        "SELECT name, status, decided_by FROM gates ORDER BY name",
      ),
    );
    const byName = new Map(gates.map((g) => [g.name, g]));
    assert.equal(byName.get("gate-scope")?.status, "approved");
    assert.equal(byName.get("gate-scope")?.decided_by, "human");
    assert.equal(byName.get("gate-consult")?.status, "approved");
    assert.equal(byName.get("gate-approval")?.status, "auto-approved");
    assert.equal(byName.get("gate-approval")?.decided_by, "auto-policy");
  });

  it("persists the researcher's non-review output kind without a code-shaped parse", async () => {
    const registry = await load();
    await driveToFinalize(projectDir, registry);

    const records = await withReadTransaction(projectDir, (tx) =>
      tx.queryAll<{ agent: string; output_kind: string; phase: string }>(
        "SELECT agent, output_kind, phase FROM agent_records ORDER BY id",
      ),
    );
    const researcher = records.find((r) => r.agent === "researcher");
    assert.ok(researcher !== undefined, "the researcher's record was persisted");
    assert.equal(researcher?.output_kind, "research-note");
    assert.equal(researcher?.phase, "research");
  });

  it("stamps a spec-review finding with its non-code phase provenance", async () => {
    const registry = await load();
    await driveToFinalize(projectDir, registry);

    const findings = await withReadTransaction(projectDir, (tx) =>
      tx.queryAll<{ phase: string; severity: string; agent: string; iteration: number }>(
        "SELECT phase, severity, agent, iteration FROM findings ORDER BY id",
      ),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.phase, "review-spec");
    assert.equal(findings[0]?.severity, "warn");
    assert.equal(findings[0]?.agent, "spec-reviewer");
    assert.equal(findings[0]?.iteration, 1);
  });

  it("the registered safety floor executes for the hyphenated role and admits a ready draft", async () => {
    // Opt the floor into the live invariant pass (the substrate ships the
    // seam but wires no bundle invariants by default) and set the operator
    // override that engages it. The readiness Step writes `ok` before the
    // gate, so the autonomous sign-off lands and the flow reaches finalize.
    registerInvariant(invSafetyFloorApproval);
    const registry = await load();
    const result = await driveToFinalize(projectDir, registry, {
      // The three baseline roles are required keys of the gate-policy map
      // type; only `spec-approval` is flipped to the autonomous posture.
      gate_policies: {
        classify: "human",
        plan: "human",
        final: "human",
        scope: "human",
        consult: "human",
        "spec-approval": "auto",
      },
    });
    assert.equal(result.verdict, "accepted");
  });
});
