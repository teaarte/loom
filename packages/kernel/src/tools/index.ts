// Pipeline-provided file tools for direct (non-shuttle) providers.
//
// A shuttle provider inherits its host's tool inventory and sandbox; a
// direct provider (no host tools) gets these path-disciplined
// implementations instead. The catalog is intentionally read/list/search +
// a guarded write — no `bash`: a shell tool must not be offered without a
// native process sandbox, which this surface does not provide.

import type { ToolDefinition } from "../types/tool.js";

import { fileGlobTool } from "./file-glob.js";
import { fileReadTool } from "./file-read.js";
import { fileWriteTool } from "./file-write.js";
import { grepTool } from "./grep.js";

export { fileReadTool } from "./file-read.js";
export { fileWriteTool } from "./file-write.js";
export { fileGlobTool } from "./file-glob.js";
export { grepTool } from "./grep.js";

export const DEFAULT_TOOL_CATALOG: readonly ToolDefinition[] = [
  fileReadTool,
  fileWriteTool,
  fileGlobTool,
  grepTool,
];
