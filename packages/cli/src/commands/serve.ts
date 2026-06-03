// `loom serve [--project <dir>]... [--host] [--port] [--token] [--detach]` —
// the network control plane: one long-lived process that supervises a FLEET of
// projects (each over the SAME headless loop `loom run` / `loom daemon` drive)
// and exposes them over HTTP on loopback, so a dashboard, a chat bot, or an
// issue poller can submit a task, read status, and answer a gate.
//
//   serve [--project <dir>]... [--host h] [--port p] [--token t] [--detach]
//       Start the control plane. Re-attaches every durably-registered project,
//       plus each --project. --detach forks a background server and returns.
//       A token (flag or LOOM_SERVER_TOKEN) makes every API route require
//       `Authorization: Bearer <token>`.
//   serve stop       Signal a running control plane to stop gracefully.
//   serve status     Show whether it is running, where it binds, and how many
//                    projects it supervises.
//
// Subscription, not API key: like `loom run`/`loom daemon`, each spawn runs
// through `claude -p` on the user's Claude Code login. This command is a thin
// wrapper that injects the production registry resolver + the `claude -p`
// executor factory exactly as those do; all logic lives in @loomfsm/server.

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ExecutorBuildContext, MergeBackResult } from "@loomfsm/daemon";
import type { DriveOutcome, Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

import { effectiveEnv } from "../lib/config.js";
import { containerModeFrom, resolveContainerPlan, type ContainerMode } from "../lib/container.js";
import { resolveNotifier } from "../lib/notify.js";
import { resolveSpawnTimeouts, resolveSupervisionKnobs } from "../lib/resilience.js";
import type { CliEnv } from "../lib/env.js";

type CompleteOutcome = Extract<DriveOutcome, { kind: "complete" }>;
type ServeMergeBack = (
  projectDir: string,
  outcome: CompleteOutcome,
) => MergeBackResult | Promise<MergeBackResult>;
type ServeFactory = {
  buildExecutor: (projectDir: string, ctx: ExecutorBuildContext) => Executor;
  mergeBack?: ServeMergeBack;
};

// Test seams — a suite injects a ready registry / executor factory / a fake
// startControlPlane / an injected shutdown signal so it can assert parsing +
// reporting + lifecycle wiring without standing up the Claude Code CLI or Docker.
export interface ServeOverrides {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor?: (projectDir: string, ctx: ExecutorBuildContext) => Executor;
  claudeAvailable?: (bin: string) => boolean;
  dockerAvailable?: () => boolean;
  startImpl?: (opts: unknown) => Promise<{ host: string; port: number; closed: Promise<void>; stop: () => Promise<void> }>;
  stateDir?: string;
  signal?: AbortSignal;
}

interface ServeFlags {
  projects: string[];
  host?: string;
  port?: number;
  token?: string;
  detach: boolean;
  docker: boolean;
  noDocker: boolean;
  unknown?: string;
  badPort?: string;
}

export async function serve(argv: string[], env: CliEnv, overrides: ServeOverrides = {}): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "start":
      return await start(sub === undefined ? argv : rest, env, overrides);
    case "stop":
      return await stop(env, overrides);
    case "status":
      return await serveStatus(env, overrides);
    default:
      // No subcommand keyword → treat the whole argv as `start` flags.
      if (sub.startsWith("-")) return await start(argv, env, overrides);
      env.err(`loom serve: expected 'start', 'stop', or 'status', got ${sub}`);
      env.err("run 'loom --help' for usage");
      return 1;
  }
}

