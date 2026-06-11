import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KernelError,
  buildPrompt,
  captureNow,
  closeDb,
  resolveSpawnModel,
} from "@loomfsm/kernel";
import { loadBundle, reconcileExtensions } from "@loomfsm/loader";
import type {
  Bundle,
  BundleStateView,
  ConditionalSpawnContext,
  LLMProvider,
  NowToken,
  PipelineState,
  StageContext,
  UserAnswer,
} from "@loomfsm/kernel";

import codeBundle from "../src/bundle.js";
import {
  invCode105,
  invLintClean,
  invSafetyFloorFinal,
  invTestsPass,
  invTypecheckClean,
} from "../src/invariants.js";
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

    // 26 canonical agents: the prior 25 plus the deterministic `checks-runner`
    // (whose spawn is routed to the checks executor, not a model). The prompt map
    // keys by agent NAME, so the variants that reuse a base template still get
    // their own entry.
    assert.equal(registry.agents.size, 26);
    // Every agent's `.md` is read off disk into the prompt map at load.
    assert.equal(registry.prompts?.size, 26);
    assert.ok((registry.prompts?.get("classifier")?.body.length ?? 0) > 0);
    assert.equal(registry.flows.size, 4);
    assert.deepEqual(
      registry.flows.get("medium"),
      [
        "initialize", "classify", "classify-agent", "stack-to-bundle-state", "gate-classify",
        "enrich", "plan", "plan-review", "gate-plan",
        "git-stash", "implement", "git-diff", "run-checks", "apply-checks", "pre-review", "review",
        "adjudicate", "reconcile", "iterate", "final-checks",
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
    assert.equal(assets.length, 3);
    const refs = assets.find((a) => a.heading === "Refs catalog");
    const stack = assets.find((a) => a.heading === "Stack candidate registry");
    const contract = assets.find((a) => a.heading === "Output contract (hard validation)");
    assert.ok(refs !== undefined, "refs catalog asset materialized");
    assert.ok(stack !== undefined, "stack registry asset materialized");
    assert.ok(contract !== undefined, "output-contract asset materialized");
    assert.deepEqual(refs.agents, ["classifier"]);
    // The shared output contract is scoped to the header-emitting agents
    // (reviewers + validators) and NOT to the classifier / other producers.
    assert.ok(contract.agents?.includes("logic-reviewer"));
    assert.ok(contract.agents?.includes("acceptance"));
    assert.ok(!contract.agents?.includes("classifier"));
    assert.ok(contract.body.includes("findings[].schema_version"));
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

    // The output contract reaches a reviewer (a header-emitting agent) but not
    // the classifier — the dedup lands the shared block exactly where the inline
    // copies used to live.
    assert.ok(!classifierPrompt.includes("### Output contract (hard validation)"));
    const logicReviewer = registry.agents.get("logic-reviewer");
    assert.ok(logicReviewer !== undefined);
    const reviewerPrompt = buildPrompt(makeClassifyState(), logicReviewer, registry);
    assert.ok(reviewerPrompt.includes("### Output contract (hard validation)"));
    assert.ok(reviewerPrompt.includes("findings[].schema_version"));
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

  it("declares exactly the 26 canonical agents", () => {
    assert.equal(codeBundle.agents.length, 26);
    const names = codeBundle.agents.map((a) => a.name).sort();
    // The three CC-harness trigger agents are NOT bundle agents.
    for (const excluded of ["fe-test-all-agent", "runtime-debug-agent", "test-all-agent"]) {
      assert.ok(!names.includes(excluded), `${excluded} must not be a bundle agent`);
    }
    // The deterministic checks runner is a bundle agent (routed to the checks
    // executor, not a model).
    assert.ok(names.includes("checks-runner"));
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

  const ALWAYS_ON = [
    "logic-reviewer", "logic-reviewer-deep",
    "challenger-reviewer", "challenger-reviewer-deep",
    "style-reviewer", "performance",
  ];

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
// differentiated rework panel — a rework round re-runs only the reviewers
// that blocked last round (a style-only blocker does not re-run the panel)
// ============================================================================

describe("@loomfsm/bundle-code — differentiated rework panel", () => {
  interface VerdictRow {
    phase: string;
    agent: string;
    iteration: number;
    blocking_issues: number;
  }

  // Whether a reviewer's applies_to admits it given the prior rounds' verdicts.
  function reviewerApplies(
    name: string,
    decisions: Record<string, unknown>,
    agent_verdicts: VerdictRow[],
  ): boolean {
    const agent = codeBundle.agents.find((a) => a.name === name);
    assert.ok(agent?.applies_to !== undefined, `${name} must declare applies_to`);
    const state = { decisions, agent_verdicts } as unknown as BundleStateView;
    return agent.applies_to(state);
  }

  function verdict(agent: string, blocking: number, iteration = 1): VerdictRow {
    return { phase: "implementation", agent, iteration, blocking_issues: blocking };
  }

  const SRC = { source_changed: true };

  it("first pass (no implementation verdicts) runs the full panel", () => {
    for (const name of ["logic-reviewer", "challenger-reviewer", "style-reviewer", "performance"]) {
      assert.equal(reviewerApplies(name, SRC, []), true, `${name} runs on the first pass`);
    }
  });

  it("a rework round re-runs ONLY the reviewers that blocked last round", () => {
    // Round 1: logic blocked, the others approved (0 blocking).
    const round1 = [
      verdict("logic-reviewer", 2),
      verdict("challenger-reviewer", 0),
      verdict("style-reviewer", 0),
      verdict("performance", 0),
    ];
    assert.equal(reviewerApplies("logic-reviewer", SRC, round1), true, "the blocker re-verifies");
    assert.equal(reviewerApplies("challenger-reviewer", SRC, round1), false, "a clean reviewer is skipped");
    assert.equal(reviewerApplies("style-reviewer", SRC, round1), false);
    assert.equal(reviewerApplies("performance", SRC, round1), false);
  });

  it("a style-only round re-runs only the style reviewer", () => {
    const styleOnly = [
      verdict("logic-reviewer", 0),
      verdict("challenger-reviewer", 0),
      verdict("style-reviewer", 1),
      verdict("performance", 0),
    ];
    assert.equal(reviewerApplies("style-reviewer", SRC, styleOnly), true);
    assert.equal(reviewerApplies("logic-reviewer", SRC, styleOnly), false);
    assert.equal(reviewerApplies("challenger-reviewer", SRC, styleOnly), false);
  });

  it("a rework with no reviewer blocker (e.g. acceptance-only failure) re-reviews fully", () => {
    const noBlockers = [verdict("logic-reviewer", 0), verdict("style-reviewer", 0)];
    assert.equal(reviewerApplies("logic-reviewer", SRC, noBlockers), true);
    assert.equal(reviewerApplies("challenger-reviewer", SRC, noBlockers), true);
    assert.equal(reviewerApplies("style-reviewer", SRC, noBlockers), true);
  });

  it("keys off the LATEST round, and ignores planning-phase verdicts", () => {
    // Round 1 logic blocked; round 2 challenger blocked. The current (round-3)
    // re-run should admit only the round-2 blocker (challenger). A stray
    // planning verdict must not influence the implementation rework.
    const verdicts = [
      verdict("logic-reviewer", 1, 1),
      verdict("challenger-reviewer", 0, 1),
      verdict("logic-reviewer", 0, 2),
      verdict("challenger-reviewer", 3, 2),
      { phase: "planning", agent: "logic-reviewer", iteration: 9, blocking_issues: 5 },
    ];
    assert.equal(reviewerApplies("challenger-reviewer", SRC, verdicts), true, "round-2 blocker re-runs");
    assert.equal(reviewerApplies("logic-reviewer", SRC, verdicts), false, "no longer blocking at round 2");
  });

  it("still honours the source_changed / security_needed gate on a rework round", () => {
    // A doc-only outcome skips the panel even if a reviewer blocked last round.
    const blocked = [verdict("logic-reviewer", 1)];
    assert.equal(reviewerApplies("logic-reviewer", { source_changed: false }, blocked), false);
  });
});

// ============================================================================
// complexity-scaled review-path models — the medium flow reviews on the
// balanced tier, the complex flow on premium, via per-flow `-deep` variants
// ============================================================================

describe("@loomfsm/bundle-code — review model scales with complexity", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  // The fanout agent list for a stage, read off the assembled registry.
  function fanoutAgents(registry: { stages?: Map<string, unknown> }, name: string): string[] {
    const stage = registry.stages?.get(name) as { kind?: string; agents?: string[] } | undefined;
    assert.ok(stage?.kind === "fanout", `stage '${name}' must be a fanout`);
    return stage.agents ?? [];
  }

  it("wires balanced reviewers into medium and premium `-deep` reviewers into complex", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);
    const registry = await loadBundle({
      bundle: codeBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });

    // The medium flow reviews with the base (balanced) logic + challenger; the
    // complex flow swaps in the `-deep` (premium) variants. The cheaper
    // file-conditional validators are shared, unchanged.
    assert.ok(fanoutAgents(registry, "review").includes("logic-reviewer"));
    assert.ok(fanoutAgents(registry, "review").includes("challenger-reviewer"));
    assert.ok(!fanoutAgents(registry, "review").includes("logic-reviewer-deep"));
    assert.ok(fanoutAgents(registry, "review-deep").includes("logic-reviewer-deep"));
    assert.ok(fanoutAgents(registry, "review-deep").includes("challenger-reviewer-deep"));
    assert.ok(!fanoutAgents(registry, "review-deep").includes("logic-reviewer"));

    // T3: the plan-stage logic review scales the same way.
    assert.deepEqual(fanoutAgents(registry, "plan-review"), ["plan-grounding-check", "logic-reviewer"]);
    assert.deepEqual(fanoutAgents(registry, "plan-review-deep"), ["plan-grounding-check", "logic-reviewer-deep"]);

    // The flows select the matching stage — medium the balanced fanouts,
    // complex the premium `-deep` fanouts.
    const medium = registry.flows.get("medium") ?? [];
    assert.ok(medium.includes("review") && medium.includes("plan-review"));
    assert.ok(!medium.includes("review-deep") && !medium.includes("plan-review-deep"));
    const complex = registry.flows.get("complex") ?? [];
    assert.ok(complex.includes("review-deep") && complex.includes("plan-review-deep"));
    assert.ok(!complex.includes("review") && !complex.includes("plan-review"));

    // The whole point: the SAME review role resolves to a cheaper model on the
    // medium flow and the premium model on the complex flow. resolveSpawnModel
    // maps the agent's declared tier through default_model_tiers
    // (balanced→sonnet, premium→opus) when no per-agent provider route overrides.
    const state = makeClassifyState();
    assert.equal(resolveSpawnModel(registry, "logic-reviewer", "implementation", state), "sonnet");
    assert.equal(resolveSpawnModel(registry, "challenger-reviewer", "implementation", state), "sonnet");
    assert.equal(resolveSpawnModel(registry, "logic-reviewer-deep", "implementation", state), "opus");
    assert.equal(resolveSpawnModel(registry, "challenger-reviewer-deep", "implementation", state), "opus");
    // T3: plan-stage logic review, same split.
    assert.equal(resolveSpawnModel(registry, "logic-reviewer", "planning", state), "sonnet");
    assert.equal(resolveSpawnModel(registry, "logic-reviewer-deep", "planning", state), "opus");
  });

  it("resolves the design-advisory architect to the balanced model, not premium", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);
    const registry = await loadBundle({
      bundle: codeBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });
    // The architect only advises (it writes architecture-decisions.md, never
    // code) and is biased toward the smallest design — so it runs the balanced
    // tier (sonnet). Planning tier scales with complexity: the base `planner`
    // (simple/medium) is balanced (sonnet); only the complex flow's `planner-deep`
    // is premium (opus). The implementer that turns the plan into code stays
    // premium (opus).
    const state = makeClassifyState();
    assert.equal(resolveSpawnModel(registry, "architect", "context", state), "sonnet");
    assert.equal(resolveSpawnModel(registry, "planner", "planning", state), "sonnet");
    assert.equal(resolveSpawnModel(registry, "planner-deep", "planning", state), "opus");
    assert.equal(resolveSpawnModel(registry, "implementer", "implementation", state), "opus");
  });

  it("gate-plan revise walks back to the flow's planner stage (plan-deep for complex, plan otherwise)", async () => {
    const stage = codeBundle.stages["gate-plan"];
    assert.ok(stage?.kind === "gate" && stage.on_resume !== undefined, "gate-plan has an on_resume");
    const onResume = stage.on_resume;
    const view = (complexity: string): BundleStateView =>
      ({ decisions: { complexity }, task_id: "t-1" }) as unknown as BundleStateView;
    const revise = { decision: "reject", reject_intent: "revise" } as unknown as UserAnswer;
    const ctx = {} as unknown as StageContext;

    const complexRes = await onResume(view("complex"), revise, ctx);
    assert.equal(complexRes.type, "walk_back_to");
    if (complexRes.type === "walk_back_to") assert.equal(complexRes.step, "plan-deep");

    for (const c of ["simple", "medium"]) {
      const res = await onResume(view(c), revise, ctx);
      assert.equal(res.type, "walk_back_to");
      if (res.type === "walk_back_to") assert.equal(res.step, "plan", `${c} → plan`);
    }
    // The walk-back targets must actually be in the flows they serve, or the
    // substrate's WALK_BACK_TARGET_NOT_FOUND guard would reject the revise.
    assert.ok(codeBundle.flows["complex"]?.includes("plan-deep"));
    assert.ok(codeBundle.flows["medium"]?.includes("plan"));
    assert.ok(codeBundle.flows["simple"]?.includes("plan"));
  });
});

