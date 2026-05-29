// file_read — read a UTF-8 file from within the project workspace.
//
// Every path goes through `resolveSafePath` against `ctx.project_dir`, so a
// path that escapes the project or hits the sensitive blocklist is refused
// before any disk touch. Each call emits exactly one audit payload through
// `ctx.audit_emit` (type "tool-call"); a refusal carries
// `error_class: "sandbox-violation"`. The tool never reads a clock — any
// timing the audit needs is the caller's to supply.

import { readFile } from "node:fs/promises";

import { resolveSafePath } from "../sandbox/resolve-safe-path.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.js";

export const fileReadTool: ToolDefinition = {
  name: "file_read",
  description: "Read a UTF-8 file from within the project workspace.",
  schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the project directory.",
      },
    },
    required: ["path"],
  },
  async handler(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const path = typeof input.path === "string" ? input.path : "";
    const resolved = await resolveSafePath(path, ctx.project_dir);
    if (!resolved.ok) {
      ctx.audit_emit({
        type: "tool-call",
        tool: "file_read",
        path,
        error_class: "sandbox-violation",
        reason: resolved.reason,
        verdict: "refused",
      });
      return { error: `path refused: ${resolved.reason}` };
    }
    try {
      const content = await readFile(resolved.path, "utf8");
      ctx.audit_emit({
        type: "tool-call",
        tool: "file_read",
        path,
        bytes_read: Buffer.byteLength(content, "utf8"),
        verdict: "ok",
      });
      return { content };
    } catch (err) {
      ctx.audit_emit({
        type: "tool-call",
        tool: "file_read",
        path,
        verdict: "error",
        message: String(err),
      });
      return { error: `read failed: ${String(err)}` };
    }
  },
};
