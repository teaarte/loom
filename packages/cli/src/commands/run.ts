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
import type { Registry } from "@loomfsm/kernel";

import { effectiveEnv } from "../lib/config.js";
import { containerModeFrom, formatUsage, resolveContainerPlan } from "../lib/container.js";
import { buildDispatchExecutor, preflightDispatch } from "../lib/dispatch.js";
import { claudeAvailable, dockerAvailableDefault } from "../lib/probes.js";
import { resolveSpawnTimeouts } from "../lib/resilience.js";
import type { CliEnv } from "../lib/env.js";

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
  const raw = argv
    .filter((a) => a !== "--docker" && a !== "--no-docker" && a !== "--replace")
    .join(" ")
    .trim();
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
    ...(policy_preset !== undefined ? { policy_preset } : {}),
    ...(replaceFlag ? { on_active_task: "archive" as const } : {}),
  });

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