// ============================================================================
// the adversarial challenger gates on change_kind — dropped on a change with
// no logical-correctness-under-stress surface (config/docs/type-only/refactor)
// ============================================================================

describe("@loomfsm/bundle-code — challenger gates on change_kind", () => {
  // Replicate the kernel fanout's documented change-kind filter contract
  // (stages/fanout.ts): for a fanout with filter_by_change_kind, an agent that
  // declares relevant_for_change_kinds is DROPPED when the run's change_kind is
  // known and not listed; an unset/unknown change_kind drops no one.
  function agentRunsForKind(name: string, changeKind: string | null): boolean {
    const agent = codeBundle.agents.find((a) => a.name === name);
    assert.ok(agent !== undefined, `${name} must be a declared agent`);
    const relevant = agent.relevant_for_change_kinds;
    if (changeKind === null) return true; // filter is a no-op on unknown kind
    if (relevant === undefined) return true; // no gate → always runs
    return relevant.includes(changeKind);
  }

  it("the review fanout opts into change-kind filtering", () => {
    const review = codeBundle.stages["review"];
    assert.ok(review?.kind === "fanout" && review.filter_by_change_kind === true);
    const reviewDeep = codeBundle.stages["review-deep"];
    assert.ok(reviewDeep?.kind === "fanout" && reviewDeep.filter_by_change_kind === true);
  });

  it("drops the challenger on config-only / docs-only / refactor, keeps it on logic / perf / security", () => {
    for (const challenger of ["challenger-reviewer", "challenger-reviewer-deep"]) {
      // No logical-correctness surface → dropped.
      assert.equal(agentRunsForKind(challenger, "config-only"), false, `${challenger} skips config-only`);
      assert.equal(agentRunsForKind(challenger, "docs-only"), false, `${challenger} skips docs-only`);
      assert.equal(agentRunsForKind(challenger, "type-only"), false, `${challenger} skips type-only`);
      assert.equal(agentRunsForKind(challenger, "refactor"), false, `${challenger} skips pure refactor`);
      // Risk surface → runs.
      assert.equal(agentRunsForKind(challenger, "logic"), true, `${challenger} runs on logic`);
      assert.equal(agentRunsForKind(challenger, "perf-sensitive"), true, `${challenger} runs on perf`);
      assert.equal(agentRunsForKind(challenger, "security-sensitive"), true, `${challenger} runs on security`);
      // Unknown/unset change_kind never lowers scrutiny.
      assert.equal(agentRunsForKind(challenger, null), true, `${challenger} runs when change_kind unknown`);
    }
  });

  it("the core logic-reviewer is never gated by change_kind (runs on any kind)", () => {
    // logic-reviewer carries no relevant_for_change_kinds, so a config-only or
    // docs-only change still gets the baseline logic review — the change_kind
    // gate only ever sheds the EXTRA adversarial pass, never the core.
    for (const kind of ["config-only", "docs-only", "refactor", "logic", null]) {
      assert.equal(agentRunsForKind("logic-reviewer", kind), true, `logic-reviewer runs on ${String(kind)}`);
      assert.equal(agentRunsForKind("logic-reviewer-deep", kind), true, `logic-reviewer-deep runs on ${String(kind)}`);
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
    // Defaults to the full-autonomous posture the guard engages under; pass
    // "on-blockers" to assert the honest baseline does NOT park a no-op.
    finalPolicy?: string;
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
      gate_policies: { final: opts.finalPolicy ?? "auto" },
      gates: opts.final !== undefined ? { "gate-final": opts.final } : {},
    } as unknown as BundleStateView;
  }
  const snaps = {} as never;

  it("fires when an empty diff is auto-approved at a full-autonomous final gate", () => {
    const v = invCode105(stateWith({ final: { status: "auto-approved", decided_by: "policy" } }), snaps);
    assert.ok(v !== null);
    assert.equal(v?.code, "INV_CODE_105");
  });

  it("does NOT park a no-op under the on-blockers baseline (the M8 summary is the signal)", () => {
    // The honest baseline auto-approves a clean run — including a no-op — and
    // the completion summary surfaces "No file changes were recorded". Parking
    // here would falsely veto every did-little on-blockers run.
    assert.equal(
      invCode105(stateWith({ finalPolicy: "on-blockers", final: { status: "auto-approved", decided_by: "policy" } }), snaps),
      null,
    );
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

// ============================================================================
// safety floor — the deterministic boundary that makes `final: auto` defensible
// ============================================================================

describe("@loomfsm/bundle-code — safety floor (INV_lint_clean / INV_tests_pass / INV_typecheck_clean)", () => {
  // A state at a full-autonomous final-gate approval, with the floor's status
  // fields set to whatever the case under test needs. `finalPolicy` defaults to
  // `auto` (the only posture the floor engages under).
  function floorState(opts: {
    finalPolicy?: string;
    lint?: unknown;
    test_run?: unknown;
    typecheck?: unknown;
  }): BundleStateView {
    const bundle_state: Record<string, unknown> = {};
    if (opts.lint !== undefined) bundle_state["lint_result"] = opts.lint;
    if (opts.test_run !== undefined) bundle_state["test_run"] = opts.test_run;
    if (opts.typecheck !== undefined) bundle_state["typecheck"] = opts.typecheck;
    return {
      bundle_state,
      gate_policies: { final: opts.finalPolicy ?? "auto" },
      gates: { "gate-final": { status: "auto-approved", decided_by: "policy" } },
    } as unknown as BundleStateView;
  }
  const snaps = {} as never;
  const ok = { status: "ok" };

  it("vetoes a full-autonomous final approve when lint_result is MISSING", () => {
    // The code bundle ships no writer for lint_result, so a real `final: auto`
    // run reaches the gate with the field absent — and the floor must veto it.
    // Before the wiring landed this invariant never ran, so the auto gate
    // closed regardless. This is the dormant-floor regression.
    const v = invLintClean(floorState({}), snaps);
    assert.equal(v?.code, "INV_lint_clean");
  });

  it("vetoes a full-autonomous final approve when lint FAILED", () => {
    const v = invLintClean(floorState({ lint: { status: "failed" } }), snaps);
    assert.equal(v?.code, "INV_lint_clean");
  });

  it("passes when lint is ok", () => {
    assert.equal(invLintClean(floorState({ lint: ok }), snaps), null);
  });

  it("test/typecheck floor mirror lint", () => {
    assert.equal(invTestsPass(floorState({ test_run: { status: "failed" } }), snaps)?.code, "INV_tests_pass");
    assert.equal(invTestsPass(floorState({ test_run: ok }), snaps), null);
    assert.equal(invTypecheckClean(floorState({ typecheck: { status: "failed" } }), snaps)?.code, "INV_typecheck_clean");
    assert.equal(invTypecheckClean(floorState({ typecheck: ok }), snaps), null);
  });

  it("stays DORMANT under the honest baseline (final policy on-blockers)", () => {
    // The whole point of the baseline: the human-or-blocker gate is the
    // boundary, so the floor must not demand status fields the bundle never
    // wrote. A clean on-blockers run with no lint_result still completes.
    assert.equal(invLintClean(floorState({ finalPolicy: "on-blockers" }), snaps), null);
    assert.equal(invTestsPass(floorState({ finalPolicy: "on-blockers" }), snaps), null);
    assert.equal(invTypecheckClean(floorState({ finalPolicy: "on-blockers" }), snaps), null);
    assert.equal(invSafetyFloorFinal(floorState({ finalPolicy: "on-blockers" }), snaps), null);
  });

  it("the composite INV_safety_floor_final surfaces the first failing check", () => {
    // All three missing → the composite returns the lint failure first (the
    // single registered anchor the loader matches by function name).
    const v = invSafetyFloorFinal(floorState({}), snaps);
    assert.equal(v?.code, "INV_lint_clean");
    // All three ok → clean.
    assert.equal(
      invSafetyFloorFinal(floorState({ lint: ok, test_run: ok, typecheck: ok }), snaps),
      null,
    );
  });
});

// ============================================================================
// per-agent category vocab is delivered inline — each finding-emitting prompt
// carries its OWN allowlist from schemas/category-vocab.json (the single
// source). The prompt renderer injects no category list, so the prompt must
// carry it; this guards the drift that would re-open if a prompt's inline list
// and the JSON diverged.
// ============================================================================

describe("@loomfsm/bundle-code — per-agent category vocab is inlined from the single source", () => {
  // Template file → its category-vocab.json key. The two `-deep` reviewer
  // variants reuse these base templates, so the base entry covers both.
  const VOCAB_BY_TEMPLATE: Record<string, string> = {
    "logic-reviewer.md": "logic-reviewer",
    "challenger-reviewer.md": "challenger-reviewer",
    "style-reviewer.md": "style-reviewer",
    "security.md": "security",
    "performance.md": "performance",
    "acceptance.md": "acceptance",
    "plan-conformance.md": "plan-conformance",
    "plan-grounding-check.md": "plan-grounding-check",
    "context-doc-verifier.md": "context-doc-verifier",
    "ui-consistency.md": "ui-consistency",
    "api-contract.md": "api-contract",
    "playwright.md": "playwright",
    "test.md": "test",
    "adjudicator.md": "adjudicator",
  };

  function loadVocab(): Record<string, string[]> {
    const raw = readFileSync(join(PKG_ROOT, "schemas", "category-vocab.json"), "utf8");
    return (JSON.parse(raw) as { vocab: Record<string, string[]> }).vocab;
  }

  // Pull the inlined list out of a prompt: the first non-blank line AFTER the
  // "Allowed `category` values for ..." marker is the comma-separated list.
  function inlinedCategories(file: string): string[] {
    const lines = readFileSync(join(PKG_ROOT, "agents", file), "utf8").split("\n");
    const markerIdx = lines.findIndex((l) => l.includes("Allowed `category` values for"));
    assert.ok(markerIdx !== -1, `${file} must carry the inline category marker`);
    let listIdx = -1;
    for (let i = markerIdx + 1; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() !== "") {
        listIdx = i;
        break;
      }
    }
    assert.ok(listIdx !== -1, `${file}: marker must be followed by a values line`);
    return (lines[listIdx] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  it("every finding-emitting prompt inlines exactly its category-vocab.json allowlist", () => {
    const vocab = loadVocab();
    for (const [file, key] of Object.entries(VOCAB_BY_TEMPLATE)) {
      const expected = vocab[key];
      assert.ok(expected !== undefined, `category-vocab.json must define vocab['${key}']`);
      assert.deepEqual(
        inlinedCategories(file),
        expected,
        `${file} inline list must equal category-vocab.json vocab['${key}'] (vocab is the single source)`,
      );
    }
  });

  it("no prompt still claims the driver injects the category values (the removed phantom)", () => {
    for (const file of Object.keys(VOCAB_BY_TEMPLATE)) {
      const body = readFileSync(join(PKG_ROOT, "agents", file), "utf8");
      assert.ok(
        !/injected\s+(?:inline\s+)?(?:by the driver|under "## Allowed)/i.test(body),
        `${file} must not claim category values are injected by the driver`,
      );
    }
  });
});

// ============================================================================
// surgical context-loading — the analyzer and implementer prompts scope their
// reads to the affected set + task targets instead of sweeping the tree. A
// regression guard so the scoping guidance can't silently revert to a sweep.
// ============================================================================

describe("@loomfsm/bundle-code — analyzer/implementer prompts scope their reads", () => {
  function body(file: string): string {
    return readFileSync(join(PKG_ROOT, "agents", file), "utf8");
  }

  it("code-analyzer reads the affected set + task targets, not the whole tree", () => {
    const b = body("code-analyzer.md");
    assert.match(b, /affected set/i);
    assert.match(b, /do not sweep the tree/i);
  });

  it("implementer reads the plan/context-doc targets, not the whole tree", () => {
    const b = body("implementer.md");
    assert.match(b, /Read scope \(surgical\)/);
    assert.match(b, /don't re-sweep/i);
  });
});
