// path-restricted — the cross-platform default outer boundary.
//
// This is filesystem discipline ONLY: no chroot, no process namespace, no
// network restriction. Its read_file / write_file route every path through
// `resolveSafePath`, so a path that escapes the project or hits the
// sensitive blocklist is refused. Its `exec` REFUSES rather than spawning:
// containing a subprocess needs a native OS sandbox, and pretending to
// contain one while actually running it unconfined would be worse than an
// honest refusal. Native OS isolation lands additively as separate kinds.

import { readFile, writeFile } from "node:fs/promises";

import { KernelError } from "../state/db.js";
import type {
  ExecOptions,
  ExecResult,
  SandboxPlugin,
} from "../types/plugins.js";

import { resolveSafePath } from "./resolve-safe-path.js";

export function createPathRestrictedSandbox(projectDir: string): SandboxPlugin {
  return {
    name: "path-restricted",
    capabilities: {
      filesystem_isolation: true,
      network_isolation: false,
      process_isolation: false,
      resource_limits: false,
    },

    async exec(_cmd: string, _opts: ExecOptions): Promise<ExecResult> {
      // 126 is the conventional "command found but cannot execute" code.
      // No process is spawned — the refusal is structural.
      return {
        exit_code: 126,
        stdout: "",
        stderr:
          "path-restricted provides filesystem discipline only and cannot " +
          "contain a subprocess; configure a native OS sandbox to run commands",
        duration_ms: 0,
        timed_out: false,
      };
    },

    async read_file(path: string): Promise<string> {
      const resolved = await resolveSafePath(path, projectDir);
      if (!resolved.ok) {
        throw new KernelError({
          code: "SANDBOX_VIOLATION",
          message: `read refused: ${resolved.reason}`,
          detail: { path, reason: resolved.reason, sandbox: "path-restricted" },
        });
      }
      return readFile(resolved.path, "utf8");
    },

    async write_file(path: string, content: string): Promise<void> {
      const resolved = await resolveSafePath(path, projectDir);
      if (!resolved.ok) {
        throw new KernelError({
          code: "SANDBOX_VIOLATION",
          message: `write refused: ${resolved.reason}`,
          detail: { path, reason: resolved.reason, sandbox: "path-restricted" },
        });
      }
      await writeFile(resolved.path, content, "utf8");
    },
  };
}
