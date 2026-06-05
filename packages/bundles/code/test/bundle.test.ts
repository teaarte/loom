import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KernelError,
  buildPrompt,
  captureNow,
  closeDb,
  loadBundle,
  reconcileExtensions,
} from "@loomfsm/kernel";
import type {
  Bundle,
  BundleStateView,
  ConditionalSpawnContext,
  LLMProvider,
  NowToken,
  PipelineState,
  StageContext,
} from "@loomfsm/kernel";

import codeBundle from "../src/bundle.js";
import { invCode105 } from "../src/invariants.js";
import codeManifest from "../manifest.js";

// The compiled test lives at dist/test/; the package root (where agents/,
// schemas/, src/ and manifest.ts sit) is two levels up.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-bundle-code-"));
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

function shuttleStub(name = "claude-code-shuttle"): LLMProvider {
  return {
    name,
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub — spawn must not run in loader tests");
    },
  };
}

async function installManifest(dir: string, now: NowToken): Promise<void> {
  await reconcileExtensions({
    manifests: [{ path: "/fixture/manifest.json", raw: codeManifest }],
    project_dir: dir,
    now,
  });
}

// ============================================================================
// Happy path — the real bundle registers without error
// ============================================================================

describe("@loomfsm/bundle-code — loadBundle", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("registers the migrated manifest + bundle into a populated Registry", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry = await loadBundle({
      bundle: codeBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });

    // 22 canonical agents (the source's 24 minus the three CC-harness
    // trigger agents, plus the adjudicator).
    assert.equal(registry.agents.size, 22);
    // Every agent's `.md` is read off disk into the prompt map at load.
    assert.equal(registry.prompts?.size, 22);
    assert.ok((registry.prompts?.get("classifier")?.body.length ?? 0) > 0);
    assert.equal(registry.flows.size, 4);
    assert.deepEqual(
      registry.flows.get("medium"),
      [
        "initialize", "classify", "classify-agent", "stack-to-bundle-state", "gate-classify",
        "enrich", "plan", "plan-review", "gate-plan",
        "git-stash", "implement", "git-diff", "pre-review", "review",
        "adjudicate", "reconcile", "iterate", "final-checks", "test-verify",
        "gate-final", "finish-summary", "finalize",
      ],
    );
    // Two post-commit observers, nine domain + floor invariants.
    assert.equal(registry.hooks.length, 2);
    assert.equal(registry.invariants.length, 9);
    // Vocabulary merged the bundle's error_classes onto the kernel set.
    assert.ok(registry.vocabularies.error_classes.has("impl-blockers"));
    assert.ok(registry.vocabularies.gate_roles.has("classify"));
  });

  it("declares a complexity→flow map, a lean `simple` flow, and a fast `trivial` flow (loads cleanly past the prefix invariant)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry = await loadBundle({
      bundle: codeBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });

    // The map routes complexity → flow, switching after classify-agent.
    const cf = registry.bundle.complexity_flows;
    assert.ok(cf !== undefined, "bundle must declare complexity_flows");
    assert.equal(cf?.decision_key, "complexity");
    assert.equal(cf?.after_stage, "classify-agent");
    assert.deepEqual(cf?.map, {
      trivial: "trivial",
      simple: "simple",
      medium: "medium",
      complex: "complex",
    });

    // Every mapped flow shares the [initialize, classify, classify-agent]
    // prefix (the invariant the loader enforced to admit this bundle).
    const sharedPrefix = ["initialize", "classify", "classify-agent"];
    for (const name of ["trivial", "simple", "medium", "complex"]) {
      assert.deepEqual(
        registry.flows.get(name)?.slice(0, 3),
        sharedPrefix,
        `flow '${name}' must share the switch prefix`,
      );
    }

    // The `simple` flow is genuinely lean: a single reviewer, NO fanout.
    const simple = registry.flows.get("simple") ?? [];
    assert.ok(simple.includes("review-light"), "lean flow runs the single review-light spawn");
    assert.ok(!simple.includes("review"), "lean flow drops the review fanout");
    assert.ok(!simple.includes("plan-review"), "lean flow drops the plan-review fanout");
    assert.ok(!simple.includes("gate-classify"), "lean flow drops the classify gate");

    // The `trivial` (fast-task) flow is a single implementer spawn → finalize:
    // no planner, no reviewers, no gates.
    const trivial = registry.flows.get("trivial") ?? [];
    assert.ok(trivial.includes("implement"), "fast flow runs the implementer");
    assert.ok(trivial.includes("finalize"), "fast flow finalizes");
    for (const dropped of ["plan", "review", "review-light", "plan-review", "gate-classify", "gate-plan", "gate-final"]) {
      assert.ok(!trivial.includes(dropped), `fast flow drops '${dropped}'`);
    }
  });

  it("self-skips the classifier spawn when the operator pinned the complexity", () => {
    const stage = codeBundle.stages["classify-agent"];
    assert.equal(stage?.kind, "spawn");
    const when = stage?.kind === "spawn" ? stage.when : undefined;
    assert.ok(when !== undefined, "classify-agent must carry a `when` guard");
    const ctx = {} as unknown as ConditionalSpawnContext;
    const view = (decisions: Record<string, unknown>): BundleStateView =>
      ({ decisions } as unknown as BundleStateView);

    // Pinned (fast-task ⚡ or the complexity selector) → skip the classifier.
    assert.equal(when(view({ complexity: "trivial", complexity_pinned: true }), ctx), false);
    assert.equal(when(view({ complexity: "medium", complexity_pinned: true }), ctx), false);
    // Not pinned → run the classifier (the default path is unchanged).
    assert.equal(when(view({}), ctx), true);
    assert.equal(when(view({ complexity: "complex" }), ctx), true);
    // A pin flag without a valid complexity value is ignored (still classifies).
    assert.equal(when(view({ complexity_pinned: true }), ctx), true);
  });

  it("materializes the declared spawn-context assets and injects them into the classifier prompt", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry = await loadBundle({
      bundle: codeBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });

    // The two declared assets materialize, in declaration order, scoped to
    // the classifier.
    const assets = registry.context_assets ?? [];
    assert.equal(assets.length, 2);
    const refs = assets.find((a) => a.heading === "Refs catalog");
    const stack = assets.find((a) => a.heading === "Stack candidate registry");
    assert.ok(refs !== undefined, "refs catalog asset materialized");
    assert.ok(stack !== undefined, "stack registry asset materialized");
    assert.deepEqual(refs.agents, ["classifier"]);
    // The catalog lists real reference filenames (the field that hallucinated
    // when no catalog was supplied).
    assert.ok(refs.body.includes("FILE: knowledge/references/api-design.md"));
    assert.ok(refs.body.includes("FILE: knowledge/references/security-backend.md"));
    // The stack registry inlines the real candidate file.
    assert.ok(stack.body.includes("```yaml"));

    // End-to-end: the classifier's spawn prompt carries both, under their
    // bundle headings; a non-consuming agent's prompt does not.
    const classifierAgent = registry.agents.get("classifier");
    assert.ok(classifierAgent !== undefined);
    const classifierPrompt = buildPrompt(makeClassifyState(), classifierAgent, registry);
    assert.ok(classifierPrompt.includes("### Refs catalog"));
    assert.ok(classifierPrompt.includes("FILE: knowledge/references/api-design.md"));
    assert.ok(classifierPrompt.includes("### Stack candidate registry"));

    const implementer = registry.agents.get("implementer");
    assert.ok(implementer !== undefined);
    const implPrompt = buildPrompt(makeClassifyState(), implementer, registry);
    assert.ok(!implPrompt.includes("### Refs catalog"));
  });

});

