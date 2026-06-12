// Per-agent EXECUTION shape the code bundle declares — "does this agent need a
// file/shell tool harness, or is it a single model call?".
//
// Held in the bundle, NOT the kernel, so the substrate names no execution-mode
// field (the same posture as `CODE_BUNDLE_SENSITIVE_PATH_RULES` and the build
// `StackInfo`). A non-Claude backend uses this to pick the harness: an
// `agentic` agent (one that EDITS FILES) runs through an agentic CLI harness
// (worktree + tool loop); a `single-shot` agent is one model call. Claude Code
// brings its own loop, so it ignores this — the distinction only matters off
// Claude. The consumer (the CLI's per-spawn dispatch) reads it through a generic
// injected hook keyed by agent NAME; it hardcodes none of these names.
//
// Only the file-editing agent is `agentic`; every other agent (classifier,
// reviewers, validators, planner/research/architect — which produce a decision
// or a document from their prompt context) defaults to `single-shot`, so the
// map lists only the exception. A future agent that edits files adds a row here.

// A third shape beyond agentic/single-shot: `checks` is NOT a model call. The
// agent runs the project's deterministic validation commands (typecheck / lint
// / test) and reports their exit codes, so the dispatch routes it to the
// deterministic checks executor and resolves no backend or credential for it.
export type AgentExecution = "single-shot" | "agentic" | "checks";

export const CODE_BUNDLE_AGENT_EXECUTION: Readonly<Record<string, AgentExecution>> = {
  implementer: "agentic",
  // The escalation-round implementer edits files exactly like the base one, so
  // it needs the same worktree harness + empty-diff guard off Claude Code.
  "implementer-escalated": "agentic",
  "checks-runner": "checks",
};
