// Research / specification bundle — declarative wiring.
//
// This is a SECOND bundle, authored to a domain deliberately unlike the
// first. Where the code bundle classifies → plans → implements → reviews
// code, this one takes an idea through intake → research → draft →
// review → finalize: a researcher gathers context and emits claims, a
// writer drafts a specification, and a reviewer critiques the draft. The
// point is not the product — it is the proof. A contract with one
// implementation hides that implementation's assumptions; only a second
// consumer in an unrelated shape shows whether the substrate truly names
// no domain.
//
// So everything domain-shaped here is chosen to NOT line up with the code
// bundle: different phases, gate roles the substrate has never seen
// (`scope` / `consult` / `spec-approval`), no notion of a build stack, a
// non-review output kind the researcher introduces, and a finding that
// describes a defect in prose rather than a line of source. If any of
// these forces a change to the substrate, that change is a separation
// leak — the substrate was carrying a code-domain assumption — and the
// fix belongs in a generic substrate surface, never a research-specific
// branch in the kernel.
//
// Applicability lives on the AGENT, not the stage, exactly as in the
// first bundle: the substrate's SpawnStage is just {kind,name,phase,agent}.

import { defineBundle } from "@loomfsm/kernel";
import type {
  BundleStateView,
  HookContext,
  StageContext,
  UserAnswerSchema,
} from "@loomfsm/kernel";

import { specBundleInvariants } from "./invariants.js";
import { specPolicyResolver } from "./policy-resolver.js";

// ============================================================================
// Positional StepStage run bodies — deterministic state derivation only.
//
// A `run` body executes inside the stage transaction: no shell-out, no
// network, no LLM call, no clock. It derives state from what the substrate
// already tracks and writes through the scratch façade. The substrate may
// re-enter a Step after a crash, so each body is idempotent against its
// own prior committed effect.
// ============================================================================

// Mark intake handled. A placeholder for the normalization a full bundle
// would do (free-text idea → a structured request); here it only proves a
// non-code flow writes a decision through the same generic façade the code
// bundle uses.
async function markIntake(_state: BundleStateView, ctx: StageContext): Promise<void> {
  ctx.tx.set_decision?.("intake_ready", true);
}

// Write the readiness signal the autonomous-sign-off safety floor reads.
// In a full bundle this would summarize whether the draft is internally
// consistent and every blocking defect resolved; the skeleton always
// reports `ok`, which is enough to exercise the floor's wiring. The floor
// only consults it when the sign-off role is set to `auto`.
async function writeReadiness(_state: BundleStateView, ctx: StageContext): Promise<void> {
  ctx.tx.set_bundle_state_field?.("spec_readiness", { status: "ok" });
}

// ============================================================================
// Gate messages + answer schemas
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

function taskLabel(state: BundleStateView): string {
  return state.task_short ?? state.task;
}

function gateScopeMsg(state: BundleStateView): string {
  return `Confirm the scope understood for "${taskLabel(state)}" before research begins, or request changes.`;
}
function gateConsultMsg(state: BundleStateView): string {
  return `Clarifying questions for "${taskLabel(state)}" before drafting. Answer to proceed, or request changes.`;
}
function gateApprovalMsg(state: BundleStateView): string {
  return `The specification for "${taskLabel(state)}" is ready for sign-off. Approve to finalize, or request changes.`;
}
function approveReviseAnswers(_state: BundleStateView): UserAnswerSchema {
  return { options: [APPROVE_OPTION, REVISE_OPTION] };
}

// ============================================================================
// Post-commit observer — side-effect-only, idempotent, no kernel writes
// ============================================================================

async function observeSpecReview(ctx: HookContext): Promise<void> {
  await ctx.emit_event("spec-review-observed", { stage: ctx.stage ?? "review-spec" });
}

// ============================================================================
// Bundle declaration
// ============================================================================