// Minimal state for the pure render path. buildPrompt reads task / ids /
// project / decisions / driver.flow_name; a partial cast suffices (the same
// shape the kernel renderer's own specs use).
function makeClassifyState(): PipelineState {
  return {
    task: "fix a typo in the README",
    task_short: "typo-fix",
    task_id: "task-1",
    driver_state_id: "ds-1",
    project_dir: "/work/proj",
    decisions: {},
    driver: { flow_name: "medium" },
  } as unknown as PipelineState;
}

// ============================================================================
// Every agent in agents[] has a backing template .md on disk
// ============================================================================

describe("@loomfsm/bundle-code — agent templates", () => {
  it("every agents[] entry resolves to an existing .md template file", () => {
    for (const agent of codeBundle.agents) {
      const abs = join(PKG_ROOT, agent.template_path);
      assert.ok(
        existsSync(abs) && statSync(abs).isFile(),
        `agent '${agent.name}' template missing: ${agent.template_path}`,
      );
    }
  });

  it("declares exactly the 22 canonical agents", () => {
    assert.equal(codeBundle.agents.length, 22);
    const names = codeBundle.agents.map((a) => a.name).sort();
    // The three CC-harness trigger agents are NOT bundle agents.
    for (const excluded of ["fe-test-all-agent", "runtime-debug-agent", "test-all-agent"]) {
      assert.ok(!names.includes(excluded), `${excluded} must not be a bundle agent`);
    }
  });

  it("maps each gate to its intended kernel role", () => {
    // The loader accepts ANY valid role per gate, so a valid-but-wrong swap
    // (e.g. gate-plan -> "final") loads fine yet is a real bug. Pin the
    // intended mapping here, which load does not guarantee.
    assert.deepEqual(codeBundle.gate_roles, {
      "gate-classify": "classify",
      "gate-plan": "plan",
      "gate-final": "final",
    });
  });
});

