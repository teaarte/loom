// `loom run "<task>"` — drive a task to its end non-interactively.
//
// This is the headless counterpart to the model-driven `/task` skill: it
// runs the SAME transport-neutral loop (`@loomfsm/driver`'s `drive`) with a
// provider-backed executor, so a spawn is executed in-process instead of
// being handed to a host. The daemon will reuse this exact core; `loom run`
// is the first non-interactive consumer of it.
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

import type { DriveOptions, DriveOutcome, Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

import type { CliEnv } from "../lib/env.js";

// Seams for tests: a suite injects a ready registry / stub executor / fake
// drive so it can assert the command's parsing + reporting without standing
// up a real provider. Production leaves them unset and uses the defaults.
export interface RunOverrides {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor?: (registry: Registry) => Executor;
  driveImpl?: (projectDir: string, opts: DriveOptions) => Promise<DriveOutcome>;
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
      : await defaultExecutor(registry);
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

// The headless loop needs an async provider (it runs the spawn itself); the
// deployment's first registered provider drives every spawn. A shuttle-only
// provider hands spawns to a host and so cannot run headless — caught here
// with a clear message rather than failing spawn-by-spawn inside the loop.
async function defaultExecutor(registry: Registry): Promise<Executor> {
  const provider = registry.providers.all[0];
  if (provider === undefined) {
    throw new Error(`no provider is registered for this project`);
  }
  if (provider.capabilities.execution !== "async") {
    throw new Error(
      `provider '${provider.name}' is shuttle-only and cannot run headless; ` +
        `configure an async provider (.claude/providers.json) to use 'loom run'`,
    );
  }
  const { createProviderExecutor } = await import("@loomfsm/driver");
  return createProviderExecutor(provider);
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