async function start(argv: string[], env: CliEnv, overrides: ServeOverrides): Promise<number> {
  const flags = parseServeFlags(argv);
  if (flags.unknown !== undefined) {
    env.err(`loom serve: unknown flag ${flags.unknown}`);
    return 1;
  }
  if (flags.badPort !== undefined) {
    env.err(`loom serve: invalid --port '${flags.badPort}'`);
    return 1;
  }

  const modeResult = containerModeFrom({ docker: flags.docker, noDocker: flags.noDocker });
  if ("error" in modeResult) {
    env.err(`loom serve: ${modeResult.error}`);
    return 1;
  }

  const stateDir = resolveStateDir(env, overrides);
  const token = flags.token ?? envToken();
  const host = flags.host ?? process.env["LOOM_SERVER_HOST"];
  const port = flags.port ?? envPort();
  const projects = flags.projects.map((p) => resolve(env.cwd, p));

  if (flags.detach) {
    return detach(argv, env);
  }

  // Fold the persisted config in as a lower-priority env layer (the real
  // environment still wins). The control plane has no single project, so the
  // project layer is the operator's cwd; the global notify + resilience are what
  // a fleet reads.
  const cfgEnv = effectiveEnv(env.cwd, env, process.env);

  // Resolve the production registry resolver + the per-project executor factory
  // (container or `claude -p` worktree, per the toggle), mirroring `loom run` /
  // `loom daemon`.
  const resolveRegistry =
    overrides.resolveRegistry ?? (await import("@loomfsm/mcp-server/bootstrap")).assembleRegistry;

  let factory: ServeFactory;
  try {
    factory = overrides.buildExecutor
      ? { buildExecutor: overrides.buildExecutor }
      : await defaultServeFactory(env, modeResult.mode, overrides, cfgEnv);
  } catch (err) {
    env.err(`loom serve: ${(err as Error).message}`);
    return 1;
  }

  const { startControlPlane } = await import("@loomfsm/server");
  const { createFileLogger, nullNotifier } = await import("@loomfsm/daemon");

  // One env-resolved notifier shared across the fleet; the registry stamps each
  // project's id onto its events. Off (no channels) → skip the wiring entirely.
  const baseNotifier = await resolveNotifier(cfgEnv, (m) => env.err(`loom serve: notify: ${m}`));

  // Graceful shutdown: a test injects a signal; the real binary wires OS signals.
  const controller = new AbortController();
  const usingInjected = overrides.signal !== undefined;
  const signal = overrides.signal ?? controller.signal;
  const onSignal = (): void => controller.abort();
  if (!usingInjected) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  try {
    const handle = await startControlPlane({
      stateDir,
      ...(host !== undefined ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(token !== undefined && token.length > 0 ? { token } : {}),
      projects,
      resolveRegistry,
      buildExecutor: factory.buildExecutor,
      ...(factory.mergeBack !== undefined ? { mergeBack: factory.mergeBack } : {}),
      ...resolveSupervisionKnobs(cfgEnv),
      makeLogger: (dir: string) => createFileLogger(dir, { echo: () => {} }),
      ...(baseNotifier !== nullNotifier ? { makeNotifier: () => baseNotifier } : {}),
      signal,
      serverLog: (line: string) => env.err(line),
    });

    env.out(`loom serve: control plane on http://${handle.host}:${handle.port}`);
    env.out(`  supervising ${handle.attached.length} project(s)${token !== undefined && token.length > 0 ? " [token required]" : ""}`);
    for (const p of handle.attached) env.out(`    - ${p.id}  ${p.dir}`);
    env.out(`  dashboard: http://${handle.host}:${handle.port}/   |   stop: 'loom serve stop'`);

    await handle.closed;
    env.out("loom serve: stopped");
    return 0;
  } catch (err) {
    env.err(`loom serve: ${(err as Error).message}`);
    return 1;
  } finally {
    if (!usingInjected) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

async function stop(env: CliEnv, overrides: ServeOverrides): Promise<number> {
  const stateDir = resolveStateDir(env, overrides);
  const { signalServerStop } = await import("@loomfsm/server");
  const result = signalServerStop(stateDir);
  if (result === "signalled") {
    env.out("loom serve: stop signalled");
    return 0;
  }
  env.out("loom serve: no running control plane");
  return 0;
}

async function serveStatus(env: CliEnv, overrides: ServeOverrides): Promise<number> {
  const stateDir = resolveStateDir(env, overrides);
  const { readServerStatus } = await import("@loomfsm/server");
  const { isAlive } = await import("@loomfsm/daemon");
  const status = readServerStatus(stateDir);
  if (status === null || !isAlive(status.pid)) {
    env.out("loom serve: not running");
    if (status !== null) env.out(`  (a stale status file from pid ${status.pid} remains)`);
    return 0;
  }
  env.out(`loom serve: running (pid ${status.pid})`);
  env.out(`  bind:     http://${status.host}:${status.port}`);
  env.out(`  phase:    ${status.phase}`);
  env.out(`  projects: ${status.project_count}`);
  env.out(`  started:  ${status.started_at}`);
  env.out(`  updated:  ${status.updated_at}`);
  return 0;
}

// ----- internals ---------------------------------------------------------

function parseServeFlags(argv: string[]): ServeFlags {
  const out: ServeFlags = { projects: [], detach: false, docker: false, noDocker: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--project" || a === "-p") {
      const v = argv[++i];
      if (v !== undefined && v.length > 0) out.projects.push(v);
    } else if (a === "--host") {
      out.host = argv[++i];
    } else if (a === "--port") {
      const v = argv[++i];
      const n = v !== undefined ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 65535) out.badPort = v ?? "(missing)";
      else out.port = n;
    } else if (a === "--token") {
      out.token = argv[++i];
    } else if (a === "--detach") {
      out.detach = true;
    } else if (a === "--docker") {
      out.docker = true;
    } else if (a === "--no-docker") {
      out.noDocker = true;
    } else if (a.startsWith("-")) {
      out.unknown = a;
      return out;
    }
    // bare positionals are ignored — serve takes no task
  }
  return out;
}

function resolveStateDir(env: CliEnv, overrides: ServeOverrides): string {
  if (overrides.stateDir !== undefined) return overrides.stateDir;
  const fromEnv = process.env["LOOM_SERVER_STATE_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const home = env.home.length > 0 ? env.home : homedir();
  return resolve(home, ".claude", "loom-server");
}

function envToken(): string | undefined {
  const t = process.env["LOOM_SERVER_TOKEN"];
  return t !== undefined && t.length > 0 ? t : undefined;
}

function envPort(): number | undefined {
  const p = process.env["LOOM_SERVER_PORT"];
  if (p === undefined || p.length === 0) return undefined;
  const n = Number(p);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

// The per-project drive factory: resolve the container toggle ONCE (the toggle
// + env are server-wide), probe the chosen requirement (Docker for container,
// the Claude Code CLI for worktree) up front and refuse cleanly when absent,
// then build a fresh executor per project per drive attempt so the attempt's
// abort signal reaches the child. Container mode also brings the matching clone
// merge-back, applied fleet-wide.
async function defaultServeFactory(
  env: CliEnv,
  mode: ContainerMode,
  overrides: ServeOverrides,
  cfgEnv: NodeJS.ProcessEnv,
): Promise<ServeFactory> {
  const plan = resolveContainerPlan({
    mode,
    env: cfgEnv,
    home: env.home.length > 0 ? env.home : homedir(),
    dockerAvailable: overrides.dockerAvailable ?? dockerAvailableDefault,
    onNotice: (message) => env.err(`loom serve: ${message}`),
  });
  const timeouts = resolveSpawnTimeouts(cfgEnv);

  if (plan.useDocker) {
    const { createContainerExecutor } = await import("@loomfsm/driver");
    const { commitToBranchMergeBackFromClone } = await import("@loomfsm/daemon");
    return {
      buildExecutor: (projectDir, ctx) =>
        createContainerExecutor({
          project_dir: projectDir,
          ...plan.container,
          ...timeouts,
          onNotice: ctx.onNotice,
          onUsage: ctx.onUsage,
          signal: ctx.signal,
        }),
      mergeBack: (dir, outcome) => commitToBranchMergeBackFromClone(dir, outcome.task_id),
    };
  }

  const bin = cfgEnv["LOOM_CLAUDE_BIN"] ?? "claude";
  const available = overrides.claudeAvailable ?? claudeAvailable;
  if (!available(bin)) {
    throw new Error(
      `Claude Code CLI '${bin}' was not found on PATH; install Claude Code and ` +
        `sign in (run 'claude') to drive headless runs on your subscription`,
    );
  }
  const permissionMode = cfgEnv["LOOM_CLAUDE_PERMISSION_MODE"];
  const { createClaudeCodeExecutor } = await import("@loomfsm/driver");
  return {
    buildExecutor: (projectDir, ctx) =>
      createClaudeCodeExecutor({
        project_dir: projectDir,
        ...(permissionMode !== undefined && permissionMode !== "" ? { permission_mode: permissionMode } : {}),
        ...timeouts,
        onNotice: ctx.onNotice,
        onUsage: ctx.onUsage,
        signal: ctx.signal,
      }),
  };
}

function claudeAvailable(bin: string): boolean {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}

function dockerAvailableDefault(): boolean {
  const bin = process.env["LOOM_DOCKER_BIN"] ?? "docker";
  const res = spawnSync(bin, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}

// Fork a detached background control plane: re-exec the launcher with the same
// flags, print its pid, and return. The child writes its own server status
// file via the lock, so `serve stop`/`serve status` find it.
function detach(argv: string[], env: CliEnv): number {
  const entry = process.argv[1];
  if (entry === undefined) {
    env.err("loom serve: cannot locate the launcher to detach");
    return 1;
  }
  const passthrough = argv.filter((a) => a !== "--detach");
  const args = ["--experimental-sqlite", "--no-warnings", entry, "serve", ...passthrough];
  const child = spawn(process.execPath, args, {
    cwd: env.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LOOM_SQLITE_REEXEC: "1" },
  });
  child.unref();
  env.out(`loom serve: started in background (pid ${child.pid ?? "?"}) — stop with 'loom serve stop'`);
  return 0;
}
