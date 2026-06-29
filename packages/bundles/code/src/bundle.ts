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

import { createHash } from "node:crypto";

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

// Differentiated rework panel: on a walk-back iteration, re-run ONLY the
// reviewers that produced a blocking finding in the previous implementation
// round — a focused re-verify instead of the full adversarial fanout (a
// style-only blocker should not re-run the opus correctness panel). The signal
// is the substrate's own per-agent verdict accounting: each `agent_verdicts`
// row carries `blocking_issues` + `iteration`, so the reviewers that blocked
// last round are exactly those with `blocking_issues > 0` at the latest
// implementation iteration.
//
//   - First pass (no implementation verdicts yet) → full panel, unchanged.
//   - A rework round whose blockers came from reviewers → re-run only those.
//   - A rework round with NO reviewer blocker (e.g. an acceptance-only failure)
//     → re-review fully, so the implementer's new code is never left unreviewed.
//
// A style-only round falls out for free: if the style reviewer was the only one
// that blocked, it is the only one the re-run admits. Scoped to implementation
// verdicts so a reviewer reused in the planning `plan-review` fanout is never
// constrained there (planning carries no implementation verdicts).
function reworkAllowsReviewer(state: BundleStateView, agentName: string): boolean {
  const implVerdicts = (state.agent_verdicts ?? []).filter(
    (v) => v.phase === "implementation",
  );
  if (implVerdicts.length === 0) return true; // first pass — full panel
  let maxIter = 0;
  for (const v of implVerdicts) if (v.iteration > maxIter) maxIter = v.iteration;
  const blockedLastRound = implVerdicts
    .filter((v) => v.iteration === maxIter && v.blocking_issues > 0)
    .map((v) => v.agent);
  // No reviewer blocked last round → the rework was driven by something else
  // (an acceptance failure); re-review fully rather than skip review entirely.
  if (blockedLastRound.length === 0) return true;
  return blockedLastRound.includes(agentName);
}

// Implementer tier escalation: after TWO implementation rounds that ended with a
// blocking finding, the third round runs a higher-tier implementer rather than
// burning another identical round on a model that has already failed twice. A
// cheap-but-weak implementer that needs several rework rounds costs MORE
// end-to-end than a stronger one that lands the change first time — each round
// re-runs the whole review fanout — so escalating once it has demonstrably
// stalled is the cheaper path per task, not per token.
//
// The signal is the same per-agent verdict accounting `reworkAllowsReviewer`
// reads: count the distinct implementation-review rounds (`iteration`) that
// recorded a blocking verdict. The escalation is realized the same way the
// planner tiers by complexity — a distinct higher-tier agent
// (`implementer-escalated`, premium) the flow selects via `applies_to` — so it
// needs no kernel change. Because it is a DIFFERENT agent name, a cheap per-agent
// model override configured for `implementer` does NOT follow it, so the third
// round reverts to the capable bundle tier. premium is the top tier, so an
// already-premium implementer escalates to premium (a no-op for the default
// config; the lever bites when a cheaper implementer was configured).
function priorBlockingImplementationRounds(state: BundleStateView): number {
  const blockingRounds = new Set<number>();
  for (const v of state.agent_verdicts ?? []) {
    if (v.phase === "implementation" && v.blocking_issues > 0) {
      blockingRounds.add(v.iteration);
    }
  }
  return blockingRounds.size;
}

// True once two prior implementation rounds blocked — i.e. the implementer is
// entering its third round. Deterministic over the verdict accounting (no clock,
// no randomness) so a replayed tick re-derives the same agent selection. Exactly
// one escalation per task: there is no tier above premium, so once it fires the
// escalated agent simply keeps running and the decision is recorded once.
function implementerShouldEscalate(state: BundleStateView): boolean {
  return priorBlockingImplementationRounds(state) >= 2;
}

// The complexity values the flow router understands. `trivial` is the fast-task
// flow (one implementer spawn, no gates/review); the other three are the
// classifier's own output range.
function isComplexity(v: unknown): v is "trivial" | "simple" | "medium" | "complex" {
  return v === "trivial" || v === "simple" || v === "medium" || v === "complex";
}

// True when the OPERATOR pinned the complexity at submit (the ⚡ fast-task toggle
// / complexity selector seeds `complexity` + `complexity_pinned` via
// `initial_decisions`). When pinned, the heuristic `classify` step keeps the
// value verbatim and the `classify-agent` spawn self-skips — a pinned task never
// pays for (re-)classification, which is the whole point of fast-task.
function complexityPinned(state: BundleStateView): boolean {
  return state.decisions["complexity_pinned"] === true && isComplexity(state.decisions["complexity"]);
}