export default defineBundle({
  name: "spec",
  version: "0.0.0",
  description:
    "Research & specification authoring — intake, research, draft, review, and sign-off. A second domain that shares none of the code bundle's phases, gate roles, or output shapes.",

  // Deliberately unlike the code bundle's phases. Naming a phase costs the
  // substrate nothing — Phase is an opaque string it never branches on.
  phases: ["intake", "research", "draft", "review-spec", "finalize"],

  // One flow, no complexity routing. The code bundle ships three flows and
  // a complexity switch; this bundle ships exactly one, which also proves
  // the FSM drives a flow when no `complexity_flows` map is declared.
  default_flow: "spec",

  // Two human checkpoints and one autonomous sign-off. None of these three
  // roles is a substrate role — all are declared below via
  // `extends_vocab.gate_roles_extra`. Setting `spec-approval` to `auto`
  // commits the bundle to a resolver plus a name-matching safety floor;
  // both ship below, so the loader admits the autonomous posture.
  //
  // The gate-policy map names only this bundle's own roles — the kernel's
  // map type is partial over the role set, so a bundle that owns an entirely
  // different vocabulary declares just the postures it gates and nothing else.
  default_gate_policies: {
    scope: "human",
    consult: "human",
    "spec-approval": "auto",
  },
  policyResolver: specPolicyResolver,
  replan_budget: { kind: "attempt", max_iterations: 2, on_exhaustion: "human" },

  default_provider: "claude-code-shuttle",

  gate_roles: {
    "gate-scope": "scope",
    "gate-consult": "consult",
    "gate-approval": "spec-approval",
  },

  extends_vocab: {
    // The researcher emits a non-review output. The code bundle's review
    // ontology (reviewer / validator findings) does not fit a context-
    // gathering pass, so the bundle introduces its own kind rather than
    // forcing a review shape onto it — exactly what `extends_vocab` is for.
    output_kinds: ["research-note"],
    // A non-code error class, declared to confirm the substrate merges a
    // bundle's error vocabulary the same way regardless of domain.
    error_classes: ["spec-defects-open"],
    // The three gate roles the substrate has never seen.
    gate_roles_extra: ["scope", "consult", "spec-approval"],
  },

  // Minimum agents: one to research, one to draft, one to review. The
  // reviewer reuses the substrate's review ontology — a spec defect IS a
  // finding — which is the close-domain reuse the genericity proof expects;
  // the researcher's non-review kind is the part that stresses the boundary.
  agents: [
    { name: "researcher", template_path: "agents/researcher.md", output_kind: "research-note", default_model: "balanced" },
    { name: "spec-writer", template_path: "agents/spec-writer.md", output_kind: "nonreview", default_model: "premium" },
    { name: "spec-reviewer", template_path: "agents/spec-reviewer.md", output_kind: "reviewer", default_model: "premium" },
  ],

  stages: {
    init: {
      kind: "step",
      name: "init",
      phase: "intake",
      position: "positional",
      effects: [{ kind: "decisions.set", key: "intake_ready" }],
      run: markIntake,
    },
    "gate-scope": {
      kind: "gate",
      name: "gate-scope",
      phase: "intake",
      message: gateScopeMsg,
      valid_answers: approveReviseAnswers,
    },
    research: { kind: "spawn", name: "research", phase: "research", agent: "researcher" },
    "gate-consult": {
      kind: "gate",
      name: "gate-consult",
      phase: "research",
      message: gateConsultMsg,
      valid_answers: approveReviseAnswers,
    },
    draft: { kind: "spawn", name: "draft", phase: "draft", agent: "spec-writer" },
    "review-spec": { kind: "spawn", name: "review-spec", phase: "review-spec", agent: "spec-reviewer" },
    readiness: {
      kind: "step",
      name: "readiness",
      phase: "review-spec",
      position: "positional",
      effects: [{ kind: "bundle_state.set", path: "spec_readiness" }],
      run: writeReadiness,
    },
    "gate-approval": {
      kind: "gate",
      name: "gate-approval",
      phase: "review-spec",
      message: gateApprovalMsg,
      valid_answers: approveReviseAnswers,
    },
    finalize: { kind: "finalize", name: "finalize" },
  },

  flows: {
    spec: [
      "init",
      "gate-scope",
      "research",
      "gate-consult",
      "draft",
      "review-spec",
      "readiness",
      "gate-approval",
      "finalize",
    ],
  },

  hooks: [
    {
      name: "observe-spec-review",
      event: "after-agent-result",
      filter: (ctx) => ctx.agent === "spec-reviewer",
      run: observeSpecReview,
      idempotent: true,
    },
  ],

  invariants: specBundleInvariants,
});
