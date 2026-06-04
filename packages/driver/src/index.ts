// Public barrel for `@loomfsm/driver` — the transport-neutral
// orchestration runtime: the directive→wire adapter, the conformant
// delivery/create/recover compositions, the resume-form re-emit, the
// server-side file delta, and the headless driver-loop with its Executor
// seam. Every loom transport (the stdio tools, the headless loop, and any
// future one) shares these so the directive contract is implemented once.

export { createTransportAdapter, shape } from "./adapter.js";

export { gitBaselineRef, gitDelta } from "./git-delta.js";
export type { GitDelta } from "./git-delta.js";
export { persistDeltaBaseline, readDeltaBaseline } from "./delta-baseline.js";
export { persistDriverStepIndex } from "./progress.js";

export { writeAuditRow, readTaskId } from "./audit.js";
export type { AuditRowArgs } from "./audit.js";

export { resumeDirective } from "./resume-directive.js";

export {
  createAndStart,
  deliverAndAdvance,
  recoverAndAdvance,
  ledgerKeysFor,
  readState,
} from "./compositions.js";
export type {
  CreateAndStartArgs,
  CreateAndStartResult,
  DeliverAndAdvanceArgs,
  DeliverAndAdvanceResult,
  RecoverAndAdvanceArgs,
  RecoverAndAdvanceResult,
} from "./compositions.js";

// The per-task agent-chain reader — the read peer of `readState`, used by a
// transport to project a task's recorded chain (live or archived) domain-blind.
export { readTrace, readTraceFile } from "./trace.js";
export type {
  TraceView,
  TraceSummary,
  TraceAgent,
  TraceFinding,
  TraceVerdict,
  TraceGate,
} from "./trace.js";

export { drive } from "./drive.js";
export type {
  DriveError,
  DriveOptions,
  DriveOutcome,
  Executor,
  ExecutorResult,
  SpawnUsage,
} from "./drive.js";

export { createProviderExecutor } from "./provider-executor.js";
export type {
  ProviderExecutorOptions,
  ProviderErrorRateLimitDetector,
} from "./provider-executor.js";

// Per-spawn executor dispatch — route each spawn to the backend resolved for it
// (the transport builds the resolver; this shell stays backend-blind).
export { createDispatchExecutor } from "./dispatch-executor.js";
export type { DispatchExecutorOptions, ResolveExecutor } from "./dispatch-executor.js";

// The sandboxed-executor shell (per-task isolation + self-diff) and its
// chosen headless backends — `claude -p` on the user's subscription login,
// either in a worktree (default) or inside a container (the isolation fence
// that makes bypassPermissions safe).
export { createSandboxedExecutor } from "./sandboxed-executor.js";
export type { RunSpawn, RunSpawnResult, SandboxedExecutorOptions } from "./sandboxed-executor.js";
export {
  createClaudeCodeExecutor,
  buildClaudeArgs,
  parseClaudeResult,
  parseClaudeUsage,
} from "./claude-code-executor.js";
export type { ClaudeCodeExecutorOptions } from "./claude-code-executor.js";
export { createContainerExecutor, buildDockerArgs, dockerAvailable } from "./container-executor.js";
export type { ContainerExecutorOptions, DockerArgsOptions } from "./container-executor.js";

// The Aider work-agent backend — an agentic CLI (model-agnostic) behind the
// same sandboxed shell, giving a non-Claude work-agent the file/shell tool loop
// `claude -p` has for free. Aider IS the loop; loom only shells out + self-diffs.
export { createAiderExecutor, buildAiderArgs, parseAiderUsage } from "./aider-executor.js";
export type { AiderExecutorOptions } from "./aider-executor.js";

// The opencode work-agent backend — a sibling agentic CLI (model-agnostic)
// behind the same sandboxed shell. opencode IS the loop; loom shells out, parses
// its JSON event stream, and self-diffs the worktree.
export { createOpencodeExecutor, buildOpencodeArgs, parseOpencodeResult } from "./opencode-executor.js";
export type { OpencodeExecutorOptions } from "./opencode-executor.js";
export { provisionWorktree, worktreePathFor } from "./worktree.js";
export type { WorktreeProvision } from "./worktree.js";
export { provisionClone, clonePathFor } from "./clone.js";

// Backend-shaped, injectable rate-limit detection at the capture seam — the
// signal the supervisor's wait disposition keys on.
export { defaultRateLimitDetector } from "./rate-limit.js";
export type { RateLimitDetector, RateLimitSignal } from "./rate-limit.js";