// `when` for the `classify-agent` spawn: run the classifier UNLESS the operator
// pinned the complexity. A skipped spawn advances the stage launching nothing,
// so the complexity switch (right after, `after_stage: classify-agent`) reads
// the pinned value and routes accordingly.
function shouldClassify(state: BundleStateView): boolean {
  return !complexityPinned(state);
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
  // Honour an operator-pinned complexity verbatim; only guess when none was
  // pinned (the default path — byte-identical to before).
  if (!complexityPinned(state)) {
    // Deterministic FALLBACK only — the classifier agent (now a balanced-tier
    // model) does the real scoping and overwrites this. Kept conservative: it
    // never guesses `trivial` (which skips ALL review/gates — too risky for a
    // keyword heuristic; the LLM emits it under strict criteria, or the operator
    // pins it). Greenfield/scaffold/migration verbs route to the full panel.
    let complexity: "simple" | "medium" | "complex";
    if (
      /\b(refactor|migrate|migration|architecture|redesign|rewrite|scaffold|bootstrap|monorepo|set ?up|initiali[sz]e)\b/.test(task) ||
      len > 400
    ) {
      complexity = "complex";
    } else if (len < 120 && /\b(typo|rename|bump|comment|docs?|readme|wording)\b/.test(task)) {
      complexity = "simple";
    } else {
      complexity = "medium";
    }
    ctx.tx.set_decision?.("complexity", complexity);
  }
  const tests_mode: TestsMode = /\btdd\b|tests? first|test-first/.test(task)
    ? "tdd"
    : "regression-only";
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

  // `source_changed`: false when there is positive evidence the outcome changed
  // no source the adversarial code panel should run on — EITHER an empty diff
  // (the implementer produced nothing: a no-op that must not burn the panel) OR
  // every modified/created path is a doc (a hand-off `.md`). This step runs in
  // the implementation phase, AFTER `git-diff`, so an empty diff here is the
  // self-diff's verdict that nothing changed — not the "files unknown" case
  // `plan-review` (planning, before any diff, flag unset) sits in. The always-on
  // reviewers self-gate on this flag below; a no-op additionally PARKS at the
  // final gate (INV_CODE_105) rather than auto-accepting.
  const allFiles = [...state.files_modified, ...state.files_created];
  const noChanges = allFiles.length === 0;
  const docOnly = allFiles.length > 0 && allFiles.every((f) => DOC_FILE.test(f));
  ctx.tx.set_decision?.("source_changed", !(noChanges || docOnly));
}

// Documentation file extensions — a change confined to these is a doc-only
// outcome with no source to run the code review panel against.
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc|rdoc)$/i;

// Record the implementer tier escalation as a decision the gate operator reads.
// The agent SELECTION is driven directly by the verdict accounting (each
// implementer variant's `applies_to`); this positional step is the
// operator-facing note. Runs right after the implement spawns, before the
// review fanout, so `agent_verdicts` still reflects the prior rounds. Only sets
// the key when escalating (idempotent — once true it stays true), so a normal
// run's decisions block is untouched.
async function recordImplementerEscalation(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  if (implementerShouldEscalate(state)) {
    ctx.tx.set_decision?.("implementer_escalated", true);
  }
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

// ============================================================================
// Deterministic checks — read the executor's envelope, drive state + findings
// ============================================================================
//
// The `run-checks` spawn is routed (by the bundle's `checks` execution
// capability) to a deterministic executor that runs the project's typecheck /
// lint / test commands in the task worktree and returns a JSON envelope as its
// output. The substrate's structured-output merge lands that envelope's `checks`
// array in `decisions.checks` (the same path the classifier's picks travel).
// `applyChecks` below is the positional Step that reads it back: it writes each
// check's status into the bundle_state field the safety floor reads, synthesizes
// one blocking finding per FAILED check (so the gate walks back to implement and
// the compiler output reaches the implementer through the open-blocker hand-off,
// with the review fanout skipped), and records `checks_ok` so the reviewers
// self-gate off a broken round.

// The agent whose spawn runs the deterministic checks executor. Named here only
// to attribute its synthesized findings; the dispatch routes it by the
// bundle-declared `checks` execution capability, NOT by this name.
const CHECKS_AGENT = "checks-runner";

// The finding category for a failed deterministic check — an open string the
// substrate stores verbatim, not a closed vocabulary.
const CHECK_FAILED_CATEGORY = "failed-check";

// Where the checks executor leaves the FULL compiler/test output, inside the
// worktree the implementer re-enters on a walk-back. The blocking finding is
// bounded to the field caps and points HERE for the rest; the file is the
// full-fidelity channel. (Worktree-relative — POSIX form for the prompt text.)
const CHECK_FAILURES_FILE = ".loom/work/check-failures.txt";

// The executor's three check names mapped to the bundle_state field the
// safety-floor invariants read (`lint`→`lint_result`, `test`→`test_run`).
const CHECK_STATE_FIELD: Readonly<Record<string, string>> = {
  typecheck: "typecheck",
  lint: "lint_result",
  test: "test_run",
};

interface CheckResultRow {
  name: string;
  status: string;
  exit_code: number | null;
  output_head: string | null;
  output_tail: string | null;
  command: string | null;
}

// Parse the executor's envelope out of the decisions slot the structured-output
// merge landed it in. Tolerant: a missing / malformed entry yields nothing, so
// the apply step records every check as skipped rather than throwing — a
// degraded delivery never strands the flow.
function parseCheckRows(raw: unknown): CheckResultRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: CheckResultRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? o["name"] : "";
    if (name.length === 0) continue;
    rows.push({
      name,
      status: typeof o["status"] === "string" ? o["status"] : "skipped",
      exit_code: typeof o["exit_code"] === "number" ? o["exit_code"] : null,
      output_head: typeof o["output_head"] === "string" ? o["output_head"] : null,
      output_tail: typeof o["output_tail"] === "string" ? o["output_tail"] : null,
      command: typeof o["command"] === "string" ? o["command"] : null,
    });
  }
  return rows;
}

