// Public barrel — anything callers import as `@loom/mcp-server` lives
// here. Internal tool modules and the version constants stay private
// to the package layout.

export { createServer, runStdioServer } from "./server.js";
export type { CreateServerHandle, ServerDeps, ToolRegistry } from "./server.js";

export { createMetaTool } from "./tools/meta.js";
export type { MetaInputWithProject } from "./tools/meta.js";
export { createStateGetTool } from "./tools/state-get.js";
export { createExtensionsListTool } from "./tools/extensions-list.js";
export { createRunTaskTool } from "./tools/run-task.js";
export type { RunTaskDeps } from "./tools/run-task.js";
export { createContinueTaskTool } from "./tools/continue-task.js";
export type { ContinueTaskDeps } from "./tools/continue-task.js";
export { createRecoverTool } from "./tools/recover.js";
export type { RecoverDeps } from "./tools/recover.js";
export { createBackupTool } from "./tools/backup.js";
export type { BackupDeps } from "./tools/backup.js";
export { createRestoreTool } from "./tools/restore.js";
export type { RestoreDeps } from "./tools/restore.js";

export { createTransportAdapter, shape } from "./transport-adapter.js";

export { FLAG_TO_PRESET, parseTaskArgs } from "./lib/parse-task-args.js";

export type {
  BackupInput,
  BackupResponse,
  ClientCapabilities,
  ContinueTaskRequestInput,
  ContinueTaskResponse,
  ExtensionsListEntry,
  ExtensionsListInput,
  ExtensionsListResponse,
  ExtensionStatus,
  MetaBundle,
  MetaInput,
  MetaProviders,
  MetaSandbox,
  MetaTransports,
  ParsedTaskArgs,
  PipelineMetaResponse,
  PipelineStateView,
  RecoverTaskInput,
  RecoverTaskResponse,
  RecoveryChoiceInput,
  RestoreInput,
  RestoreResponse,
  RunTaskInput,
  RunTaskResponse,
  SpawnRequest,
  StateGetFormat,
  StateGetInput,
  ToolHandler,
  TransportResponse,
} from "./types.js";
