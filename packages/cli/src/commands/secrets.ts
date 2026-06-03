// `loom secrets set <name> <value>` / `loom secrets list` — manage the GLOBAL,
// machine-local secret store (`~/.config/loom/secrets.json`, chmod 600).
//
// Secrets are referenced from config by name (`secret:<name>`) and never stored
// inline; this verb is the only writer. `list` shows MASKED values — no verb
// ever prints a full secret. The store is never under a repo and never
// committed.
//
// Pure `@loomfsm/config` — flag-free.

import {
  maskSecret,
  readSecrets,
  resolveLoomHome,
  secretsPath,
  writeSecrets,
} from "@loomfsm/config";

import type { CliEnv } from "../lib/env.js";

export interface SecretsOverrides {
  loomHome?: string;
}

export function secrets(argv: string[], env: CliEnv, overrides: SecretsOverrides = {}): number {
  const home = overrides.loomHome ?? resolveLoomHome(process.env, env.home);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "set":
      return setSecret(rest, env, home);
    case "list":
      return listSecrets(env, home);
    default:
      env.err(`loom secrets: expected 'set' or 'list', got ${sub ?? "(nothing)"}`);
      return 1;
  }
}

function setSecret(rest: string[], env: CliEnv, home: string): number {
  const [name, ...valueParts] = rest;
  if (name === undefined || valueParts.length === 0) {
    env.err("loom secrets set: usage — loom secrets set <name> <value>");
    return 1;
  }
  const value = valueParts.join(" ");
  let current: Record<string, string>;
  try {
    current = readSecrets(home);
  } catch (err) {
    env.err(`loom secrets: ${(err as Error).message}`);
    return 1;
  }
  current[name] = value;
  writeSecrets(home, current);
  env.out(`stored secret '${name}' (${maskSecret(value)}) in ${secretsPath(home)}`);
  env.out(`  reference it from config as 'secret:${name}'`);
  return 0;
}

function listSecrets(env: CliEnv, home: string): number {
  let current: Record<string, string>;
  try {
    current = readSecrets(home);
  } catch (err) {
    env.err(`loom secrets: ${(err as Error).message}`);
    return 1;
  }
  const names = Object.keys(current).sort();
  if (names.length === 0) {
    env.out("loom secrets: none stored");
    return 0;
  }
  env.out(`loom secrets (${secretsPath(home)}):`);
  for (const name of names) {
    env.out(`  ${name} = ${maskSecret(current[name] ?? "")}`);
  }
  return 0;
}
