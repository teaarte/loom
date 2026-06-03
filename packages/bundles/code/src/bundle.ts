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

import { defineBundle } from "@loomfsm/kernel";
import type {
  BundleStateView,
  ConditionalSpawnContext,
  Finding,
  HookContext,
  StageContext,
  StageResult,
  UserAnswer,
  UserAnswerSchema,
} from "@loomfsm/kernel";

import { codeBundleInvariants } from "./invariants.js";
import { codePolicyResolver } from "./policy-resolver.js";
import { isStackInfo, type StackInfo } from "./stack.js";

// ============================================================================
// Decision helpers — pure reads over the narrow state projection
// ============================================================================

function decisionEquals(state: BundleStateView, key: string, value: unknown): boolean {
  return state.decisions[key] === value;
}

// The one source of truth for the `tests_mode` decision. Every producer
// (the classify step below) and consumer (the planner template, the `test`
// agent's `applies_to`, the host's task hint) speaks this union — there is
// no third value that would fall through a branch. `tdd` runs tests first;
// `regression-only` writes code directly and checks existing tests for
// regressions.
type TestsMode = "tdd" | "regression-only";

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
  const tests_mode: TestsMode = /\btdd\b|tests? first|test-first/.test(task)
    ? "tdd"
    : "regression-only";
  ctx.tx.set_decision?.("complexity", complexity);
  ctx.tx.set_decision?.("tests_mode", tests_mode);
}

// Relocate the classifier's stack pick into the bundle-owned slot. The
// classifier agent emits a `stack` object in its result header; the kernel's
// generic decisions-merge lands it in `decisions.stack` (the substrate names no
// such key). This step — positional, right after `classify-agent` in every
// flow — copies it to `bundle_state.stack`, the canonical bundle-owned home
// downstream agents (and, ahead, the sandboxed executor) read from the narrow
// view. No emission / a non-object leaves bundle_state untouched. Idempotent:
// re-running writes the same value.
async function relocateStackToBundleState(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  const picked = state.decisions["stack"];
  if (!isStackInfo(picked)) return;
  const stack: StackInfo = picked;
  ctx.tx.set_bundle_state_field?.("stack", stack);
}

// Derive the review-shaping flags from the substrate's own file accounting
// (which paths the run has touched). The reviewer fanout reads these via
// each reviewer agent's `applies_to`.
//
// Precedence for `security_needed`: the classifier may set it earlier from
// the task's intent (a guess). This step runs LATER (implementation phase,
// after the diff is known) and overwrites all three flags from the actual
// changed files — so file evidence wins over the intent guess. That is
// deliberate ordering, not a race: the later, ground-truth write is the one
// the fanout reads. This only fires when the host has fed `files_modified`;
// an empty file list leaves every flag false and the file-conditional
// reviewers (ui-consistency / playwright / security) silently do not run.
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

  // `source_changed`: false ONLY when there is positive evidence that the
  // outcome touched no source — every modified/created path is a doc. A
  // doc-only outcome (e.g. a verdict whose only artifact is a hand-off `.md`)
  // does not warrant the full adversarial code panel; the always-on reviewers
  // self-gate on this flag below. Left true when files are absent (unknown —
  // never suppress review without evidence) so the only behavior change is the
  // doc-only case. The conditional reviewers (ui/api/security/playwright)
  // already drop out on a doc-only diff via their own flags.
  const allFiles = [...state.files_modified, ...state.files_created];
  const docOnly = allFiles.length > 0 && allFiles.every((f) => DOC_FILE.test(f));
  ctx.tx.set_decision?.("source_changed", !docOnly);
}

// Documentation file extensions — a change confined to these is a doc-only
// outcome with no source to run the code review panel against.
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|rdoc)$/i;

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

// Surface any Finish-contract actions the task asked for that the engine
// does NOT perform — committing, pushing, opening a PR, publishing,
// deploying. The kernel is side-effect-free by design (it never touches the
// operator's repo), so when the brief names one of these the honest "done"
// summary should say it is still the operator's to run, rather than imply
// full completion. Deterministic scan over the task text; writes the note
// into the generic `completion_summary` field the kernel appends to the
// terminal summary. No match → no note (the common case).
async function deriveFinishSummary(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  const task = state.task.toLowerCase();
  const actions: string[] = [];
  if (/\bcommit(s|ted|ting)?\b/.test(task)) actions.push("commit");
  if (/\b(push|pushes|pushed)\b/.test(task)) actions.push("push");
  if (/\bpull[ -]request\b|\bpr\b|\bmr\b|\bmerge[ -]request\b/.test(task)) actions.push("open a PR");
  if (/\bpublish(es|ed|ing)?\b|\brelease[sd]?\b|\btag\b/.test(task)) actions.push("publish/release");
  if (/\bdeploy(s|ed|ment|ing)?\b/.test(task)) actions.push("deploy");
  if (actions.length === 0) return;
  const list = [...new Set(actions)].join(", ");
  ctx.tx.set_bundle_state_field?.(
    "completion_summary",
    `the task named finish steps the engine does not perform (it never modifies your repo) — run them yourself: ${list}.`,
  );
}

