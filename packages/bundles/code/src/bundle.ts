// Code-review / implementation bundle — declarative wiring.
//
// This file is the whole orchestration: phases, the agent roster, the
// stage graph, three flows of increasing rigor, the gate vocabulary, the
// post-commit observers, and the domain invariants. Reading it top to
// bottom tells you what a code task does. The substrate is declarative,
// so the wiring is compact; the weight is in the helper bodies (gate
// messages, deterministic state derivations) and in the migrated content
// (agent prompts, schemas, knowledge) that live beside this file.
//
// Applicability lives on the AGENT, not the stage: the substrate's
// SpawnStage is intentionally just {kind,name,phase,agent}, so a stage
// never carries its own condition. Every agent that runs only under some
// state shape declares one `applies_to` predicate; an agent reused across
// stages keeps a single, collision-free responsibility.

import { defineBundle } from "@loom/kernel";
import type {
  BundleStateView,
  HookContext,
  StageContext,
  StageResult,
  UserAnswer,
  UserAnswerSchema,
} from "@loom/kernel";

import { codeBundleInvariants } from "./invariants.js";
import { codePolicyResolver } from "./policy-resolver.js";

// ============================================================================
// Decision helpers — pure reads over the narrow state projection
// ============================================================================

function decisionEquals(state: BundleStateView, key: string, value: unknown): boolean {
  return state.decisions[key] === value;
}

// ============================================================================
// Positional StepStage run bodies — deterministic state derivation only.
//
// A `run` body executes inside the stage transaction: no shell-out, no
// network, no LLM call, no clock. It derives state from what the substrate
// already tracks and writes through the scratch façade. The kernel may
// re-enter a Step after a crash, so each body is idempotent against its
// own prior committed effect.
// ============================================================================

async function writeClassifyDecisions(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  const task = state.task.toLowerCase();
  const len = task.length;
  let complexity: "simple" | "medium" | "complex";
  if (/\b(refactor|migrate|migration|architecture|redesign|rewrite)\b/.test(task) || len > 400) {
    complexity = "complex";
  } else if (len < 120 && /\b(typo|rename|bump|comment|docs?|readme)\b/.test(task)) {
    complexity = "simple";
  } else {
    complexity = "medium";
  }
  const tests_mode = /\btdd\b|tests? first|test-first/.test(task) ? "tdd" : "after";
  ctx.tx.set_decision?.("complexity", complexity);
  ctx.tx.set_decision?.("tests_mode", tests_mode);
}

// Derive the review-shaping flags from the substrate's own file accounting
// (which paths the run has touched). The reviewer fanout reads these via
// each reviewer agent's `applies_to`.
async function derivePreReview(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  const files = state.files_modified;
  const ui_touched = files.some((f) =>
    /\.(tsx|jsx|vue|svelte|css|scss|html)$|(^|\/)components?\//i.test(f),
  );
  const api_touched = files.some((f) =>
    /(^|\/)(api|routes?|controllers?|endpoints?|handlers?)\/|\.(proto|graphql)$|openapi|schema/i.test(f),
  );
  const security_needed = files.some((f) =>
    /(auth|login|password|secret|token|crypto|session|permission|acl|jwt)/i.test(f),
  );
  ctx.tx.set_decision?.("ui_touched", ui_touched);
  ctx.tx.set_decision?.("api_touched", api_touched);
  ctx.tx.set_decision?.("security_needed", security_needed);
}

// Snapshot the substrate's file accounting for the reviewer fanout to read.
// This is a snapshot of what the run has touched, not a raw VCS diff — the
// VCS diff itself is the host's to gather; the bundle records the
// substrate-tracked surface so reviewers see a stable, replayable picture.
async function snapshotDiff(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  ctx.tx.set_bundle_state_field?.("diff_snapshot", {
    files_modified: state.files_modified,
    files_created: state.files_created,
    modified_count: state.files_modified.length,
    created_count: state.files_created.length,
  });
}

