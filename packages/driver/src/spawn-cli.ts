// Shared child-process capture for CLI backends.
//
// Both headless backends shell out to an external CLI and read its stdout: the
// `claude -p` backend spawns `claude` in the worktree, and the container
// backend spawns `docker run … claude -p` (the same JSON envelope, wrapped).
// They share identical machinery — capture stdout/stderr, map ENOENT to a
// clean "binary not found" refusal, fail loudly on a non-zero exit — so it
// lives here once. The caller parses the captured stdout (both backends parse
// the same `claude -p` JSON via `parseClaudeResult` / `parseClaudeUsage`).
//
// No npm dep: this is `node:child_process`, the same posture as shelling to
// `claude`.

import { spawn } from "node:child_process";

import { KernelError } from "@loomfsm/kernel";

export interface SpawnCaptureOptions {
  bin: string;
  args: string[];
  // Used in the non-zero-exit failure message (e.g. "claude -p", "docker run").
  label: string;
  // The ENOENT refusal message — backend-specific install guidance.
  notFoundMessage: string;
  cwd?: string;
  // Child environment (the container backend passes the OAuth token here so it
  // is forwarded by `-e NAME` and never lands on the command line).
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

// Spawn the CLI and resolve with its stdout on a clean (exit 0) run. Rejects
// with EXECUTOR_NOT_FOUND on ENOENT and EXECUTOR_FAILED on a non-zero exit —
// the loop's executor-retry / error-surfacing handles both.
export function spawnCapture(opts: SpawnCaptureOptions): Promise<string> {
  return new Promise<string>((resolveRun, reject) => {
    const child = spawn(opts.bin, opts.args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") {
        reject(
          new KernelError({
            code: "EXECUTOR_NOT_FOUND",
            message: opts.notFoundMessage,
            detail: { bin: opts.bin },
          }),
        );
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new KernelError({
            code: "EXECUTOR_FAILED",
            message: `${opts.label} exited with code ${exitCode}`,
            detail: { exit_code: exitCode, stderr_head: stderr.slice(0, 1000) },
          }),
        );
        return;
      }
      resolveRun(stdout);
    });
  });
}
