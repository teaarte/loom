// file_write — write a UTF-8 file within the project workspace.
//
// Two refusals, both BEFORE any disk touch: (1) the shared path discipline
// (`resolveSafePath` against `ctx.project_dir`), and (2) the substrate's own
// state database. The kernel owns `<project>/.loom/state.db` and its WAL
// siblings; a tool write there would tear the transaction journal out from
// under the FSM, so it is refused with a distinct reason rather than left to
// SQLite to detect after the damage. Each call emits exactly one audit
// payload; refusals carry `error_class: "sandbox-violation"`. No clock read.

import { writeFile } from "node:fs/promises";
import { sep } from "node:path";

import {
  KERNEL_SENSITIVE_PATH_RULES,
  resolveSafePath,
} from "../sandbox/resolve-safe-path.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.js";

// The kernel's state DB plus the SQLite sidecar files that share its
// integrity. A write to any of these would corrupt live FSM state.
const PROTECTED_DB_SUFFIXES = [
  `${sep}.loom${sep}state.db`,
  `${sep}.loom${sep}state.db-wal`,
  `${sep}.loom${sep}state.db-shm`,
  `${sep}.loom${sep}state.db-journal`,
];

function isProtectedStateDb(resolvedPath: string): boolean {
  return PROTECTED_DB_SUFFIXES.some((suffix) => resolvedPath.endsWith(suffix));
}

export const fileWriteTool: ToolDefinition = {
  name: "file_write",
  description: "Write a UTF-8 file within the project workspace.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the project directory.",
      },
      content: {
        type: "string",
        description: "File contents to write (UTF-8).",
      },
    },
    required: ["path", "content"],
  },
  async handler(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const path = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";

    const resolved = await resolveSafePath(
      path,
      ctx.project_dir,
      ctx.sensitive_path_rules ?? KERNEL_SENSITIVE_PATH_RULES,
    );
    if (!resolved.ok) {
      ctx.audit_emit({
        type: "tool-call",
        tool: "file_write",
        path,
        error_class: "sandbox-violation",
        reason: resolved.reason,
        verdict: "refused",
      });
      return { error: `path refused: ${resolved.reason}` };
    }

    if (isProtectedStateDb(resolved.path)) {
      ctx.audit_emit({
        type: "tool-call",
        tool: "file_write",
        path,
        error_class: "sandbox-violation",
        reason: "state-db-protected",
        verdict: "refused",
      });
      return {
        error:
          "path refused: state-db-protected (the kernel owns .loom/state.db)",
      };
    }

    try {
      await writeFile(resolved.path, content, "utf8");
      ctx.audit_emit({
        type: "tool-call",
        tool: "file_write",
        path,
        bytes_written: Buffer.byteLength(content, "utf8"),
        verdict: "ok",
      });
      return { content: `wrote ${Buffer.byteLength(content, "utf8")} bytes` };
    } catch (err) {
      ctx.audit_emit({
        type: "tool-call",
        tool: "file_write",
        path,
        verdict: "error",
        message: String(err),
      });
      return { error: `write failed: ${String(err)}` };
    }
  },
};