// Sacred-tests check: record which test files the run modified, so the
// final-gate invariant can refuse a silent auto-approve of work that
// rewrote its own tests. Deterministic over the file accounting.
async function verifyTestFileHashes(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  const TEST_FILE = /(^|\/)(tests?|specs?|__tests__)\/|\.(test|spec)\.[a-z]+$/i;
  const touched = state.files_modified.filter((f) => TEST_FILE.test(f));
  ctx.tx.set_bundle_state_field?.("test_files_modified_by_implementer", touched);
  ctx.tx.audit({ type: "sacred-tests-checked", modified_test_files: touched.length });
}

// ============================================================================
// Gate messages, answer schemas, and resume control flow
// ============================================================================

const APPROVE_OPTION = {
  verbs: ["approve", "yes", "y", "lgtm"],
  label: "Approve",
  produces: { decision: "accept" as const },
};
const REVISE_OPTION = {
  verbs: ["revise", "changes", "rework"],
  label: "Request changes",
  produces: { decision: "reject" as const, reject_intent: "revise" as const, requires_message: true },
};
const ABANDON_OPTION = {
  verbs: ["abandon", "stop", "cancel"],
  label: "Abandon task",
  produces: { decision: "reject" as const, reject_intent: "abandon" as const },
};

function taskLabel(state: BundleStateView): string {
  return state.task_short ?? state.task;
}

function gateClassifyMsg(state: BundleStateView): string {
  const complexity = String(state.decisions["complexity"] ?? "unknown");
  const tests = String(state.decisions["tests_mode"] ?? "unknown");
  return `Classification ready for "${taskLabel(state)}": complexity=${complexity}, tests=${tests}. Approve to proceed to planning, or request changes.`;
}
function classifyGateAnswers(_state: BundleStateView): UserAnswerSchema {
  return { options: [APPROVE_OPTION, REVISE_OPTION] };
}

function gatePlanMsg(state: BundleStateView): string {
  return `Plan ready for "${taskLabel(state)}". Approve to begin implementation, request changes to revise the plan, or abandon.`;
}
function planGateAnswers(_state: BundleStateView): UserAnswerSchema {
  return { options: [APPROVE_OPTION, REVISE_OPTION, ABANDON_OPTION] };
}
async function gatePlanResume(
  state: BundleStateView,
  answer: UserAnswer,
  _ctx: StageContext,
): Promise<StageResult> {
  if (answer.decision === "accept") return { type: "advance" };
  if (answer.reject_intent === "abandon") {
    return {
      type: "complete",
      directive: { task_id: state.task_id, verdict: "rejected", summary: "plan abandoned at gate-plan" },
    };
  }
  return { type: "walk_back_to", step: "plan", reason: "plan rejected — revising" };
}

function gateFinalMsg(state: BundleStateView): string {
  return `Implementation complete for "${taskLabel(state)}". Approve to finalize, request changes to iterate, or abandon.`;
}
function finalGateAnswers(_state: BundleStateView): UserAnswerSchema {
  return { options: [APPROVE_OPTION, REVISE_OPTION, ABANDON_OPTION] };
}
async function gateFinalResume(
  state: BundleStateView,
  answer: UserAnswer,
  _ctx: StageContext,
): Promise<StageResult> {
  if (answer.decision === "accept") return { type: "advance" };
  if (answer.reject_intent === "abandon") {
    return {
      type: "complete",
      directive: { task_id: state.task_id, verdict: "rejected", summary: "task abandoned at gate-final" },
    };
  }
  return { type: "walk_back_to", step: "implement", reason: "final review rejected — re-implementing" };
}

// ============================================================================
// Post-commit observers — side-effect-only, idempotent, no kernel writes
// ============================================================================

