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
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ExecutorBuildContext, MergeBackResult } from "@loomfsm/daemon";
import type { DriveOutcome, Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

import { firstUnknownFlag, parseArgs } from "../lib/args.js";
import { effectiveEnv } from "../lib/config.js";
import { containerModeFrom, resolveContainerPlan, type ContainerMode } from "../lib/container.js";
import { buildDispatchExecutor, preflightDispatch } from "../lib/dispatch.js";
import { resolveNotifier } from "../lib/notify.js";
import { resolveSpawnTimeouts, resolveSupervisionKnobs } from "../lib/resilience.js";
import type { CliEnv } from "../lib/env.js";

type CompleteOutcome = Extract<DriveOutcome, { kind: "complete" }>;
type DriveFactory = {
  buildExecutor: (ctx: ExecutorBuildContext) => Executor;
  mergeBack?: (projectDir: string, outcome: CompleteOutcome) => MergeBackResult | Promise<MergeBackResult>;
};

// Test seams: inject a ready registry / executor / a fake supervise so a
// suite asserts parsing + reporting + lifecycle wiring without standing up a
// real store, the Claude Code CLI, or Docker. Production leaves them unset.
export interface DaemonOverrides {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor?: (ctx: ExecutorBuildContext) => Executor;
  claudeAvailable?: (bin: string) => boolean;
  dockerAvailable?: () => boolean;
  // Replace the supervisor entrypoints (default imports from @loomfsm/daemon).
  superviseImpl?: (projectDir: string, opts: unknown) => Promise<unknown>;
  superviseWatchImpl?: (projectDir: string, opts: unknown) => Promise<void>;
  // Drive shutdown in a test instead of OS signals.
  signal?: AbortSignal;
}

const START_KNOWN_FLAGS = ["watch", "detach", "foreground", "docker", "no-docker"] as const;
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

  const modeResult = containerModeFrom({ docker: flags.has("docker"), noDocker: flags.has("no-docker") });
  if ("error" in modeResult) {
    env.err(`loom daemon start: ${modeResult.error}`);
    return 1;
  }

  // --detach forks a background foreground-daemon and returns immediately.
  if (flags.has("detach")) {
    return detach(target, watch, task, env, flags);
  }

  // Fold the persisted config in as a lower-priority env layer (the real
  // environment still wins) so notify + resilience configured once apply here.
  const cfgEnv = effectiveEnv(target, env, process.env);

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

  // Refuse cleanly up front when no agent has a usable backend (default `auto`
  // routing needs Claude Code and the CLI is absent with no provider configured).
  if (!overrides.buildExecutor) {
    const bin = cfgEnv["LOOM_CLAUDE_BIN"] ?? "claude";
    const available = overrides.claudeAvailable ?? claudeAvailable;
    const pre = preflightDispatch({
      projectDir: target,
      env: cfgEnv,
      home: env.home.length > 0 ? env.home : homedir(),
      bundleName: registry.bundle.name,
      agents: [...registry.agents.keys()],
      claudeAvailable: () => available(bin),
    });
    if (!pre.ok) {
      env.err(`loom daemon start: ${pre.error}`);
      return 1;
    }
  }

  let factory: DriveFactory;
  try {
    factory = overrides.buildExecutor
      ? { buildExecutor: overrides.buildExecutor }
      : await defaultDriveFactory(target, env, modeResult.mode, overrides, cfgEnv, registry);
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
  const notifier = await resolveNotifier(cfgEnv, (m) => logger.warn("notify", { message: m }));
  const opts = {
    buildExecutor: factory.buildExecutor,
    resolveRegistry: () => registry,
    ...(task.length > 0 ? { task } : {}),
    ...(factory.mergeBack !== undefined ? { mergeBack: factory.mergeBack } : {}),
    ...resolveSupervisionKnobs(cfgEnv),
    logger,
    notifier,
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

// The per-attempt drive factory, mirroring `loom run`'s defaultExecutor: it
// builds the per-spawn dispatching executor (each spawn routed to the backend
// resolved for its agent's model family — `claude -p` worktree/container for
// Claude Code, a plain raw call otherwise). A fresh dispatcher is built per
// attempt so the attempt's abort signal reaches each backend's child. The
// container toggle (resolved once) shapes only the Claude Code backend; when it
// runs in a container the matching clone merge-back is wired (fleet-wide, since
// the toggle is deployment-wide). Raw backends produce no files, so they need no
// merge-back.
async function defaultDriveFactory(
  projectDir: string,
  env: CliEnv,
  mode: ContainerMode,
  overrides: DaemonOverrides,
  cfgEnv: NodeJS.ProcessEnv,
  registry: Registry,
): Promise<DriveFactory> {
  const home = env.home.length > 0 ? env.home : homedir();
  const plan = resolveContainerPlan({
    mode,
    env: cfgEnv,
    home,
    dockerAvailable: overrides.dockerAvailable ?? dockerAvailableDefault,
    onNotice: (message) => env.err(`loom daemon start: ${message}`),
  });
  const timeouts = resolveSpawnTimeouts(cfgEnv);
  const bin = cfgEnv["LOOM_CLAUDE_BIN"] ?? "claude";
  const available = overrides.claudeAvailable ?? claudeAvailable;
  // The bundle's per-agent execution map (single-shot vs agentic) — resolved
  // once (the daemon's registry is fixed) so a work-agent on a non-Claude
  // backend gets the Aider worktree harness.
  const { agentExecutionFor, bundleKnowledgeRefsDir } = await import("@loomfsm/mcp-server/bootstrap");
  const execMap = agentExecutionFor(registry.bundle.name);
  const refsDir = bundleKnowledgeRefsDir(registry.bundle.name);

  const factory: DriveFactory = {
    buildExecutor: (ctx) =>
      buildDispatchExecutor({
        projectDir,
        resolveBundleName: () => registry.bundle.name,
        env: cfgEnv,
        home,
        plan,
        timeouts,
        claudeAvailable: () => available(bin),
        resolveAgentExecution: (agent) => execMap[agent] ?? "single-shot",
        ...(refsDir !== undefined ? { sandbox_seed: () => [{ src: refsDir, rel: ".loom/work/refs" }] } : {}),
        onNotice: ctx.onNotice,
        onUsage: ctx.onUsage,
        signal: ctx.signal,
      }),
  };
  if (plan.useDocker) {
    const { commitToBranchMergeBackFromClone } = await import("@loomfsm/daemon");
    factory.mergeBack = (dir, outcome) => commitToBranchMergeBackFromClone(dir, outcome.task_id);
  }
  return factory;
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

// Fork a detached foreground daemon: re-exec the launcher with the same
// task/watch/toggle in the background, print its pid, and return. The child
// writes its own status/PID file via `acquireLock`, so `stop`/`status` find it.
function detach(target: string, watch: boolean, task: string, env: CliEnv, flags: Set<string>): number {
  const entry = process.argv[1];
  if (entry === undefined) {
    env.err("loom daemon start: cannot locate the launcher to detach");
    return 1;
  }
  const args = ["--experimental-sqlite", "--no-warnings", entry, "daemon", "start"];
  if (watch) args.push("--watch");
  if (flags.has("docker")) args.push("--docker");
  if (flags.has("no-docker")) args.push("--no-docker");
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
