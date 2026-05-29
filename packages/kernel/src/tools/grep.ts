// grep — search project file contents for a regular expression.
//
// Walks from `ctx.project_dir`, routes every file through `resolveSafePath`
// (so secret-bearing files are never searched, not even incidentally), and
// returns `relative/path:lineno:line` hits. It declares a `truncate-head`
// output-compression policy: on a large result set the tail — where the most
// recent / most relevant matches sit — is what survives, and the kernel
// applies the (deterministic) compression downstream. One audit payload per
// call; no clock read.

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

import { resolveSafePath } from "../sandbox/resolve-safe-path.js";
import { walkProjectFiles } from "./walk-project-files.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.js";

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "Search project file contents for a regular expression.",
  schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search for.",
      },
    },
    required: ["pattern"],
  },
  // Match-heavy searches blow past a sane token budget; keep the tail (most
  // relevant hits) and let the kernel compress deterministically.
  output_compression: {
    strategy: "truncate-head",
    threshold_bytes: 4000,
    target_bytes: 2000,
  },
  async handler(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      ctx.audit_emit({
        type: "tool-call",
        tool: "grep",
        pattern,
        verdict: "error",
        message: `invalid pattern: ${String(err)}`,
      });
      return { error: `invalid pattern: ${String(err)}` };
    }

    const files = await walkProjectFiles(ctx.project_dir, "absolute");

    const hits: { path: string; line: number; text: string }[] = [];
    for (const full of files) {
      const rel = relative(ctx.project_dir, full);
      const resolved = await resolveSafePath(rel, ctx.project_dir);
      if (!resolved.ok) continue;
      let text: string;
      try {
        text = await readFile(resolved.path, "utf8");
      } catch {
        continue;
      }
      const posix = sep === "/" ? rel : rel.split(sep).join("/");
      const lines = text.split("\n");
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n] as string;
        if (re.test(line)) hits.push({ path: posix, line: n + 1, text: line });
      }
    }
    // Deterministic order independent of filesystem walk order: by path,
    // then by numeric line (so `:9` precedes `:10`).
    hits.sort((a, b) =>
      a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1,
    );
    const rendered = hits.map((h) => `${h.path}:${h.line}:${h.text}`);

    ctx.audit_emit({
      type: "tool-call",
      tool: "grep",
      pattern,
      match_count: hits.length,
      verdict: "ok",
    });
    return { content: rendered.join("\n") };
  },
};