async function observeImplementerOutput(ctx: HookContext): Promise<void> {
  const out = ctx.agent_output ?? "";
  const hasDebtSignal = /\b(TODO|FIXME|HACK|XXX)\b/.test(out) || /tech[ -]?debt/i.test(out);
  if (hasDebtSignal) {
    await ctx.emit_event("tech-debt-signal", { agent: ctx.agent ?? "implementer" });
  }
}

async function observeReviewFanout(ctx: HookContext): Promise<void> {
  await ctx.emit_event("review-fanout-observed", { stage: ctx.stage ?? "review" });
}

// ============================================================================
// Bundle declaration
// ============================================================================

export default defineBundle({
  name: "code",
  version: "3.0.0",
  description:
    "Code generation pipeline — classify, plan, implement, multi-reviewer fanout, gate, and finalize across TypeScript / Python / Go / Rust and friends.",

  phases: ["context", "planning", "test_first", "implementation", "validation", "final"],
  default_flow: "medium",

  // Honest baseline: every role gates on open blockers. A deployment may
  // override any role to `auto` (full-autonomous) per task or via preset;
  // the policyResolver + safety-floor invariants below make that path
  // load cleanly and stay defensible.
  default_gate_policies: { classify: "on-blockers", plan: "on-blockers", final: "on-blockers" },
  policyResolver: codePolicyResolver,
  replan_budget: { kind: "attempt", max_iterations: 3, on_exhaustion: "human" },

  // The default zero-config provider (no API key) — a deployment can route
  // elsewhere by registering another provider and overriding at run time.
  default_provider: "claude-code-shuttle",

  gate_roles: {
    "gate-classify": "classify",
    "gate-plan": "plan",
    "gate-final": "final",
  },

  declared_change_kinds: [
    "logic",
    "ui",
    "perf-sensitive",
    "security-sensitive",
    "config-only",
    "docs-only",
    "refactor",
    "deps",
  ],

  extends_vocab: {
    error_classes: [
      "impl-blockers",
      "classifier-intent-vs-diff-mismatch",
      "reviewer-skipped-change-kind",
      "auto-close-validation",
      "auto-close-final",
      "llm-classification-needed",
    ],
  },

  agents: [
    { name: "classifier", template_path: "agents/classifier.md", output_kind: "classifier", default_model: "fast" },
    { name: "planner", template_path: "agents/planner.md", output_kind: "nonreview", default_model: "premium" },
    { name: "implementer", template_path: "agents/implementer.md", output_kind: "nonreview", default_model: "premium" },
    { name: "code-analyzer", template_path: "agents/code-analyzer.md", output_kind: "nonreview", default_model: "balanced" },
    {
      name: "architect",
      template_path: "agents/architect.md",
      output_kind: "nonreview",
      default_model: "premium",
      applies_to: (s) => decisionEquals(s, "complexity", "complex"),
    },
    { name: "logic-reviewer", template_path: "agents/logic-reviewer.md", output_kind: "reviewer", default_model: "premium" },
    { name: "challenger-reviewer", template_path: "agents/challenger-reviewer.md", output_kind: "reviewer", default_model: "premium" },
    {
      name: "style-reviewer",
      template_path: "agents/style-reviewer.md",
      output_kind: "reviewer",
      default_model: "fast",
      relevant_for_change_kinds: ["logic", "ui", "perf-sensitive", "security-sensitive"],
    },
    {
      name: "security",
      template_path: "agents/security.md",
      output_kind: "reviewer",
      default_model: "balanced",
      applies_to: (s) => s.decisions["security_needed"] !== false,
      relevant_for_change_kinds: ["logic", "ui", "security-sensitive", "perf-sensitive", "config-only"],
    },
    {
      name: "performance",
      template_path: "agents/performance.md",
      output_kind: "reviewer",
      default_model: "balanced",
      relevant_for_change_kinds: ["logic", "ui", "perf-sensitive", "security-sensitive"],
    },
    { name: "plan-grounding-check", template_path: "agents/plan-grounding-check.md", output_kind: "validator", default_model: "fast" },
    { name: "plan-conformance", template_path: "agents/plan-conformance.md", output_kind: "validator", default_model: "fast" },
    {
      name: "context-doc-verifier",
      template_path: "agents/context-doc-verifier.md",
      output_kind: "validator",
      default_model: "fast",
      applies_to: (s) => !decisionEquals(s, "complexity", "simple"),
    },
    { name: "acceptance", template_path: "agents/acceptance.md", output_kind: "validator", default_model: "fast" },
    {
      name: "test",
      template_path: "agents/test.md",
      output_kind: "validator",
      default_model: "fast",
      applies_to: (s) => decisionEquals(s, "tests_mode", "tdd"),
    },
    {
      name: "ui-consistency",
      template_path: "agents/ui-consistency.md",
      output_kind: "validator",
      default_model: "fast",
      applies_to: (s) => decisionEquals(s, "ui_touched", true),
    },
    {
      name: "api-contract",
      template_path: "agents/api-contract.md",
      output_kind: "validator",
      default_model: "fast",
      applies_to: (s) => decisionEquals(s, "api_touched", true),
    },
    {
      name: "playwright",
      template_path: "agents/playwright.md",
      output_kind: "validator",
      default_model: "fast",
      applies_to: (s) => decisionEquals(s, "ui_touched", true),
    },
    { name: "research", template_path: "agents/research.md", output_kind: "nonreview", default_model: "premium" },
    { name: "migration", template_path: "agents/migration.md", output_kind: "nonreview", default_model: "premium" },
    { name: "dependency-auditor", template_path: "agents/dependency-auditor.md", output_kind: "nonreview", default_model: "fast" },
  ],

  stages: {
    initialize: { kind: "step", name: "initialize", phase: "context", position: "positional", effects: [] },
    classify: {
      kind: "step",
      name: "classify",
      phase: "context",
      position: "positional",
      effects: [
        { kind: "decisions.set", key: "complexity" },
        { kind: "decisions.set", key: "tests_mode" },
      ],
      run: writeClassifyDecisions,
    },
    "classify-agent": { kind: "spawn", name: "classify-agent", phase: "context", agent: "classifier" },
    "gate-classify": { kind: "gate", name: "gate-classify", phase: "context", message: gateClassifyMsg, valid_answers: classifyGateAnswers },
    enrich: { kind: "spawn", name: "enrich", phase: "context", agent: "code-analyzer" },
    "context-verify": { kind: "spawn", name: "context-verify", phase: "context", agent: "context-doc-verifier" },
    architect: { kind: "spawn", name: "architect", phase: "context", agent: "architect" },
    plan: { kind: "spawn", name: "plan", phase: "planning", agent: "planner" },
    "plan-grounding": { kind: "spawn", name: "plan-grounding", phase: "planning", agent: "plan-grounding-check" },
    "plan-review": {
      kind: "fanout",
      name: "plan-review",
      phase: "planning",
      agents: ["plan-grounding-check", "logic-reviewer"],
      iteration_budget: { kind: "attempt", max_iterations: 2, on_exhaustion: "audit-only" },
    },
    "gate-plan": {
      kind: "gate",
      name: "gate-plan",
      phase: "planning",
      message: gatePlanMsg,
      valid_answers: planGateAnswers,
      on_resume: gatePlanResume,
    },
    "test-first": { kind: "spawn", name: "test-first", phase: "test_first", agent: "test" },
    "git-stash": { kind: "step", name: "git-stash", phase: "implementation", position: "positional", effects: [] },
    implement: { kind: "spawn", name: "implement", phase: "implementation", agent: "implementer" },
    "git-diff": {
      kind: "step",
      name: "git-diff",
      phase: "implementation",
      position: "positional",
      effects: [{ kind: "bundle_state.set", path: "diff_snapshot" }],
      run: snapshotDiff,
    },
    "pre-review": {
      kind: "step",
      name: "pre-review",
      phase: "implementation",
      position: "positional",
      effects: [
        { kind: "decisions.set", key: "security_needed" },
        { kind: "decisions.set", key: "ui_touched" },
        { kind: "decisions.set", key: "api_touched" },
      ],
      run: derivePreReview,
    },
    review: {
      kind: "fanout",
      name: "review",
      phase: "implementation",
      agents: ["logic-reviewer", "challenger-reviewer", "style-reviewer", "security", "performance"],
      filter_by_change_kind: true,
      iteration_budget: { kind: "attempt", max_iterations: 3, on_exhaustion: "audit-only" },
    },
    reconcile: { kind: "step", name: "reconcile", phase: "implementation", position: "positional", effects: [] },
    iterate: { kind: "step", name: "iterate", phase: "implementation", position: "positional", effects: [] },
    "sacred-tests": {
      kind: "step",
      name: "sacred-tests",
      phase: "implementation",
      position: "positional",
      effects: [
        { kind: "audit.emit", type: "sacred-tests-checked" },
        { kind: "bundle_state.set", path: "test_files_modified_by_implementer" },
      ],
      run: verifyTestFileHashes,
    },
    "final-checks": { kind: "spawn", name: "final-checks", phase: "validation", agent: "acceptance" },
    "test-verify": { kind: "step", name: "test-verify", phase: "validation", position: "positional", effects: [] },
    "gate-final": {
      kind: "gate",
      name: "gate-final",
      phase: "validation",
      message: gateFinalMsg,
      valid_answers: finalGateAnswers,
      on_resume: gateFinalResume,
    },
    finalize: { kind: "finalize", name: "finalize" },
  },

  flows: {
    simple: [
      "initialize", "classify", "classify-agent",
      "plan", "plan-grounding", "implement", "git-diff", "pre-review",
      "review", "final-checks", "gate-final", "finalize",
    ],
    medium: [
      "initialize", "classify", "classify-agent", "gate-classify",
      "enrich", "plan", "plan-review", "gate-plan",
      "git-stash", "implement", "git-diff", "pre-review", "review",
      "reconcile", "iterate", "final-checks", "test-verify",
      "gate-final", "finalize",
    ],
    complex: [
      "initialize", "classify", "classify-agent", "gate-classify",
      "enrich", "context-verify", "architect",
      "plan", "plan-review", "gate-plan",
      "test-first", "git-stash", "implement", "git-diff", "pre-review", "review",
      "reconcile", "iterate", "sacred-tests",
      "final-checks", "test-verify", "gate-final", "finalize",
    ],
  },

  hooks: [
    { name: "observe-implementer-output", event: "after-agent-result", filter: (ctx) => ctx.agent === "implementer", run: observeImplementerOutput, idempotent: true },
    { name: "observe-review-fanout", event: "before-fanout", filter: (ctx) => ctx.stage === "review", run: observeReviewFanout, idempotent: true },
  ],

  invariants: codeBundleInvariants,

  schema_extension: "schemas/state-extension.schema.json",
  knowledge_dir: "knowledge/",
  prompts_dir: "prompts/",
  migrations_dir: "migrations/",

  // Static context the classifier reads to pick refs + a stack from real
  // catalogs (never invent). Scoped to the classifier so the bulky listings
  // stay out of every other agent's prompt. The renderer materializes these
  // off the bundle source tree at load and appends them to the spawn context.
  spawn_context_assets: [
    {
      heading: "Refs catalog",
      kind: "frontmatter-catalog",
      dir: "knowledge/references",
      agents: ["classifier"],
    },
    {
      heading: "Stack candidate registry",
      kind: "file",
      path: "stack-candidates.yaml",
      fence: "yaml",
      agents: ["classifier"],
    },
  ],
});
