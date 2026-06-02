// `createClaudeCodeExecutor` — the headless backend that runs each spawn
// through the Claude Code CLI in print mode (`claude -p`), inside the
// isolated worktree the sandboxed-executor shell provisions.
//
// Why this backend: it runs on the user's EXISTING Claude Code login — i.e.
// their subscription (OAuth/keychain) — rather than a raw Anthropic API key.
// The one rule that makes this true: NEVER pass `--bare`. `--bare` forces
// `ANTHROPIC_API_KEY`/apiKeyHelper and explicitly never reads OAuth/keychain;
// the plain invocation reads the existing login, so the run bills against the
// subscription and needs no API key configured in loom.
//
// Claude Code brings its OWN tools, sandbox, permission model, and subagents,
// so this backend needs none of loom's own file/exec tools — the agent acts
// with CC's inventory. loom contributes the git-worktree isolation (via the
// shell) and the honest self-diff; CC contributes tool gating via
// `--permission-mode`.
//
// Safe-default posture: `--permission-mode acceptEdits` lets file edits
// proceed unattended but leaves arbitrary shell GATED (a print-mode run cannot
// answer a permission prompt, so a gated tool is effectively refused). Full
// power is opt-in — the caller raises it to `bypassPermissions` only
// deliberately (the run is confined to a throwaway worktree, but it is never
// the default).
//
// The driver gains NO npm dependency: it shells out to the external `claude`
// binary via node:child_process.

import { spawn } from "node:child_process";

import { KernelError, type ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor } from "./drive.js";
import { createSandboxedExecutor, type RunSpawn } from "./sandboxed-executor.js";

const DEFAULT_PERMISSION_MODE = "acceptEdits";

export interface ClaudeCodeExecutorOptions {
  project_dir: string;
  // The CLI to invoke. Default "claude" (resolved on PATH).
  claude_bin?: string;
  // Claude Code permission mode. Default "acceptEdits" (edits proceed, shell
  // gated). Raise to "bypassPermissions" only deliberately.
  permission_mode?: string;
  // Cap on agentic turns (`claude --max-turns`). Omitted → CC's own default.
  max_turns?: number;
  // Aborts an in-flight `claude -p` when the drive is cancelled.
  signal?: AbortSignal;
  // Sink for the shell's degraded-mode notice.
  onNotice?: (message: string) => void;
  // Test seam: inject the per-spawn runner instead of spawning the real
  // binary, so the shell (worktree + self-diff) can be exercised offline.
  runSpawn?: RunSpawn;
}

// Build the argv for one `claude -p` invocation. Pure → unit-tested directly.
// Deliberately omits `--bare` so the run uses the subscription login.
export function buildClaudeArgs(
  intent: ProviderShuttleIntent,
  permissionMode: string,
  maxTurns: number | undefined,
): string[] {
  const args = [
    "-p",
    intent.prompt,
    "--output-format",
    "json",
    "--permission-mode",
    permissionMode,
  ];
  // A placeholder model ("default") means "let CC use its configured model";
  // a real alias ("opus"/"sonnet") or full id is forwarded.
  if (intent.model !== "" && intent.model !== "default") {
    args.push("--model", intent.model);
  }
  // Append (not replace) so Claude Code's own tool-use system prompt survives
  // and the agent can still drive CC's tools; the bundle's persona rides on top.
  if (intent.system_prompt !== undefined && intent.system_prompt !== "") {
    args.push("--append-system-prompt", intent.system_prompt);
  }
  if (maxTurns !== undefined) {
    args.push("--max-turns", String(maxTurns));
  }
  return args;
}

// Parse `claude --output-format json` stdout → the final assistant text.
// A non-success result, a malformed envelope, or a missing `result` is a
// hard failure the loop surfaces (it never silently returns empty output).
export function parseClaudeResult(stdout: string): string {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new KernelError({
      code: "EXECUTOR_OUTPUT_INVALID",
      message: "claude -p did not return parseable JSON output",
      detail: { stdout_head: trimmed.slice(0, 500) },
    });
  }
  const obj = parsed as { is_error?: unknown; subtype?: unknown; result?: unknown };
  if (obj.is_error === true) {
    throw new KernelError({
      code: "EXECUTOR_FAILED",
      message: `claude -p reported an error (subtype: ${String(obj.subtype)})`,
      detail: {
        subtype: typeof obj.subtype === "string" ? obj.subtype : undefined,
        result_head: typeof obj.result === "string" ? obj.result.slice(0, 500) : undefined,
      },
    });
  }
  if (typeof obj.result !== "string") {
    throw new KernelError({
      code: "EXECUTOR_OUTPUT_INVALID",
      message: "claude -p JSON result is missing a string 'result' field",
      detail: {},
    });
  }
  return obj.result;
}

function spawnClaude(
  bin: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise<string>((resolveRun, reject) => {
    const child = spawn(bin, args, {
      cwd,
      ...(signal !== undefined ? { signal } : {}),
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
            message:
              `Claude Code CLI '${bin}' was not found; install Claude Code and ` +
              `sign in (run 'claude') to drive headless runs on your subscription`,
            detail: { bin },
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
            message: `claude -p exited with code ${exitCode}`,
            detail: { exit_code: exitCode, stderr_head: stderr.slice(0, 1000) },
          }),
        );
        return;
      }
      try {
        resolveRun(parseClaudeResult(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

export function createClaudeCodeExecutor(opts: ClaudeCodeExecutorOptions): Executor {
  const bin = opts.claude_bin ?? "claude";
  const permissionMode = opts.permission_mode ?? DEFAULT_PERMISSION_MODE;
  const runSpawn: RunSpawn =
    opts.runSpawn ??
    ((intent, worktreeDir, signal) =>
      spawnClaude(bin, buildClaudeArgs(intent, permissionMode, opts.max_turns), worktreeDir, signal));

  return createSandboxedExecutor({
    project_dir: opts.project_dir,
    runSpawn,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}),
  });
}