// ============================================================================
// Adjudication — empirically verify a runtime claim instead of guessing.
//
// The driver's most valuable act on a real run was distrusting a soft signal
// and verifying it empirically (the orphan-chunk lesson: a chunk EXISTING in
// the bundle ≠ it being reached at runtime). The substrate gives a generic
// "spawn agent X when predicate P(outcome) holds" primitive (SpawnStage.when)
// plus a generic finding-status override (ctx.tx.update_finding_status). ALL of
// the domain — what a "runtime claim" is, what a "coverage hole" is, build /
// dist-chunk / entry-loading / reachability, pnpm — lives HERE, in the agent
// prompt and these predicate bodies. The substrate names none of it.
// ============================================================================

// The behavioral / runtime subset of the reviewer category vocabulary
// (schemas/category-vocab.json): claims about what the code DOES at run time —
// a crash, a leak, a race, an unreachable path — that static review cannot
// settle and a green build does not exercise. A blocking finding in one of
// these categories is, by bundle convention, "a runtime claim in a coverage
// hole": the reviewer asserts an outcome they could not empirically confirm.
// This is a domain reading of the GENERIC `category` column the substrate
// stores — not a substrate concept.
const RUNTIME_CLAIM_CATEGORIES = new Set<string>([
  // logic-reviewer
  "race-condition",
  "unhandled-async",
  "unbounded-recursion-or-loop",
  "ordering-assumption",
  "leak-or-cleanup-missing",
  "regression-risk",
  // challenger-reviewer
  "concurrency-failure",
  "downstream-failure-not-handled",
  "ordering-violation",
  "atomicity-gap",
  "state-leak-across-requests",
  "retry-or-replay-issue",
  "empty-or-null-input-failure",
  // performance
  "memory-leak",
  "cache-stampede-risk",
  "hot-key-redis",
  "react-rerender-storm",
]);

// Files whose blast radius makes a runtime claim worth verifying even when the
// reviewers did not split — an entry point, router, auth, or server bootstrap.
// Heuristic over the substrate's generic file accounting.
const HOT_PATH =
  /(^|\/)(index|main|app|server|router|routes|middleware|auth|bootstrap)\.[a-z]+$|(^|\/)(pages|app)\/api\//i;

// The adjudicator's marker categories the reconcile step reads back.
const ADJUDICATION_CONFIRMED = "runtime-confirmed";
const ADJUDICATION_REFUTED = "runtime-refuted";
const ADJUDICATION_PHASE = "implementation";

// `when` for the `adjudicate` SpawnStage. Reads ONLY the generic outcome subset
// (findings severity/category/status, verdict rows, file accounting) and reads
// it through the bundle's domain conventions. Fires when BOTH hold: there is a
// LIVE blocking runtime claim, AND the empirical round is warranted — the
// reviewers DISAGREE on the fact (verdict-spread on the implementation review)
// OR the change touches a hot path. Whether a given claim is "cheaply decidable
// by one observation" is the adjudicator's own call (its prompt); the predicate
// only gates the escalation, not the procedure. Deterministic — no clock, no
// randomness — so the substrate re-derives the same decision on replay.
function shouldAdjudicate(
  state: BundleStateView,
  ctx: ConditionalSpawnContext,
): boolean {
  // 1. A LIVE blocking runtime claim must exist. countBlocking enforces
  //    liveness (open + non-superseded); the category filter identifies the
  //    runtime subset among them.
  if (ctx.findings.countBlocking({ phase: ADJUDICATION_PHASE }) === 0) return false;
  const runtimeClaims = liveRuntimeBlockers(ctx.findings);
  if (runtimeClaims.length === 0) return false;

  // 2. Escalator: reviewers split on the fact, OR the blast radius is hot.
  return reviewersDisagree(state, ADJUDICATION_PHASE) || touchesHotPath(state);
}

// Verdict-spread across the implementation-phase reviewers: at least one
// approve-leaning AND one changes-leaning verdict on the same review — the
// reviewers do not agree, so a tie-breaking observation earns its keep.
function reviewersDisagree(state: BundleStateView, phase: string): boolean {
  const verdicts = state.agent_verdicts.filter((v) => v.phase === phase);
  if (verdicts.length < 2) return false;
  let approve = false;
  let changes = false;
  for (const v of verdicts) {
    const verb = String(v.verdict).toUpperCase();
    if (verb === "APPROVE" || verb === "PASS" || verb === "PASS_WITH_WARNINGS") approve = true;
    if (verb === "REQUEST_CHANGES" || verb === "FAIL") changes = true;
  }
  return approve && changes;
}

