// Public barrel for `@loomfsm/server` — the network control plane: an HTTP
// transport over the headless `drive()` loop and a registry that supervises a
// fleet of projects from one process. It is the THIRD consumer of `drive()`
// (after `loom run` and the daemon), reached over the network instead of a
// terminal: submit a task, read status, answer a gate, all as HTTP routes that
// delegate to the same compositions every transport shares.
//
// No HTTP- or kernel-specific kernel API: every route body is `submitTask` /
// `answerGate` / the read-model over existing kernel/driver/daemon primitives.
// Bundle- and domain-blind (the domain-leak gate is copied into this package).

export { startControlPlane, DEFAULT_HOST, DEFAULT_PORT } from "./control-plane.js";
export type { ControlPlaneOptions, ControlPlaneHandle } from "./control-plane.js";

export { createControlServer } from "./http.js";
export type { ControlServerDeps } from "./http.js";

export { SupervisorRegistry, projectId } from "./registry.js";
export type { RegistryDeps, ProjectListing } from "./registry.js";

export { submitTask, deterministicUuid } from "./submit.js";
export type { SubmitArgs, SubmitResult } from "./submit.js";

export { answerGate, parseAnswer } from "./answer.js";
export type { AnswerArgs, AnswerResult } from "./answer.js";

export { readProjectStatus } from "./read-model.js";
export type { ProjectStatusView, PendingAgentView } from "./read-model.js";

export { readLogTail, daemonLogPath } from "./log-tail.js";
export type { LogLine } from "./log-tail.js";

export { Semaphore } from "./semaphore.js";
export { gatedExecutor } from "./executor-gate.js";

export { ServerError, fromKernelError } from "./errors.js";

export {
  acquireServerLock,
  signalServerStop,
  readServerStatus,
  clearServerStatus,
  readRegisteredProjects,
  writeRegisteredProjects,
  defaultServerStateDir,
  serverStatusPath,
  registeredProjectsPath,
  ServerControlError,
} from "./process-control.js";
export type { ServerStatus, ServerPhase, ServerHandle, StopResult } from "./process-control.js";

export { DASHBOARD_HTML } from "./dashboard/page.js";
