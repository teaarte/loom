// `loom daemon start|stop|status` — the local-process control surface for the
// long-lived supervisor.
//
// The supervisor (in @loomfsm/daemon) wraps the SAME headless loop `loom run`
// drives, but instead of stopping at a human gate or a transient failure it
// PARKS and wakes on the answer, RETRIES with backoff, RECOVERS an in-flight
// task on restart, and owns the worktree lifecycle (commit-to-branch + GC).
// It is the second consumer of `drive()`; this command is a thin wrapper that
// injects the production registry + the `claude -p` executor, exactly as
// `loom run` does.
//
//   start [--watch] [--detach] ["<task>"]
//       Supervise this project. With a task, start it; without, attach to the
//       active task and drive/recover it. --watch keeps supervising the slot
//       for the next task after one finishes (the seam a future Jira/Telegram
//       intake feeds). --detach forks a background daemon and returns.
//   stop [path]      Signal a running daemon to stop gracefully (SIGTERM).
//   status [path]    Show whether a daemon is running and where the task sits.
//
// Subscription, not API key: like `loom run`, each spawn runs through
// `claude -p` on the user's existing Claude Code login. The kernel store is
// opened lazily; the bin re-execs `daemon` with --experimental-sqlite.

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import type { Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

import { firstUnknownFlag, parseArgs } from "../lib/args.js";
import type { CliEnv } from "../lib/env.js";

// Test seams: inject a ready registry / executor / a fake supervise so a
// suite asserts parsing + reporting + lifecycle wiring without standing up a
// real store or the Claude Code CLI. Production leaves them unset.
export interface DaemonOverrides {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor?: (ctx: { onNotice: (m: string) => void; signal: AbortSignal }) => Executor;
  claudeAvailable?: (bin: string) => boolean;
  // Replace the supervisor entrypoints (default imports from @loomfsm/daemon).
  superviseImpl?: (projectDir: string, opts: unknown) => Promise<unknown>;
  superviseWatchImpl?: (projectDir: string, opts: unknown) => Promise<void>;
  // Drive shutdown in a test instead of OS signals.
  signal?: AbortSignal;
}

const START_KNOWN_FLAGS = ["watch", "detach", "foreground"] as const;
const STOPSTATUS_KNOWN_FLAGS = [] as const;

export async function daemon(
  argv: string[],
  env: CliEnv,
  overrides: DaemonOverrides = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "start":
      return await start(rest, env, overrides);
    case "stop":
      return await stop(rest, env);
    case "status":
      return await daemonStatus(rest, env);
    default:
      env.err(`loom daemon: expected 'start', 'stop', or 'status', got ${sub ?? "(nothing)"}`);
      env.err("run 'loom --help' for usage");
      return 1;
  }
}

async function start(argv: string[], env: CliEnv, overrides: DaemonOverrides): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, START_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom daemon start: unknown flag --${unknown}`);
    return 1;
  }
  const target = env.cwd;
  const watch = flags.has("watch");
  const task = positionals.join(" ").trim();

  // --detach forks a background foreground-daemon and returns immediately.
  if (flags.has("detach")) {
    return detach(target, watch, task, env);
  }

  // Resolve the pipeline + build the executor factory, mirroring `loom run`.
  const resolveRegistry =
    overrides.resolveRegistry ?? (await import("@loomfsm/mcp-server/bootstrap")).assembleRegistry;
  let registry: Registry;
  try {
    registry = await resolveRegistry(target);
  } catch (err) {
    env.err(`loom daemon start: could not load the pipeline for ${target}: ${(err as Error).message}`);
    return 1;
  }

  let buildExecutor: (ctx: { onNotice: (m: string) => void; signal: AbortSignal }) => Executor;
  try {
    buildExecutor = overrides.buildExecutor ?? (await defaultExecutorFactory(target, overrides.claudeAvailable));
  } catch (err) {
    env.err(`loom daemon start: ${(err as Error).message}`);
    return 1;
  }

  const daemonMod = await import("@loomfsm/daemon");
  const { acquireLock, createFileLogger, DaemonError, superviseToTerminal, superviseWatch } = daemonMod;

  // Claim the project (refuse if a live daemon already owns it).
  let handle: ReturnType<typeof acquireLock>;
  try {
    handle = acquireLock(target);
  } catch (err) {
    if (err instanceof DaemonError) {
      env.err(`loom daemon start: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // Graceful shutdown: a test injects a signal; the real binary wires the OS
  // signals to an AbortController.
  const controller = new AbortController();
  const usingInjected = overrides.signal !== undefined;
  const signal = overrides.signal ?? controller.signal;
  const onSignal = (): void => controller.abort();
  if (!usingInjected) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  const logger = createFileLogger(target, { echo: (line) => env.err(line.replace(/\n$/, "")) });
  const opts = {
    buildExecutor,
    resolveRegistry: () => registry,
    ...(task.length > 0 ? { task } : {}),
    logger,
    handle,
    signal,
  };

  env.out(
    `loom daemon: supervising ${target}${task.length > 0 ? ` — "${truncate(task)}"` : " (attaching to the active task)"}${watch ? " [watch]" : ""}`,
  );

  try {
    if (watch) {
      const run = overrides.superviseWatchImpl ?? superviseWatch;
      await run(target, opts as never);
      env.out("loom daemon: stopped");
      return 0;
    }
    const run = overrides.superviseImpl ?? superviseToTerminal;
    const result = (await run(target, opts as never)) as SupervisionResultShape;
    return report(result, env);
  } finally {
    handle.release();
    if (!usingInjected) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

async function stop(argv: string[], env: CliEnv): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, STOPSTATUS_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom daemon stop: unknown flag --${unknown}`);
    return 1;
  }
  const target = resolveTarget(positionals, env);
  const { signalStop } = await import("@loomfsm/daemon");
  const result = signalStop(target);
  if (result === "signalled") {
    env.out(`loom daemon: stop signalled for ${target}`);
    return 0;
  }
  env.out(`loom daemon: no running daemon for ${target}`);
  return 0;
}

async function daemonStatus(argv: string[], env: CliEnv): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, STOPSTATUS_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom daemon status: unknown flag --${unknown}`);
    return 1;
  }
  const target = resolveTarget(positionals, env);
  const { readStatus, isAlive } = await import("@loomfsm/daemon");

  const status = readStatus(target);
  if (status === null || !isAlive(status.pid)) {
    env.out(`loom daemon: not running for ${target}`);
    if (status !== null) env.out(`  (a stale status file from pid ${status.pid} remains)`);
    return 0;
  }
  env.out(`loom daemon: running (pid ${status.pid}) for ${target}`);
  env.out(`  phase:    ${status.phase}`);
  if (status.task_id !== undefined && status.task_id !== null) {
    env.out(`  task:     ${status.task_id}`);
  }
  if (status.detail !== undefined) env.out(`  detail:   ${status.detail}`);
  env.out(`  started:  ${status.started_at}`);
  env.out(`  updated:  ${status.updated_at}`);
  return 0;
}