// ============================================================================
// Refusals — the load test must FAIL when the bundle shape is broken
// ============================================================================

describe("@loomfsm/bundle-code — load-time refusals", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("refuses an orphan stage name in a flow (BUNDLE_FLOW_UNKNOWN_STAGE)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      flows: {
        ...codeBundle.flows,
        medium: [...(codeBundle.flows["medium"] ?? []), "ghost-stage"],
      },
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
        assert.equal((err as KernelError).code, "BUNDLE_FLOW_UNKNOWN_STAGE");
        assert.equal((err as KernelError).detail?.["missing_stage"], "ghost-stage");
        return true;
      },
    );
  });

  it("refuses a gate whose role is neither kernel-known nor declared (GATE_ROLE_UNKNOWN)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      gate_roles: { ...codeBundle.gate_roles, "gate-final": "bogus-role" },
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
        assert.equal((err as KernelError).detail?.["role"], "bogus-role");
        return true;
      },
    );
  });

  it("refuses an agent whose template .md is missing on disk (TEMPLATE_NOT_FOUND)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      agents: [
        ...codeBundle.agents,
        { name: "phantom", template_path: "agents/phantom.md", output_kind: "nonreview" },
      ],
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
        assert.equal((err as KernelError).code, "TEMPLATE_NOT_FOUND");
        assert.equal((err as KernelError).detail?.["agent"], "phantom");
        return true;
      },
    );
  });

  it("refuses a spawn stage referencing an undeclared agent (BUNDLE_AGENT_UNKNOWN)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      stages: {
        ...codeBundle.stages,
        implement: { kind: "spawn", name: "implement", phase: "implementation", agent: "ghost-agent" },
      },
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
        assert.equal((err as KernelError).code, "BUNDLE_AGENT_UNKNOWN");
        assert.equal((err as KernelError).detail?.["agent"], "ghost-agent");
        return true;
      },
    );
  });
});

// ============================================================================
// Auto-readiness — flipping the final role to `auto` loads cleanly because
// the resolver + the named safety-floor invariant are both shipped.
// ============================================================================

describe("@loomfsm/bundle-code — full-autonomous readiness", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("loads cleanly when the final role is overridden to auto", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const autoFinal: Bundle = {
      ...codeBundle,
      default_gate_policies: { ...codeBundle.default_gate_policies, final: "auto" },
    };

    const registry = await loadBundle({
      bundle: autoFinal,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });
    // The resolver + INV_safety_floor_final satisfied the auto-policy gate.
    assert.ok(registry.invariants.some((inv) => (inv as { name?: string }).name === "INV_safety_floor_final"));
  });
});

// ============================================================================
// stack lives in bundle_state (bundle-owned), not a kernel column
// ============================================================================

