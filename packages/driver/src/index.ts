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

export { drive } from "./drive.js";
export type {
  DriveError,
  DriveOptions,
  DriveOutcome,
  Executor,
  ExecutorResult,
} from "./drive.js";

export { createProviderExecutor } from "./provider-executor.js";