// ----- internals ---------------------------------------------------------

interface SupervisionResultShape {
  kind: "complete" | "error" | "aborted" | "noop";
  verdict?: string;
  summary?: string;
  code?: string;
  message?: string;
  reason?: string;
  merge_back?: { merged?: boolean; branch?: string; files_changed?: string[]; reason?: string };
}

function report(result: SupervisionResultShape, env: CliEnv): number {
  switch (result.kind) {
    case "complete": {
      env.out(`loom daemon: done — ${result.verdict ?? "?"}`);
      if (result.summary !== undefined && result.summary.length > 0) env.out(`  ${result.summary}`);
      const mb = result.merge_back;
      if (mb?.merged === true && mb.branch !== undefined) {
        env.out(`  changes committed to branch ${mb.branch} (${mb.files_changed?.length ?? 0} file(s))`);
        env.out(`  review and merge it deliberately — the daemon never auto-merges.`);
      } else if (mb !== undefined) {
        env.out(`  no branch created (${mb.reason ?? "no-changes"}).`);
      }
      return result.verdict === "accepted" ? 0 : 1;
    }
    case "noop":
      env.out(`loom daemon: nothing to supervise (${result.reason ?? "no-active-task"})`);
      return 0;
    case "aborted":
      env.out(`loom daemon: stopped (${result.reason ?? "shutdown"})`);
      return 0;
    case "error":
      env.err(`loom daemon: escalated [${result.code ?? "ERROR"}]: ${result.message ?? ""}`);
      return 1;
  }
}

function resolveTarget(positionals: string[], env: CliEnv): string {
  const first = positionals[0];
  return first !== undefined && first.length > 0 ? resolve(env.cwd, first) : env.cwd;
}

// The `claude -p` executor factory, mirroring `loom run`'s defaultExecutor:
// probe the CLI up front (refuse cleanly when absent) and build a fresh
// executor per drive attempt so the attempt's abort signal reaches the child.
async function defaultExecutorFactory(
  projectDir: string,
  availableOverride: ((bin: string) => boolean) | undefined,
): Promise<(ctx: { onNotice: (m: string) => void; signal: AbortSignal }) => Executor> {
  const bin = process.env["LOOM_CLAUDE_BIN"] ?? "claude";
  const available = availableOverride ?? claudeAvailable;
  if (!available(bin)) {
    throw new Error(
      `Claude Code CLI '${bin}' was not found on PATH; install Claude Code and ` +
        `sign in (run 'claude') to drive headless runs on your subscription`,
    );
  }
  const permissionMode = process.env["LOOM_CLAUDE_PERMISSION_MODE"];
  const { createClaudeCodeExecutor } = await import("@loomfsm/driver");
  return (ctx) =>
    createClaudeCodeExecutor({
      project_dir: projectDir,
      ...(permissionMode !== undefined && permissionMode !== ""
        ? { permission_mode: permissionMode }
        : {}),
      onNotice: ctx.onNotice,
      signal: ctx.signal,
    });
}

function claudeAvailable(bin: string): boolean {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}

// Fork a detached foreground daemon: re-exec the launcher with the same
// task/watch in the background, print its pid, and return. The child writes
// its own status/PID file via `acquireLock`, so `stop`/`status` find it.
function detach(target: string, watch: boolean, task: string, env: CliEnv): number {
  const entry = process.argv[1];
  if (entry === undefined) {
    env.err("loom daemon start: cannot locate the launcher to detach");
    return 1;
  }
  const args = ["--experimental-sqlite", "--no-warnings", entry, "daemon", "start"];
  if (watch) args.push("--watch");
  if (task.length > 0) args.push(task);
  const child = spawn(process.execPath, args, {
    cwd: target,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LOOM_SQLITE_REEXEC: "1" },
  });
  child.unref();
  env.out(`loom daemon: started in background (pid ${child.pid ?? "?"}) — stop with 'loom daemon stop'`);
  return 0;
}

function truncate(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
