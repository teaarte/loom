// `loom run "<task>"` — drive a task to its end non-interactively.
//
// This is the headless counterpart to the model-driven `/task` skill: it
// runs the SAME transport-neutral loop (`@loomfsm/driver`'s `drive`), but
// executes each spawn through the Claude Code CLI in print mode (`claude -p`)
// inside an isolated git worktree, instead of handing the spawn to a live
// host. The daemon will reuse this exact core; `loom run` is the first
// non-interactive consumer of it.
//
// Subscription, not API key: the `claude -p` backend runs on the user's
// existing Claude Code login (OAuth/keychain), so headless runs bill against
// the subscription — no `ANTHROPIC_API_KEY` is set or required. (See
// `createClaudeCodeExecutor`: it never passes `--bare`.)
//
// Like `/task`, the whole argument string is passed through verbatim and a
// leading policy flag is parsed server-side (`parseTaskArgs`) — the CLI
// interprets nothing about the pipeline's posture.
//
// Non-interactive posture: a genuine human gate (the only kind that ever
// reaches the loop — clean/auto gates resolve server-side) PAUSES and is
// printed for the operator to answer via `/proceed`; it is NEVER
// auto-answered.
//
// The kernel store + runtime are loaded LAZILY inside the handler (as
// `status` / `reset` do), so the flag-free install commands never pull
// node:sqlite; the bin re-execs `run` with --experimental-sqlite.

import { homedir } from "node:os";

import type { DriveOptions, DriveOutcome, Executor } from "@loomfsm/driver";
import type { DaemonHandle } from "@loomfsm/daemon";
import type { Registry } from "@loomfsm/kernel";

import { effectiveEnv } from "../lib/config.js";
import {
  containerModeFrom,
  formatDriveTotal,
  formatUsage,
  resolveContainerPlan,
  type ContainerMode,
} from "../lib/container.js";
import { buildDispatchExecutor, preflightDispatch } from "../lib/dispatch.js";
import { claudeAvailable, dockerAvailableDefault } from "../lib/probes.js";
import { resolveSpawnCap, resolveSpawnTimeouts } from "../lib/resilience.js";
import type { CliEnv } from "../lib/env.js";

// The complexity levels the operator may pin via `--complexity` (skips the
// classifier so the flow + cost are predictable). Matches the bundle's flow set.
const COMPLEXITY_LEVELS = ["trivial", "simple", "medium", "complex"] as const;
type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number];

// Seams for tests: a suite injects a ready registry / stub executor / fake
// drive / CLI-presence probes so it can assert the command's parsing +
// reporting without standing up a real store, the Claude Code CLI, or Docker.
// Production leaves them unset and uses the defaults.
export interface RunOverrides {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor?: (registry: Registry) => Executor;
  driveImpl?: (projectDir: string, opts: DriveOptions) => Promise<DriveOutcome>;
  // Probe for the Claude Code CLI; default spawns `<bin> --version`.
  claudeAvailable?: (bin: string) => boolean;
  // Probe for the Docker CLI; default spawns `docker version`.
  dockerAvailable?: () => boolean;
  // Acquire the per-project advisory lock; default = `@loomfsm/daemon`'s
  // `acquireLock`. A test injects a stub to exercise the refuse-on-conflict path
  // without touching a real status file.
  acquireRunLock?: (projectDir: string) => DaemonHandle;
  // Graceful-cancel signal. The real binary wires SIGINT/SIGTERM to an
  // AbortController; a test injects one to assert teardown without OS signals.
  signal?: AbortSignal;
}

