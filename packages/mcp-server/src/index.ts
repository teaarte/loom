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

export { createTransportAdapter, shape } from "./transport-adapter.js";

export { FLAG_TO_PRESET, parseTaskArgs } from "./lib/parse-task-args.js";

export type {
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
  RunTaskInput,
  RunTaskResponse,
  SpawnRequest,
  StateGetFormat,
  StateGetInput,
  ToolHandler,
  TransportResponse,
} from "./types.js";