describe("@loomfsm/bundle-code — stack-to-bundle-state relocation", () => {
  // Run the positional step over a state whose decisions carry the
  // classifier's stack pick, capturing what it writes to bundle_state.
  function runRelocate(decisions: Record<string, unknown>): Record<string, unknown> {
    const captured: Record<string, unknown> = {};
    const state = { decisions } as unknown as BundleStateView;
    const ctx = {
      tx: { set_bundle_state_field: (p: string, v: unknown) => { captured[p] = v; } },
    } as unknown as StageContext;
    const stage = codeBundle.stages["stack-to-bundle-state"];
    assert.ok(stage !== undefined && stage.kind === "step" && stage.run !== undefined);
    // The step is synchronous in effect; run it to completion.
    void stage.run(state, ctx);
    return captured;
  }

  it("relocates the classifier's stack object from decisions into bundle_state.stack", () => {
    const stack = {
      language: "typescript",
      package_manager: "pnpm",
      test_command: "pnpm test",
      lint_command: null,
      build_command: "pnpm build",
      project_type: "library",
    };
    const captured = runRelocate({ stack, complexity: "medium" });
    assert.deepEqual(captured["stack"], stack);
  });

  it("writes nothing when the classifier emitted no stack (null / absent)", () => {
    assert.deepEqual(runRelocate({ stack: null }), {});
    assert.deepEqual(runRelocate({}), {});
  });

  it("declares the bundle_state.stack write as its effect + sits at the switch boundary in every flow", () => {
    const stage = codeBundle.stages["stack-to-bundle-state"];
    assert.ok(stage !== undefined && stage.kind === "step");
    assert.deepEqual(stage.effects, [{ kind: "bundle_state.set", path: "stack" }]);
    // Index 3 (right after classify-agent) in all three flows, so the
    // complexity switch lands on an identical stage.
    for (const flow of ["simple", "medium", "complex"]) {
      assert.equal(
        codeBundle.flows[flow]?.[3],
        "stack-to-bundle-state",
        `flow '${flow}' must place the relocate step at the switch boundary`,
      );
    }
  });
});

// ============================================================================
// conditional review panel — a doc-only outcome skips the code reviewers
// ============================================================================

describe("@loomfsm/bundle-code — review panel gates on source presence", () => {
  // Run the pre-review step over a file accounting and read back the
  // source_changed decision it derives.
  async function runPreReview(
    files_modified: string[],
    files_created: string[] = [],
  ): Promise<unknown> {
    const captured: Record<string, unknown> = {};
    const state = { files_modified, files_created, decisions: {} } as unknown as BundleStateView;
    const ctx = {
      tx: { set_decision: (k: string, v: unknown) => { captured[k] = v; } },
    } as unknown as StageContext;
    const stage = codeBundle.stages["pre-review"];
    assert.ok(stage !== undefined && stage.kind === "step" && stage.run !== undefined);
    await stage.run(state, ctx);
    return captured["source_changed"];
  }

  function reviewerApplies(name: string, decisions: Record<string, unknown>): boolean {
    const agent = codeBundle.agents.find((a) => a.name === name);
    assert.ok(agent?.applies_to !== undefined, `${name} must declare applies_to`);
    const state = { decisions } as unknown as BundleStateView;
    return agent.applies_to(state);
  }

  const ALWAYS_ON = ["logic-reviewer", "challenger-reviewer", "style-reviewer", "performance"];

  it("pre-review sets source_changed=false for a doc-only OR an empty (no-op) diff", async () => {
    assert.equal(await runPreReview(["docs/HANDOFF.md"], []), false);
    assert.equal(await runPreReview([], ["NOTES.md"]), false);
    assert.equal(await runPreReview(["README.md", "docs/x.rst"]), false);
    // Any source file present → true.
    assert.equal(await runPreReview(["src/app.ts", "README.md"]), true);
    assert.equal(await runPreReview(["src/app.ts"]), true);
    // Empty diff at pre-review (post-implement) → a no-op: suppress the panel
    // (the work also parks at the final gate via INV_CODE_105).
    assert.equal(await runPreReview([], []), false);
  });

  it("the code reviewers skip a doc-only outcome but run otherwise", () => {
    for (const name of ALWAYS_ON) {
      // doc-only: explicitly false → skip.
      assert.equal(reviewerApplies(name, { source_changed: false }), false, `${name} should skip doc-only`);
      // source changed → run.
      assert.equal(reviewerApplies(name, { source_changed: true }), true, `${name} should run on source`);
      // unset (plan-review / no files) → run (guard is `!== false`).
      assert.equal(reviewerApplies(name, {}), true, `${name} should run when unset`);
    }
  });
});