function touchesHotPath(state: BundleStateView): boolean {
  return state.files_modified.some((f) => HOT_PATH.test(f));
}

// Live blocking findings whose category is a runtime claim. Uses the
// materialized ctx.findings (countBlocking already proved at least one is live;
// query carries the open+blocking subset) — never tx.read.findings(), which is
// an unwired READ_NOT_WIRED stub.
function liveRuntimeBlockers(
  findings: ConditionalSpawnContext["findings"],
): Finding[] {
  return findings
    .query({ phase: ADJUDICATION_PHASE, severity: ["blocking"], status: ["open"] })
    .filter((f) => RUNTIME_CLAIM_CATEGORIES.has(f.category));
}

// Apply the adjudication verdicts to the ORIGINAL findings — the override.
// Runs right after the `adjudicate` spawn delivered (or was skipped): reads the
// adjudicator's info-severity markers, and for each one flips the original
// blocking runtime claim it points at (matched by file + line):
//   - refuted   → downgrade the original to `info`; it leaves the live-blocking
//     set so the final-gate acceptance veto no longer holds on it, and the
//     marker keeps the refutation proof beside it.
//   - confirmed → re-assert `blocking`/`open` (idempotent keep — the veto holds).
// `adjudicate` skipped ⇒ no markers ⇒ no-op. The substrate's
// `update_finding_status` is domain-blind; the confirmed/refuted semantics and
// the file/line correlation are the bundle's.
async function reconcileAdjudications(
  _state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  const markers = ctx.findings
    .query({ phase: ADJUDICATION_PHASE, agent: "adjudicator" })
    .filter(
      (m) => m.category === ADJUDICATION_CONFIRMED || m.category === ADJUDICATION_REFUTED,
    );
  if (markers.length === 0) return;

  const liveBlockers = liveRuntimeBlockers(ctx.findings);
  for (const marker of markers) {
    const target = liveBlockers.find((f) => sameLocation(f, marker));
    if (target === undefined) continue;
    if (marker.category === ADJUDICATION_REFUTED) {
      ctx.tx.update_finding_status?.(target.id, { severity: "info" });
    } else {
      ctx.tx.update_finding_status?.(target.id, { severity: "blocking", status: "open" });
    }
    ctx.tx.audit({
      type: "adjudication-applied",
      target: target.id,
      verdict: marker.category,
    });
  }
}