export async function runTask(
  argv: string[],
  env: CliEnv,
  overrides: RunOverrides = {},
): Promise<number> {
  // Pull the container toggle out before the rest of argv becomes the task
  // string (the CLI interprets nothing else about the task — it rides verbatim).
  const dockerFlag = argv.includes("--docker");
  const noDockerFlag = argv.includes("--no-docker");
  // `--replace`: discard an in-progress incumbent and start fresh, instead of
  // the default resume-the-active-task behaviour (the "I killed a throwaway,
  // start over" case). The incumbent is force-archived (kept in history), not
  // destroyed.
  const replaceFlag = argv.includes("--replace");
  const modeResult = containerModeFrom({ docker: dockerFlag, noDocker: noDockerFlag });
  if ("error" in modeResult) {
    env.err(`loom run: ${modeResult.error}`);
    return 1;
  }
  // `--complexity <level>` PINS the task complexity, skipping the classifier so
  // the flow (and its cost) is predictable run-to-run — the classifier otherwise
  // picks a different complexity for the same task across runs. A value-flag
  // (`--complexity simple` or `--complexity=simple`), so it and its value are
  // stripped from the task string. Mirrors the dashboard's complexity selector:
  // the pin rides as `initial_decisions: { complexity, complexity_pinned: true }`.
  let complexity: ComplexityLevel | undefined;
  const taskTokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--docker" || a === "--no-docker" || a === "--replace") continue;
    let value: string | undefined;
    if (a === "--complexity") value = argv[++i];
    else if (a.startsWith("--complexity=")) value = a.slice("--complexity=".length);
    if (value !== undefined || a === "--complexity") {
      if (value === undefined || !COMPLEXITY_LEVELS.includes(value as ComplexityLevel)) {
        env.err(`loom run: --complexity needs one of: ${COMPLEXITY_LEVELS.join(", ")}`);
        return 1;
      }
      complexity = value as ComplexityLevel;
      continue;
    }
    taskTokens.push(a);
  }
  const raw = taskTokens.join(" ").trim();
  if (raw.length === 0) {
    env.err('loom run: a task is required — e.g. loom run "add a health check route"');
    return 1;
  }

  const target = env.cwd;
  const { parseTaskArgs } = await import("@loomfsm/mcp-server/parse-task-args");
  const { task, policy_preset, warnings } = parseTaskArgs(raw);
  for (const w of warnings) env.err(`loom run: ${w}`);

  // Resolve the pipeline once, build the executor from it, and pin it for
  // the whole drive (the registry is a static product of bundle + config).
  const resolveRegistry =
    overrides.resolveRegistry ?? (await import("@loomfsm/mcp-server/bootstrap")).assembleRegistry;
  let registry: Registry;
  try {
    registry = await resolveRegistry(target);
  } catch (err) {
    env.err(`loom run: could not load the pipeline for ${target}: ${(err as Error).message}`);
    return 1;
  }

  // Fold the persisted config in as a lower-priority env layer (the real
  // environment still wins) so spawn-timeout knobs configured once apply here.
  const cfgEnv = effectiveEnv(target, env, process.env);

  // Take the per-project advisory lock BEFORE any drive work. It is the SAME
  // lock the daemon holds, so a second `loom run`, or a run while a daemon
  // supervises this project, REFUSES here instead of re-executing the same
  // pending spawns in the same worktree (double billing + file races). A
  // stale (dead-pid) lock is reclaimed automatically. There is no force/steal
  // escape hatch: the operator stops the holder, or waits.
  const daemonMod = await import("@loomfsm/daemon");
  const acquire = overrides.acquireRunLock ?? daemonMod.acquireLock;
  let lock: DaemonHandle;
  try {
    lock = acquire(target);
  } catch (err) {
    if (err instanceof daemonMod.DaemonError && err.code === "DAEMON_ALREADY_RUNNING") {
      env.err(`loom run: ${err.message}`);
      env.err("loom run: stop it (loom daemon stop) or wait for it to finish, then retry");
      return 1;
    }
    env.err(`loom run: could not acquire the project lock: ${(err as Error).message}`);
    return 1;
  }
  lock.update("driving");

  // Graceful cancel: a test injects a signal; the real binary wires the OS
  // signals to an AbortController so Ctrl-C (or `loom daemon stop`, which signals
  // the lock holder) aborts the drive AND its in-flight spawns instead of
  // orphaning children that keep billing.
  const controller = new AbortController();
  const usingInjectedSignal = overrides.signal !== undefined;
  const signal = overrides.signal ?? controller.signal;
  const onSignal = (): void => controller.abort();
  if (!usingInjectedSignal) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  try {
    return await drive_(target, env, overrides, cfgEnv, registry, resolveRegistry, {
      task,
      ...(policy_preset !== undefined ? { policy_preset } : {}),
      replaceFlag,
      ...(complexity !== undefined ? { complexity } : {}),
      modeResult,
      signal,
    });
  } finally {
    lock.release();
    if (!usingInjectedSignal) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

// The executor-build + drive body, extracted so the lock + signal lifecycle
// above wraps it in a single try/finally. Everything here was inline in
// `runTask`; the only addition is that `signal` now reaches the executor and the
// drive so a cancel tears spawns down.
interface DriveParams {
  task: string;
  policy_preset?: string;
  replaceFlag: boolean;
  complexity?: ComplexityLevel;
  modeResult: { mode: ContainerMode };
  signal: AbortSignal;
}

async function drive_(
  target: string,
  env: CliEnv,
  overrides: RunOverrides,
  cfgEnv: NodeJS.ProcessEnv,
  registry: Registry,
  resolveRegistry: (projectDir: string) => Promise<Registry> | Registry,
  params: DriveParams,
): Promise<number> {
  const { task, policy_preset, replaceFlag, complexity, signal } = params;
  const modeResult = params.modeResult;

  let executor: Executor;
  try {
    if (overrides.buildExecutor) {
      executor = overrides.buildExecutor(registry);
    } else {
      const home = env.home.length > 0 ? env.home : homedir();
      // Resolve the container toggle FIRST so an explicit `--docker` that cannot
      // be honored (Docker absent) refuses with its own message, before the
      // backend preflight runs. The plan shapes only the Claude Code backend;
      // raw backends touch no files and never run in a container.
      const plan = resolveContainerPlan({
        mode: modeResult.mode,
        env: cfgEnv,
        home,
        dockerAvailable: overrides.dockerAvailable ?? (() => dockerAvailableDefault()),
        onNotice: (message) => env.err(`loom run: ${message}`),
      });
      const bin = cfgEnv["LOOM_CLAUDE_BIN"] ?? "claude";
      const available = overrides.claudeAvailable ?? claudeAvailable;
      // Refuse cleanly up front when no agent has a usable backend (e.g. the
      // default `auto` routing needs Claude Code and the CLI is absent with no
      // provider configured) — before any drive begins.
      const pre = preflightDispatch({
        projectDir: target,
        env: cfgEnv,
        home,
        bundleName: registry.bundle.name,
        agents: [...registry.agents.keys()],
        claudeAvailable: () => available(bin),
      });
      if (!pre.ok) {
        env.err(`loom run: ${pre.error}`);
        return 1;
      }
      // Each spawn is routed to the backend resolved for its agent's model
      // family: the sandboxed `claude -p` run (worktree, or container per the
      // toggle) for Claude Code, or — for a non-Claude agent — the Aider
      // worktree harness when the agent EDITS FILES (agentic) else a plain raw
      // model call. `auto` is CC-first and falls back loudly. The worktree
      // posture defaults to the safe `acceptEdits`, raised only by an explicit
      // `LOOM_CLAUDE_PERMISSION_MODE` opt-in.
      const { agentExecutionFor, bundleKnowledgeRefsDir } = await import("@loomfsm/mcp-server/bootstrap");
      const execMap = agentExecutionFor(registry.bundle.name);
      const refsDir = bundleKnowledgeRefsDir(registry.bundle.name);
      executor = buildDispatchExecutor({
        projectDir: target,
        resolveBundleName: () => registry.bundle.name,
        env: cfgEnv,
        home,
        plan,
        timeouts: resolveSpawnTimeouts(cfgEnv),
        claudeAvailable: () => available(bin),
        resolveAgentExecution: (agent) => execMap[agent] ?? "single-shot",
        ...(refsDir !== undefined ? { sandbox_seed: () => [{ src: refsDir, rel: ".loom/work/refs" }] } : {}),
        onNotice: (message) => env.err(`loom run: ${message}`),
        onUsage: (usage) => env.err(`loom run: ${formatUsage(usage)}`),
        // The cancel signal reaches each backend so a Ctrl-C / stop tears down
        // an in-flight `claude -p` (or container/aider) child instead of leaking it.
        signal,
      });
    }
  } catch (err) {
    env.err(`loom run: ${(err as Error).message}`);
    return 1;
  }

  const driveFn = overrides.driveImpl ?? (await import("@loomfsm/driver")).drive;
  const outcome = await driveFn(target, {
    executor,
    // Pass the RECONCILING resolver (not a pinned `() => registry`): when the
    // drive force-archives an incumbent (`--replace`) or rotates a finished
    // slot, it re-resolves to re-install the bundle into the fresh store. A
    // pinned resolver would hand back a registry without re-reconciling, and the
    // replacement task would refuse with "no enabled bundle".
    resolveRegistry,
    task,
    // Hard total-spawn ceiling (LOOM_MAX_SPAWNS, default 40; 0 disables) so a
    // non-converging revise loop stops before it runs up the bill.
    max_total_spawns: resolveSpawnCap(cfgEnv),
    ...(policy_preset !== undefined ? { policy_preset } : {}),
    ...(replaceFlag ? { on_active_task: "archive" as const } : {}),
    // Pin the complexity (skip the classifier) when the operator asked. The
    // bundle reads `complexity` + `complexity_pinned`; the classifier self-skips.
    ...(complexity !== undefined
      ? { initial_decisions: { complexity, complexity_pinned: true } }
      : {}),
    // Abort the drive (and its in-flight spawns) on a cancel — also what makes
    // `loom daemon stop` on a run, which signals the shared lock holder, clean.
    signal,
  });

  // Surface the whole-drive spend (cost + tokens incl. cache-write) once at the
  // end, alongside the per-spawn lines the executor's onUsage already printed.
  if (outcome.usage_total !== undefined) {
    env.err(`loom run: ${formatDriveTotal(outcome.usage_total)}`);
  }

  return report(outcome, env);
}


function report(outcome: DriveOutcome, env: CliEnv): number {
  switch (outcome.kind) {
    case "complete":
      env.out(`done — ${outcome.verdict}`);
      if (outcome.summary.length > 0) env.out(outcome.summary);
      return outcome.verdict === "accepted" ? 0 : 1;
    case "paused":
      env.out(`paused at gate '${outcome.gate}' — a human decision is required:`);
      env.out(`  ${outcome.message}`);
      for (const opt of outcome.valid_answers.options) {
        env.out(`    - ${opt.verbs.join(" / ")}: ${opt.label}`);
      }
      env.out(`answer it interactively with /proceed, or 'loom run' again once answered.`);
      return 2;
    case "error":
      env.err(`loom run failed [${outcome.code}]: ${outcome.message}`);
      return 1;
  }
}
