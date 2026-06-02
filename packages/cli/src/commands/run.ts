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
// printed for the operator to answer via `/resume`; it is NEVER
// auto-answered.
//
// The kernel store + runtime are loaded LAZILY inside the handler (as
// `status` / `reset` do), so the flag-free install commands never pull
// node:sqlite; the bin re-execs `run` with --experimental-sqlite.

import { spawnSync } from "node:child_process";

import type { DriveOptions, DriveOutcome, Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

import type { CliEnv } from "../lib/env.js";

// Seams for tests: a suite injects a ready registry / stub executor / fake
// drive / claude-presence probe so it can assert the command's parsing +
// reporting without standing up a real store or the Claude Code CLI.
// Production leaves them unset and uses the defaults.
export interface RunOverrides {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor?: (registry: Registry) => Executor;
  driveImpl?: (projectDir: string, opts: DriveOptions) => Promise<DriveOutcome>;
  // Probe for the Claude Code CLI; default spawns `<bin> --version`.
  claudeAvailable?: (bin: string) => boolean;
}

export async function runTask(
  argv: string[],
  env: CliEnv,
  overrides: RunOverrides = {},
): Promise<number> {
  const raw = argv.join(" ").trim();
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

  let executor: Executor;
  try {
    executor = overrides.buildExecutor
      ? overrides.buildExecutor(registry)
      : await defaultExecutor(target, env, overrides.claudeAvailable);
  } catch (err) {
    env.err(`loom run: ${(err as Error).message}`);
    return 1;
  }

  const driveFn = overrides.driveImpl ?? (await import("@loomfsm/driver")).drive;
  const outcome = await driveFn(target, {
    executor,
    resolveRegistry: () => registry,
    task,
    ...(policy_preset !== undefined ? { policy_preset } : {}),
  });

  return report(outcome, env);
}

// The headless loop runs each spawn through the Claude Code CLI (`claude -p`)
// in an isolated git worktree. The only hard requirement is the CLI itself
// (and a signed-in login) — probed up front so a missing/unconfigured Claude
// Code refuses cleanly here rather than failing spawn-by-spawn inside the
// loop. The permission posture defaults to the safe `acceptEdits` and is
// raised only by an explicit `LOOM_CLAUDE_PERMISSION_MODE` opt-in.
async function defaultExecutor(
  projectDir: string,
  env: CliEnv,
  availableOverride: ((bin: string) => boolean) | undefined,
): Promise<Executor> {
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
  return createClaudeCodeExecutor({
    project_dir: projectDir,
    ...(permissionMode !== undefined && permissionMode !== ""
      ? { permission_mode: permissionMode }
      : {}),
    onNotice: (message) => env.err(`loom run: ${message}`),
  });
}

// Probe for the Claude Code CLI by spawning `<bin> --version`. A missing
// binary surfaces as a spawn error (ENOENT); a present one exits 0.
function claudeAvailable(bin: string): boolean {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
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
      env.out(`answer it interactively with /resume, or 'loom run' again once answered.`);
      return 2;
    case "error":
      env.err(`loom run failed [${outcome.code}]: ${outcome.message}`);
      return 1;
  }
}