// Deterministic finding id for a failed check: `f-YYYY-MM-DD-<hash6>` derived
// from the tick's NowToken + the check name. The date prefix + six hex chars
// match the substrate's locked finding-id shape; deriving from `now` (replayed
// verbatim per tick) keeps a re-entered tick idempotent, while a DIFFERENT
// rework round (a later tick → a different `now`) mints a fresh id so a
// persistent failure re-blocks the next round rather than colliding with the
// superseded prior-round row.
function checkFindingId(now: string, name: string): string {
  const date = now.slice(0, 10);
  const hash = createHash("sha1").update(`checks:${now}:${name}`).digest("hex").slice(0, 6);
  return `f-${date}-${hash}`;
}

function clampField(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

// Apply the deterministic checks executor's envelope. Writes each check's status
// into the bundle_state field the floor reads, synthesizes one blocking finding
// per FAILED check (command + the output HEAD within the finding field caps,
// pointing at the worktree file the executor wrote for the full output), records
// `checks_ok` for the reviewer self-gate, and compacts the bulky envelope out of
// `decisions` so the output never bloats a downstream prompt. A skipped check
// writes a skipped status and no finding — a check never owed is not a failure.
async function applyChecks(state: BundleStateView, ctx: StageContext): Promise<void> {
  const rows = parseCheckRows(state.decisions["checks"]);
  const byName = new Map(rows.map((r) => [r.name, r]));
  const failed: string[] = [];

  for (const name of ["typecheck", "lint", "test"] as const) {
    const field = CHECK_STATE_FIELD[name] ?? name;
    const row = byName.get(name);
    const status = row?.status === "ok" || row?.status === "fail" ? row.status : "skipped";
    ctx.tx.set_bundle_state_field?.(field, {
      status,
      exit_code: row?.exit_code ?? null,
      output_tail: row?.output_tail ?? null,
    });
    if (status === "fail") {
      failed.push(name);
      const cmd = row?.command ?? name;
      // The finding is built from the output HEAD (a compiler prints its first
      // error first), within the existing field caps; the FULL output is the
      // file the checks executor left in the worktree the implementer re-enters.
      // Fall back to the tail if a degraded delivery carried no head.
      const head = row?.output_head ?? row?.output_tail ?? "";
      const exit = row?.exit_code ?? "non-zero";
      const firstLine = head.split("\n", 1)[0] ?? "";
      ctx.tx.record_finding?.({
        schema_version: "1.0",
        id: checkFindingId(ctx.now, name),
        agent: CHECKS_AGENT,
        iteration: 1, // re-stamped to the live round by the substrate at drain
        task_id: state.task_id ?? "",
        file: null,
        line_start: null,
        line_end: null,
        severity: "blocking",
        category: CHECK_FAILED_CATEGORY,
        proposed_new_category: null,
        pattern_id: null,
        summary: clampField(`${name} check failed: \`${cmd}\` exited ${exit}`, 200),
        evidence_excerpt: head.length > 0 ? clampField(head, 400) : null,
        // The file pointer leads (so the cap never truncates it away); the head's
        // first line follows as an at-a-glance hint of what broke.
        suggested_fix: clampField(
          `Fix the reported errors and re-run. Full output: ${CHECK_FAILURES_FILE}` +
            (firstLine.length > 0 ? ` — ${firstLine}` : ""),
          300,
        ),
        status: "open",
        ref_rule_id: null,
      });
    }
  }

  const ok = failed.length === 0;
  ctx.tx.set_decision?.("checks_ok", ok);
  // Compact the envelope: the floor + the findings now carry everything
  // downstream needs, so replace the bulky per-check output with a tiny summary
  // and keep the full output OUT of every later spawn's "Decisions so far".
  ctx.tx.set_decision?.("checks", { ok, failed });
  ctx.tx.audit({ type: "checks-recorded", ok, failed });
}

// The review fanout (and the lean single reviewer) must NOT run on a round whose
// deterministic checks failed — broken code earns the compiler's free feedback
// and a walk-back, not an adversarial panel. `checks_ok` is unset before the
// checks run (e.g. plan-review during planning), where `!== false` keeps the
// reviewers running.
function checksAllow(state: BundleStateView): boolean {
  return state.decisions["checks_ok"] !== false;
}

// Land the responder's answer as the task's completion summary — the one
// place an operator reads a finished task's outcome (dashboard result panel,
// bot summary, archived trace). The responder's structured output merged
// `answer` into decisions; this step moves it to the summary field and
// compacts the bulky decision so it never bloats a later prompt or view.
async function applyAnswer(state: BundleStateView, ctx: StageContext): Promise<void> {
  const raw = state.decisions["answer"];
  const answer = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  // `finish-summary` is the single owner of `completion_summary` (the loader
  // enforces one writer per effect); this step lands the answer in its own
  // slot, and the summary step prefers it over the file-accounting digest.
  ctx.tx.set_bundle_state_field?.(
    "answer",
    answer ?? "The responder recorded no answer — re-submit the question or ask your agent host directly.",
  );
  ctx.tx.set_decision?.("answer", answer !== null);
  ctx.tx.audit({ type: "answer-recorded", answered: answer !== null });
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

// Build the task-completion summary — the concise "what was done" digest an
// operator reads to judge a result from the phone. Deterministic over what the
// substrate already tracks (the file accounting + the classification decisions),
// plus the existing reminder of any finish-contract actions the engine does NOT
// perform (commit / push / PR / publish / deploy — the kernel never touches the
// operator's repo, so it is honest to flag them as still theirs to run).
//
// It rides in the generic `completion_summary` field the kernel appends to the
// terminal summary (verbatim) — and, because it lives in the store, it survives
// archival, so the dashboard surfaces it on a completed task and in the archived
// trace alike (a sandbox file would be GC'd with the worktree at merge-back).
// A pure state derivation: no FS write, no clock, idempotent.
async function deriveFinishSummary(
  state: BundleStateView,
  ctx: StageContext,
): Promise<void> {
  // An answer-flow task's deliverable IS the recorded answer — surface it
  // verbatim instead of the file-accounting digest (which would honestly but
  // uselessly read "No file changes were recorded").
  const answer = state.bundle_state?.["answer"];
  if (typeof answer === "string" && answer.length > 0) {
    ctx.tx.set_bundle_state_field?.("completion_summary", answer);
    ctx.tx.audit({ type: "finish-summary", kind: "answer" });
    return;
  }
  const created = state.files_created;
  const modified = state.files_modified;

  const counts: string[] = [];
  if (created.length > 0) counts.push(`${created.length} new`);
  if (modified.length > 0) counts.push(`${modified.length} changed`);
  const fileLine =
    counts.length > 0 ? `Touched ${counts.join(", ")} file(s).` : "No file changes were recorded.";

  // A short, deterministic sample of the touched paths so the digest names the
  // surface without dumping a huge list.
  const sample = [...created, ...modified].slice(0, 8);
  const sampleLine = sample.length > 0 ? ` Files: ${sample.join(", ")}${[...created, ...modified].length > sample.length ? ", …" : ""}.` : "";

  const complexity = state.decisions["complexity"];
  const tests = state.decisions["tests_mode"];
  const classBits: string[] = [];
  if (typeof complexity === "string") classBits.push(`complexity ${complexity}`);
  if (typeof tests === "string") classBits.push(`tests ${tests}`);
  const classLine = classBits.length > 0 ? ` (${classBits.join(", ")})` : "";

  const parts = [`${fileLine}${sampleLine}${classLine}`];

  const task = state.task.toLowerCase();
  const actions: string[] = [];
  if (/\bcommit(s|ted|ting)?\b/.test(task)) actions.push("commit");
  if (/\b(push|pushes|pushed)\b/.test(task)) actions.push("push");
  if (/\bpull[ -]request\b|\bpr\b|\bmr\b|\bmerge[ -]request\b/.test(task)) actions.push("open a PR");
  if (/\bpublish(es|ed|ing)?\b|\brelease[sd]?\b|\btag\b/.test(task)) actions.push("publish/release");
  if (/\bdeploy(s|ed|ment|ing)?\b/.test(task)) actions.push("deploy");
  if (actions.length > 0) {
    const list = [...new Set(actions)].join(", ");
    parts.push(`The task named finish steps the engine does not perform (it never modifies your repo) — run them yourself: ${list}.`);
  }

  ctx.tx.set_bundle_state_field?.("completion_summary", parts.join(" "));
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

// `when` for the acceptance spawn (`final-checks`): run acceptance ONLY once the
// implementation review is free of LIVE blocking findings. An acceptance
// PASS/PASS_WITH_WARNINGS recorded while an impl-phase reviewer blocker is still
// open contradicts INV_CODE_104 — which rolls the tx back at record time, i.e.
// a hard INVARIANT_VIOLATION that strands the run. The adjudicator only resolves
// runtime-CLAIM blockers; a style / security / correctness blocker that survives
// must gate the flow at gate-final (the on-blockers policy parks on it) rather
// than be overrun by an acceptance PASS. So when a blocker is live, acceptance
// self-skips, the flow advances to gate-final, and the open blocker parks it for
// a human to revise or override — a graceful pause instead of a crash.
// Deterministic over the materialized open+blocking subset — replay-stable.
function shouldRunAcceptance(_state: BundleStateView, ctx: ConditionalSpawnContext): boolean {
  return ctx.findings.countBlocking({ phase: ADJUDICATION_PHASE }) === 0;
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
  // Walk back to the planner stage THIS flow uses: the complex flow runs the
  // premium `plan-deep`, every other flow the balanced `plan`. The substrate
  // validates the target is in the active flow (WALK_BACK_TARGET_NOT_FOUND), so a
  // mismatch fails loudly rather than silently mis-routing the revise.
  const planStep = decisionEquals(state, "complexity", "complex") ? "plan-deep" : "plan";
  return { type: "walk_back_to", step: planStep, reason: "plan rejected — revising" };
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
  version: "3.1.0",
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
    // `question` routes an informational task (a question / diagnosis /
    // explanation request) to the no-edit answer flow — a responder reads the
    // repo and answers; nothing is implemented, so no editing agent ever runs
    // and the empty-diff guard has nothing to fire on.
    map: { trivial: "trivial", simple: "simple", medium: "medium", complex: "complex", question: "answer" },
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
  // A project's `.loom/providers.json` overrides per agent.
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
    // Audit-row types this bundle emits via `ctx.tx.audit(...)`. The kernel
    // now lands the forensic trail a tick produces in the audit table and
    // validates each row's `type` against the merged vocabulary, so every
    // type this bundle emits must be declared here (the same insert-time
    // discipline the kernel's own audit types get).
    audit_types: [
      "sacred-tests-checked",
      "adjudication-applied",
      "checks-recorded",
    ],
  },

  agents: [
    { name: "classifier", template_path: "agents/classifier.md", output_kind: "classifier", default_model: "balanced" },
    // Planning tier scales with complexity, same split as the reviewers: the
    // balanced `planner` carries simple/medium (dogfood showed a sonnet plan on
    // par with — sometimes sharper than — opus, at ~1/4 the cost), while the
    // premium `planner-deep` runs ONLY the complex flow, where the blast radius
    // earns the deeper model. Same template; the flow selects the tier (a static
    // default_model can't be tier-by-complexity — one agent name would span both).
    { name: "planner", template_path: "agents/planner.md", output_kind: "nonreview", default_model: "balanced", extras: { repo_brief: true } },
    { name: "planner-deep", template_path: "agents/planner.md", output_kind: "nonreview", default_model: "premium", extras: { repo_brief: true } },
    // The implementer runs every round UNTIL it has stalled (two prior
    // implementation rounds blocked), at which point it self-skips and the
    // premium `implementer-escalated` below takes the third round instead.
    { name: "implementer", template_path: "agents/implementer.md", output_kind: "nonreview", default_model: "premium", applies_to: (s) => !implementerShouldEscalate(s) },
    // Escalation-round implementer (same template, premium tier). Selected only
    // when `implementerShouldEscalate` — and as a DISTINCT agent name a cheap
    // per-agent override on `implementer` does not follow it, so a stalled cheap
    // implementer reverts to the capable bundle tier. premium is the top, so an
    // already-premium implementer escalates to premium (no-op for the default).
    { name: "implementer-escalated", template_path: "agents/implementer.md", output_kind: "nonreview", default_model: "premium", applies_to: (s) => implementerShouldEscalate(s) },
    // The deterministic checks runner. Its spawn is routed (by the `checks`
    // execution capability) to a shell-out executor that runs typecheck / lint /
    // test and returns a JSON envelope — never a model call, so the declared
    // tier is irrelevant (the executor ignores the resolved model) and no
    // backend / credential is needed for it. `output_kind: classifier` so the
    // substrate's structured-output merge lands the envelope in
    // `decisions.checks`, which the `apply-checks` Step reads back.
    { name: "checks-runner", template_path: "agents/checks-runner.md", output_kind: "classifier", default_model: "fast" },
    { name: "code-analyzer", template_path: "agents/code-analyzer.md", output_kind: "nonreview", default_model: "balanced", extras: { repo_brief: true } },
    // Fast-tier scout for the lean `simple` flow (same code-analyzer template).
    // The cheap tier produces a context doc the planner reads instead of cold-
    // reading the whole repo — the planner is the run's costliest agent, so a
    // cheap pre-read pays for itself. medium/complex keep the balanced
    // `code-analyzer` (the `enrich` stage); the flow picks the tier, since a
    // single static default_model cannot be tier-by-flow.
    { name: "code-analyzer-light", template_path: "agents/code-analyzer.md", output_kind: "nonreview", default_model: "fast", extras: { repo_brief: true } },
    {
      name: "architect",
      template_path: "agents/architect.md",
      output_kind: "nonreview",
      // Design-advisory only: it writes architecture-decisions.md on a complex
      // task and is biased toward the smallest design that fits — it never
      // writes code. The balanced tier carries that judgement; the planner and
      // implementer that turn the advice into code keep the premium tier.
      default_model: "balanced",
      applies_to: (s) => decisionEquals(s, "complexity", "complex"),
      extras: { repo_brief: true },
    },
    // The always-relevant reviewers self-gate on `source_changed`: a doc-only
    // outcome (every changed file a doc) sets it false in `pre-review`, so the
    // panel does not burn a full adversarial review on a hand-off `.md`. The
    // `!== false` guard keeps them running everywhere the flag is unset —
    // `plan-review` (planning, before any diff) and any host that reports no
    // files — so the only suppression is the evidenced doc-only case.
    // Review depth scales with the classifier's complexity. The base logic +
    // challenger reviewers run the balanced tier — wired into the medium flow's
    // `review` / `plan-review` fanouts and the simple flow's `review-light`. The
    // `-deep` variants right below run the premium tier and are wired ONLY into
    // the complex flow's `review-deep` / `plan-review-deep` fanouts. Same
    // template, same self-gate — only the tier differs, so a routine change pays
    // for the balanced reviewer while a high-blast-radius complex change still
    // earns the premium one. A single static `default_model` cannot be
    // tier-by-complexity (one agent name spans both the medium and complex
    // fanouts), so the split is one agent per tier, selected by the flow.
    {
      name: "logic-reviewer",
      template_path: "agents/logic-reviewer.md",
      output_kind: "reviewer",
      default_model: "balanced",
      applies_to: (s) => checksAllow(s) && s.decisions["source_changed"] !== false && reworkAllowsReviewer(s, "logic-reviewer"),
    },
    {
      name: "logic-reviewer-deep",
      template_path: "agents/logic-reviewer.md",
      output_kind: "reviewer",
      default_model: "premium",
      applies_to: (s) => checksAllow(s) && s.decisions["source_changed"] !== false && reworkAllowsReviewer(s, "logic-reviewer-deep"),
    },
    // The adversarial challenger is the most expensive reviewer, so it also
    // gates on `change_kind`: a config-only / docs-only / type-only / pure
    // refactor change has no logical-correctness-under-stress surface for it to
    // probe, so the `review` fanout's `filter_by_change_kind` drops it there.
    // An unset / unknown change_kind drops no one (the kernel filter is a no-op
    // when the value is null) — scrutiny is never lowered on uncertainty.
    {
      name: "challenger-reviewer",
      template_path: "agents/challenger-reviewer.md",
      output_kind: "reviewer",
      default_model: "balanced",
      applies_to: (s) => checksAllow(s) && s.decisions["source_changed"] !== false && reworkAllowsReviewer(s, "challenger-reviewer"),
      relevant_for_change_kinds: ["logic", "perf-sensitive", "security-sensitive"],
    },
    {
      name: "challenger-reviewer-deep",
      template_path: "agents/challenger-reviewer.md",
      output_kind: "reviewer",
      default_model: "premium",
      applies_to: (s) => checksAllow(s) && s.decisions["source_changed"] !== false && reworkAllowsReviewer(s, "challenger-reviewer-deep"),
      relevant_for_change_kinds: ["logic", "perf-sensitive", "security-sensitive"],
    },
    {
      name: "style-reviewer",
      template_path: "agents/style-reviewer.md",
      output_kind: "reviewer",
      default_model: "fast",
      applies_to: (s) => checksAllow(s) && s.decisions["source_changed"] !== false && reworkAllowsReviewer(s, "style-reviewer"),
      relevant_for_change_kinds: ["logic", "ui", "perf-sensitive", "security-sensitive"],
    },
    {
      name: "security",
      template_path: "agents/security.md",
      output_kind: "reviewer",
      default_model: "balanced",
      applies_to: (s) => checksAllow(s) && s.decisions["security_needed"] !== false && reworkAllowsReviewer(s, "security"),
      relevant_for_change_kinds: ["logic", "ui", "security-sensitive", "perf-sensitive", "config-only"],
    },
    {
      name: "performance",
      template_path: "agents/performance.md",
      output_kind: "reviewer",
      default_model: "balanced",
      applies_to: (s) => checksAllow(s) && s.decisions["source_changed"] !== false && reworkAllowsReviewer(s, "performance"),
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
      applies_to: (s) => checksAllow(s) && decisionEquals(s, "ui_touched", true),
    },
    {
      name: "api-contract",
      template_path: "agents/api-contract.md",
      output_kind: "validator",
      default_model: "fast",
      applies_to: (s) => checksAllow(s) && decisionEquals(s, "api_touched", true),
    },
    {
      name: "playwright",
      template_path: "agents/playwright.md",
      output_kind: "validator",
      default_model: "fast",
      applies_to: (s) => checksAllow(s) && decisionEquals(s, "ui_touched", true),
    },
    // The answer-flow responder: reads the repo and answers the operator's
    // question. Single-shot (it edits nothing — the empty-diff guard must not
    // apply); `output_kind: classifier` so its structured `{ "answer": … }`
    // lands in decisions for the `apply-answer` step to pick up.
    { name: "responder", template_path: "agents/responder.md", output_kind: "classifier", default_model: "balanced" },
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
    // The classifier spawn self-skips when the operator pinned the complexity
    // (fast-task / complexity selector) — the stage stays in every flow's prefix
    // so the complexity switch keeps step_index aligned, but it launches nothing
    // and the switch routes on the pinned value.
    "classify-agent": {
      kind: "spawn",
      name: "classify-agent",
      phase: "context",
      agent: "classifier",
      when: shouldClassify,
    },
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
    // Fast-tier repo scout for the simple flow — runs the cheap code-analyzer so
    // the planner reads a context doc instead of cold-reading the repo.
    "enrich-light": { kind: "spawn", name: "enrich-light", phase: "context", agent: "code-analyzer-light" },
    "context-verify": { kind: "spawn", name: "context-verify", phase: "context", agent: "context-doc-verifier" },
    architect: { kind: "spawn", name: "architect", phase: "context", agent: "architect" },
    plan: { kind: "spawn", name: "plan", phase: "planning", agent: "planner" },
    // Premium-tier planner for the complex flow only (same template as `plan`).
    "plan-deep": { kind: "spawn", name: "plan-deep", phase: "planning", agent: "planner-deep" },
    "plan-grounding": { kind: "spawn", name: "plan-grounding", phase: "planning", agent: "plan-grounding-check" },
    "plan-review": {
      kind: "fanout",
      name: "plan-review",
      phase: "planning",
      agents: ["plan-grounding-check", "logic-reviewer"],
      iteration_budget: { kind: "attempt", max_iterations: 2, on_exhaustion: "audit-only" },
    },
    // Premium-tier plan review for the complex flow — identical to `plan-review`
    // but the logical-correctness pass runs the `-deep` (premium) reviewer. Only
    // the complex flow wires this in; medium keeps `plan-review` (balanced).
    "plan-review-deep": {
      kind: "fanout",
      name: "plan-review-deep",
      phase: "planning",
      agents: ["plan-grounding-check", "logic-reviewer-deep"],
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
    // Answer flow: one responder spawn, then land its answer as the summary.
    respond: { kind: "spawn", name: "respond", phase: "implementation", agent: "responder" },
    "apply-answer": {
      kind: "step",
      name: "apply-answer",
      phase: "validation",
      position: "positional",
      effects: [
        { kind: "bundle_state.set", path: "answer" },
        { kind: "decisions.set", key: "answer" },
      ],
      run: applyAnswer,
    },
    "test-first": { kind: "spawn", name: "test-first", phase: "test_first", agent: "test" },
    "git-stash": { kind: "step", name: "git-stash", phase: "implementation", position: "positional", effects: [] },
    implement: { kind: "spawn", name: "implement", phase: "implementation", agent: "implementer" },
    // Escalation round: the premium implementer takes over once the base one has
    // stalled (two prior rounds blocked). The two `implement*` stages sit back to
    // back and self-gate on the SAME predicate, so exactly one fires per round —
    // the same shape the planner uses (`plan` vs `plan-deep`), but selected by
    // the rework round rather than the flow.
    "implement-escalated": { kind: "spawn", name: "implement-escalated", phase: "implementation", agent: "implementer-escalated" },
    // Record the escalation as a decision the gate operator sees. Positional,
    // right after the implement spawns and before the diff/review, so it reads
    // the prior rounds' verdicts. No-op until escalation fires.
    "note-escalation": {
      kind: "step",
      name: "note-escalation",
      phase: "implementation",
      position: "positional",
      effects: [{ kind: "decisions.set", key: "implementer_escalated" }],
      run: recordImplementerEscalation,
    },
    "git-diff": {
      kind: "step",
      name: "git-diff",
      phase: "implementation",
      position: "positional",
      effects: [{ kind: "bundle_state.set", path: "diff_snapshot" }],
      run: snapshotDiff,
    },
    // Deterministic pre-review checks: a spawn routed (by the `checks`
    // execution capability) to the shell-out executor that runs typecheck /
    // lint / test in the task worktree, immediately after the diff is captured
    // and BEFORE any review token is spent. Always runs (no `when`); a project
    // with nothing configured/detected records every check as skipped.
    "run-checks": { kind: "spawn", name: "run-checks", phase: "implementation", agent: "checks-runner" },
    // Read the checks envelope back into bundle_state (activating the safety
    // floor), synthesize a blocking finding per failed check (→ walk-back +
    // open-blocker hand-off to the implementer), and set `checks_ok` so the
    // review fanout self-gates off a broken round.
    "apply-checks": {
      kind: "step",
      name: "apply-checks",
      phase: "implementation",
      position: "positional",
      effects: [
        { kind: "bundle_state.set", path: "typecheck" },
        { kind: "bundle_state.set", path: "lint_result" },
        { kind: "bundle_state.set", path: "test_run" },
        { kind: "decisions.set", key: "checks_ok" },
        { kind: "decisions.set", key: "checks" },
        { kind: "finding.insert", phase: "implementation" },
        { kind: "audit.emit", type: "checks-recorded" },
      ],
      run: applyChecks,
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
    // Premium-tier code review for the complex flow — identical to `review` but
    // the logic + challenger passes run the `-deep` (premium) reviewers. The
    // file-conditional validators and the cheaper style/security/perf reviewers
    // are unchanged (already on appropriate tiers). Only the complex flow wires
    // this in; medium keeps `review` (balanced logic + challenger).
    "review-deep": {
      kind: "fanout",
      name: "review-deep",
      phase: "implementation",
      agents: [
        "logic-reviewer-deep",
        "challenger-reviewer-deep",
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
    "final-checks": { kind: "spawn", name: "final-checks", phase: "validation", agent: "acceptance", when: shouldRunAcceptance },
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
    // Fast-task path: a SINGLE implementer spawn → checks → finalize. No gates,
    // no reviewers, no planner — selected by pinning `complexity=trivial` (the ⚡
    // toggle), which also self-skips the classifier spawn. Shares the
    // [initialize, classify, classify-agent, stack-to-bundle-state] prefix with
    // the other flows (the loader verifies it) so the complexity switch lands
    // here without misaligning step_index; `git-diff` records the touched-file
    // surface, then the deterministic checks run. There is no review round to
    // share an iteration budget with, so a check failure does not loop — the
    // synthesized blocking finding survives to `finalize`, where the
    // accepted-with-a-live-blocker invariant parks the task for a human instead
    // of auto-accepting broken code.
    trivial: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state",
      "implement", "git-diff", "run-checks", "apply-checks", "finalize",
    ],
    // Informational path: the task asks a QUESTION about the project ("how do
    // I run the backend?", "why does X happen?") — nothing should be edited.
    // One responder spawn reads the repo and answers; `apply-answer` lands the
    // answer as the task's completion summary. No checks (nothing changed),
    // no reviewers, no gates — the answer IS the deliverable, and the
    // operator reads it where every finished task's summary lives.
    answer: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state",
      "respond", "apply-answer", "finish-summary", "finalize",
    ],
    // Lean path for routine work: a fast-tier scout (enrich-light), one planner,
    // one implementer, ONE reviewer (review-light), acceptance, the final gate,
    // finalize. No gate-classify, no plan-review/review fanouts, no balanced
    // enrich/architect — ~5 agents vs medium's ~10+. The scout runs before plan
    // so the planner reads a context doc instead of cold-reading the repo.
    // Shares the [initialize, classify, classify-agent] prefix with the other
    // flows so the complexity switch lands here without misaligning step_index.
    simple: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state",
      "enrich-light", "plan", "implement", "implement-escalated", "note-escalation",
      "git-diff", "run-checks", "apply-checks", "pre-review",
      "review-light", "final-checks", "gate-final", "finish-summary", "finalize",
    ],
    medium: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state", "gate-classify",
      "enrich", "plan", "plan-review", "gate-plan",
      "git-stash", "implement", "implement-escalated", "note-escalation",
      "git-diff", "run-checks", "apply-checks", "pre-review", "review",
      "adjudicate", "reconcile", "iterate", "final-checks",
      "gate-final", "finish-summary", "finalize",
    ],
    complex: [
      "initialize", "classify", "classify-agent", "stack-to-bundle-state", "gate-classify",
      "enrich", "context-verify", "architect",
      "plan-deep", "plan-review-deep", "gate-plan",
      "test-first", "git-stash", "implement", "implement-escalated", "note-escalation",
      "git-diff", "run-checks", "apply-checks", "pre-review", "review-deep",
      "adjudicate", "reconcile", "iterate", "sacred-tests",
      "final-checks", "gate-final", "finish-summary", "finalize",
    ],
  },

  hooks: [
    { name: "observe-implementer-output", event: "after-agent-result", filter: (ctx) => ctx.agent === "implementer", run: observeImplementerOutput, idempotent: true },
    { name: "observe-review-fanout", event: "before-fanout", filter: (ctx) => ctx.stage === "review" || ctx.stage === "review-deep", run: observeReviewFanout, idempotent: true },
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
    // The hard-validation output contract every finding-emitting agent must
    // honour (task_id / summary_line / id / schema_version rules). It was
    // byte-identical at the foot of all 13 reviewer + validator prompts; held
    // ONCE here and injected into each via the spawn context, so the rules
    // cannot drift between agents. The adjudicator carries its own contract
    // (info-severity markers, location echo) and is intentionally not listed.
    {
      heading: "Output contract (hard validation)",
      kind: "file",
      path: "knowledge/output-contract.md",
      agents: [
        "logic-reviewer",
        "logic-reviewer-deep",
        "challenger-reviewer",
        "challenger-reviewer-deep",
        "style-reviewer",
        "security",
        "performance",
        "plan-grounding-check",
        "plan-conformance",
        "context-doc-verifier",
        "acceptance",
        "test",
        "ui-consistency",
        "api-contract",
        "playwright",
      ],
    },
  ],
});