// ============================================================================
// tests_mode is one union — every value the classify step emits is handled
// ============================================================================

describe("@loomfsm/bundle-code — tests_mode union has no fall-through", () => {
  // Run the deterministic classify step over a task and read back the
  // tests_mode decision it set.
  async function classifyTestsMode(task: string): Promise<unknown> {
    const captured: Record<string, unknown> = {};
    const state = { task, decisions: {} } as unknown as BundleStateView;
    const ctx = {
      tx: { set_decision: (k: string, v: unknown) => { captured[k] = v; } },
    } as unknown as StageContext;
    const classify = codeBundle.stages["classify"];
    assert.ok(classify !== undefined && classify.kind === "step" && classify.run !== undefined);
    await classify.run(state, ctx);
    return captured["tests_mode"];
  }

  // The single consumer that branches on the value: the `test` agent only
  // applies under tdd.
  function testAgentApplies(testsMode: string): boolean {
    const test = codeBundle.agents.find((a) => a.name === "test");
    assert.ok(test?.applies_to !== undefined, "the test agent must declare applies_to");
    const state = { decisions: { tests_mode: testsMode } } as unknown as BundleStateView;
    return test.applies_to(state);
  }

  const HANDLED = new Set(["tdd", "regression-only"]);

  it("the classify step emits only values the planner + test agent handle", async () => {
    const tasks = [
      "add a new endpoint with TDD",          // tdd
      "write the tests first, then implement", // tdd
      "fix a typo in the README",              // regression-only
      "refactor the auth module",              // regression-only
      "bump the dependency and update config", // regression-only
    ];
    for (const task of tasks) {
      const mode = await classifyTestsMode(task);
      assert.ok(typeof mode === "string", `tests_mode should be a string for "${task}"`);
      assert.ok(HANDLED.has(mode as string), `"${task}" emitted unhandled tests_mode='${String(mode)}'`);
      assert.notEqual(mode, "after", "the divergent 'after' value must be gone");
    }
  });

  it("both handled values drive the test agent deterministically (no third case)", () => {
    assert.equal(testAgentApplies("tdd"), true, "tdd → the test agent runs");
    assert.equal(testAgentApplies("regression-only"), false, "regression-only → the test agent is filtered");
  });
});

// ============================================================================
// no-op guard — an empty (no-op) implementation must not silently auto-accept
// ============================================================================

describe("@loomfsm/bundle-code — INV_CODE_105 no-op guard", () => {
  function stateWith(opts: {
    modified_count?: number;
    created_count?: number;
    final?: { status: string; decided_by: string };
    snapshot?: boolean;
  }): BundleStateView {
    const bundle_state: Record<string, unknown> = {};
    if (opts.snapshot !== false) {
      bundle_state["diff_snapshot"] = {
        files_modified: [],
        files_created: [],
        modified_count: opts.modified_count ?? 0,
        created_count: opts.created_count ?? 0,
      };
    }
    return {
      bundle_state,
      gates: opts.final !== undefined ? { "gate-final": opts.final } : {},
    } as unknown as BundleStateView;
  }
  const snaps = {} as never;

  it("fires when an empty diff is auto-approved at the final gate", () => {
    const v = invCode105(stateWith({ final: { status: "auto-approved", decided_by: "policy" } }), snaps);
    assert.ok(v !== null);
    assert.equal(v?.code, "INV_CODE_105");
  });

  it("passes when a HUMAN approved the empty result (a deliberate no-op accept)", () => {
    assert.equal(invCode105(stateWith({ final: { status: "approved", decided_by: "human" } }), snaps), null);
  });

  it("passes when the implementation actually changed files", () => {
    const v = invCode105(stateWith({ modified_count: 2, final: { status: "auto-approved", decided_by: "policy" } }), snaps);
    assert.equal(v, null);
  });

  it("does not assert before the diff is snapshotted, or before the final gate is approved", () => {
    assert.equal(invCode105(stateWith({ snapshot: false, final: { status: "auto-approved", decided_by: "policy" } }), snaps), null);
    assert.equal(invCode105(stateWith({}), snaps), null); // no gate-final yet (e.g. the trivial flow)
  });
});
