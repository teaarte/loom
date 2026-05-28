// Public barrel — anything callers import as `@loom/mcp-server` lives
// here. Internal tool modules and the version constants stay private
// to the package layout.

export { createServer, runStdioServer } from "./server.js";
export type { CreateServerHandle, ToolRegistry } from "./server.js";

export { createMetaTool } from "./tools/meta.js";
export type { MetaInputWithProject } from "./tools/meta.js";
export { createStateGetTool } from "./tools/state-get.js";
export { createExtensionsListTool } from "./tools/extensions-list.js";

export { FLAG_TO_PRESET, parseTaskArgs } from "./lib/parse-task-args.js";

export type {
  ClientCapabilities,
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
  StateGetFormat,
  StateGetInput,
  ToolHandler,
} from "./types.js";
