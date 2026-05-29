// file_glob — list project files matching a glob pattern.
//
// The walk is rooted at `ctx.project_dir` and every candidate is run through
// `resolveSafePath`, so sensitive files (`.env`, key material, …) never
// appear in the listing even when a pattern would match them. Results are
// sorted for a deterministic, replay-stable order. Heavy vendored trees are
// skipped so a glob over a real project doesn't enumerate dependencies.
// One audit payload per call; no clock read.

import { sep } from "node:path";

import { resolveSafePath } from "../sandbox/resolve-safe-path.js";
import { walkProjectFiles } from "./walk-project-files.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types/tool.js";

// Translate a glob to an anchored RegExp over POSIX-style relative paths.
// `**` crosses directory boundaries, `*` and `?` do not.
function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if ("\\.+^$|()[]{}".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

export const fileGlobTool: ToolDefinition = {
  name: "file_glob",
  description:
    "List project files matching a glob pattern (** crosses directories).",
  schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern relative to the project directory.",
      },
    },
    required: ["pattern"],
  },
  async handler(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const re = globToRegExp(pattern);

    const found = await walkProjectFiles(ctx.project_dir, "relative");

    const matches: string[] = [];
    for (const rel of found) {
      const posix = sep === "/" ? rel : rel.split(sep).join("/");
      if (!re.test(posix)) continue;
      // Re-validate: a matched path must still clear the path discipline so
      // sensitive files never surface in a listing.
      const resolved = await resolveSafePath(rel, ctx.project_dir);
      if (!resolved.ok) continue;
      matches.push(posix);
    }
    matches.sort();

    ctx.audit_emit({
      type: "tool-call",
      tool: "file_glob",
      pattern,
      match_count: matches.length,
      verdict: "ok",
    });
    return { content: matches.join("\n") };
  },
};