// A marker points at an original blocker when they share a file and start line.
// The adjudicator echoes the target's location for exactly this correlation; a
// marker with no file cannot be matched and is skipped (leaving the blocker live).
function sameLocation(original: Finding, marker: Finding): boolean {
  return (
    original.file !== null &&
    original.file === marker.file &&
    original.line_start === marker.line_start
  );
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

  // Complexity → flow routing. The task starts on `medium`; once the
  // classifier-agent's `complexity` has merged into decisions (right after
  // `classify-agent`), the kernel re-selects the flow ONCE: a `simple`
  // task drops to the lean flow (single reviewer, no fanout), `complex`
  // takes the full panel. The required shared prefix is
  // [initialize, classify, classify-agent] (indices 0–2, up to after_stage)
  // so the switch keeps step_index aligned (the loader verifies this). The
  // `stack-to-bundle-state` step sits at index 3 in every flow — the switch
  // boundary itself — and is identical across them, so it runs once on
  // whichever flow the switch lands on.
  complexity_flows: {
    decision_key: "complexity",
    after_stage: "classify-agent",
    map: { simple: "simple", medium: "medium", complex: "complex" },
  },

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

  // Tier → concrete model for the default Claude Code backend, so a
  // zero-config install resolves each agent's declared tier to a real model.
  // A project's `.claude/providers.json` overrides per agent.
  default_model_tiers: {
    fast: "haiku",
    balanced: "sonnet",
    premium: "opus",
  },

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
    // The always-relevant reviewers self-gate on `source_changed`: a doc-only
    // outcome (every changed file a doc) sets it false in `pre-review`, so the
    // panel does not burn a full adversarial review on a hand-off `.md`. The
    // `!== false` guard keeps them running everywhere the flag is unset —
    // `plan-review` (planning, before any diff) and any host that reports no
    // files — so the only suppression is the evidenced doc-only case.
    {
      name: "logic-reviewer",
      template_path: "agents/logic-reviewer.md",
      output_kind: "reviewer",
      default_model: "premium",
      applies_to: (s) => s.decisions["source_changed"] !== false,
    },
    {
      name: "challenger-reviewer",
      template_path: "agents/challenger-reviewer.md",
      output_kind: "reviewer",
      default_model: "premium",
      applies_to: (s) => s.decisions["source_changed"] !== false,
    },
    {
      name: "style-reviewer",
      template_path: "agents/style-reviewer.md",
      output_kind: "reviewer",
      default_model: "fast",
      applies_to: (s) => s.decisions["source_changed"] !== false,
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
      applies_to: (s) => s.decisions["source_changed"] !== false,
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
    // Empirical runtime-claim verifier — spawned only when a live blocking
    // runtime claim warrants one decisive observation (see `adjudicate`'s
    // `when`). A `validator`, so the substrate persists its info-severity
    // markers; the `reconcile` step applies the override they carry.
    { name: "adjudicator", template_path: "agents/adjudicator.md", output_kind: "validator", default_model: "balanced" },
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
    // Move the classifier's stack pick from the generic decisions map into the
    // bundle-owned bundle_state slot. Positional at index 3 in every flow — the
    // same boundary the complexity switch fires at, so the three flows stay
    // prefix-aligned (the stage is identical across them).
    "stack-to-bundle-state": {
      kind: "step",
      name: "stack-to-bundle-state",
      phase: "context",
      position: "positional",
      effects: [{ kind: "bundle_state.set", path: "stack" }],
      run: relocateStackToBundleState,
    },
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
        { kind: "decisions.set", key: "source_changed" },
      ],
      run: derivePreReview,
    },
    review: {
      kind: "fanout",
      name: "review",
      phase: "implementation",
      // The always-relevant reviewers plus the file-conditional validators.
      // Each conditional agent self-gates through its `applies_to` over the
      // review-shaping flags `pre-review` derived from the changed files:
      // ui-consistency / playwright run only when UI files changed,
      // api-contract only when API surface changed, security unless the
      // file scan ruled it out. With no file accounting fed, the flags stay
      // false and these correctly drop out — so the host MUST report files
      // (see the delivery's files_modified) for them to engage.
      agents: [
        "logic-reviewer",
        "challenger-reviewer",
        "style-reviewer",
        "security",
        "performance",
        "ui-consistency",
        "playwright",
        "api-contract",
      ],
      filter_by_change_kind: true,
      iteration_budget: { kind: "attempt", max_iterations: 3, on_exhaustion: "audit-only" },
    },
    // Lean single-reviewer spawn for the `simple` flow — a routine change
    // gets one logic review instead of the full adversarial fanout. The
    // fanout `review` stays for the medium/complex flows.
    "review-light": { kind: "spawn", name: "review-light", phase: "implementation", agent: "logic-reviewer" },
    // Guarded escalation: spawn the adjudicator ONLY when a live blocking
    // runtime claim warrants one empirical observation (`shouldAdjudicate`).
    // When the predicate is false the stage advances launching nothing — the
    // common case. Sits after the `review` fanout and before `reconcile`, which
    // applies whatever verdict it returns.
    adjudicate: {
      kind: "spawn",
      name: "adjudicate",
      phase: "implementation",
      agent: "adjudicator",
      when: shouldAdjudicate,
    },
    // Reconcile the review outcome — now including any adjudication verdict:
    // the override of a runtime claim's severity/status is applied here from the
    // adjudicator's markers. A no-op when `adjudicate` did not spawn.
    reconcile: {
      kind: "step",
      name: "reconcile",
      phase: "implementation",
      position: "positional",
      effects: [{ kind: "finding.status.update" }],
      run: reconcileAdjudications,
    },
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
    "finish-summary": {
      kind: "step",
      name: "finish-summary",
      phase: "validation",
      position: "positional",
      effects: [{ kind: "bundle_state.set", path: "completion_summary" }],
      run: deriveFinishSummary,
    },
    finalize: { kind: "finalize", name: "finalize" },
  },

  flows: {
    // Lean path for routine work: one planner, one implementer, ONE
    // reviewer (review-light), acceptance, the final gate, finalize. No
    // gate-classify, no plan-review/review fanouts, no enrich/architect —
    // ~5 agents vs medium's ~10+. Shares the [initialize, classify,
    // classify-agent] prefix with the other flows so the complexity switch
    // lands here without misaligning step_index.
    simple: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state",
      "plan", "implement", "git-diff", "pre-review",
      "review-light", "final-checks", "gate-final", "finish-summary", "finalize",
    ],
    medium: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state", "gate-classify",
      "enrich", "plan", "plan-review", "gate-plan",
      "git-stash", "implement", "git-diff", "pre-review", "review",
      "adjudicate", "reconcile", "iterate", "final-checks", "test-verify",
      "gate-final", "finish-summary", "finalize",
    ],
    complex: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state", "gate-classify",
      "enrich", "context-verify", "architect",
      "plan", "plan-review", "gate-plan",
      "test-first", "git-stash", "implement", "git-diff", "pre-review", "review",
      "adjudicate", "reconcile", "iterate", "sacred-tests",
      "final-checks", "test-verify", "gate-final", "finish-summary", "finalize",
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
