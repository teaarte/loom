// `loom models set <agent> <provider:model|tier>` / `loom models list` — bind a
// bundle's agents to models in the GLOBAL config, once, for every project.
//
// The agent + tier names come from the loaded bundle's ROSTER (never hardcoded
// here); the value is `provider:model` or a tier the bundle declares. `set`
// rejects a model the configured backend cannot run (a `(backend, model)` pair
// the capability table forbids) at ENTRY, with a helpful suggestion — so the
// catalog never stores a pairing that can't run.
//
// The roster is loaded lazily (it pulls the kernel + bundle), so this is a
// SQLite-class command that re-execs with the flag; the heavy import is dynamic
// and a test injects a roster directly (which also proves the verb is generic —
// any roster, no code-bundle assumption).

import {
  AUTO_BACKEND,
  bundleAgentMap,
  parseModelRef,
  readGlobalConfig,
  resolveLoomHome,
  resolveModelRef,
  validatePair,
  writeGlobalConfig,
  type BundleRoster,
  type LoomConfig,
} from "@loomfsm/config";

import type { CliEnv } from "../lib/env.js";

export interface ModelsOverrides {
  loomHome?: string;
  roster?: BundleRoster;
}

export async function models(
  argv: string[],
  env: CliEnv,
  overrides: ModelsOverrides = {},
): Promise<number> {
  const home = overrides.loomHome ?? resolveLoomHome(process.env, env.home);

  let roster: BundleRoster;
  try {
    roster =
      overrides.roster ??
      (await import("@loomfsm/mcp-server/bootstrap")).activeBundleRoster();
  } catch (err) {
    env.err(`loom models: could not load the bundle roster: ${(err as Error).message}`);
    return 1;
  }

  const [sub, ...rest] = argv;
  switch (sub) {
    case "set":
      return setModel(rest, env, home, roster);
    case "list":
      return listModels(env, home, roster);
    default:
      env.err(`loom models: expected 'set' or 'list', got ${sub ?? "(nothing)"}`);
      return 1;
  }
}

function setModel(rest: string[], env: CliEnv, home: string, roster: BundleRoster): number {
  const [agent, ref] = rest;
  if (agent === undefined || ref === undefined) {
    env.err("loom models set: usage — loom models set <agent> <provider:model|tier>");
    return 1;
  }
  if (!roster.agents.some((a) => a.name === agent)) {
    env.err(`loom models set: '${agent}' is not an agent of bundle '${roster.name}'`);
    env.err(`  agents: ${roster.agents.map((a) => a.name).join(", ")}`);
    return 1;
  }

  let current: LoomConfig;
  try {
    current = readGlobalConfig(home);
  } catch (err) {
    env.err(`loom models: ${(err as Error).message}`);
    return 1;
  }

  const backend = current.backend ?? AUTO_BACKEND;
  const pair = validatePair(backend, ref);
  if (!pair.ok) {
    env.err(`loom models set: ${pair.message}`);
    return 1;
  }

  // Write into the bundle-namespaced model map.
  const bundles = { ...current.bundles };
  const existing = bundles[roster.name]?.agents ?? {};
  bundles[roster.name] = { agents: { ...existing, [agent]: ref } };
  writeGlobalConfig(home, { ...current, bundles });

  const resolved = resolveModelRef(ref, roster.default_model_tiers);
  env.out(`set ${roster.name}/${agent} → ${ref} (model ${resolved.model})`);

  // A non-Claude model under `auto` dispatches LIVE to its provider backend.
  // Flag its prerequisites here so a misconfigured run fails loudly at set-time
  // rather than mid-spawn: the provider credential, plus — for a file-editing
  // agent — the work-agent harness CLI (opencode by default).
  const { family } = parseModelRef(ref);
  if (backend === AUTO_BACKEND && family !== undefined && family !== "anthropic") {
    env.err(
      `loom models: note — '${ref}' dispatches to the ${family} backend; ensure its ` +
        `credential is configured (see 'loom secrets') and, for an editing agent, the ` +
        `work-agent harness CLI (opencode) is installed.`,
    );
  }
  return 0;
}

function listModels(env: CliEnv, home: string, roster: BundleRoster): number {
  let current: LoomConfig;
  try {
    current = readGlobalConfig(home);
  } catch (err) {
    env.err(`loom models: ${(err as Error).message}`);
    return 1;
  }
  const overrides = bundleAgentMap(current, roster.name);

  env.out(`models for bundle '${roster.name}':`);
  for (const agent of roster.agents) {
    const ref = overrides[agent.name];
    if (ref !== undefined) {
      const resolved = resolveModelRef(ref, roster.default_model_tiers);
      env.out(`  ${agent.name} = ${ref} → ${resolved.model}  [override]`);
    } else {
      const tier = agent.default_model;
      const resolvedDefault =
        tier !== undefined ? resolveModelRef(tier, roster.default_model_tiers).model : "(unset)";
      env.out(`  ${agent.name} = ${tier ?? "(unset)"} → ${resolvedDefault}  [bundle default]`);
    }
  }
  return 0;
}
