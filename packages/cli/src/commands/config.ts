// `loom config get [key]` / `loom config set <key> <value>` — read and edit the
// GLOBAL config (`~/.config/loom/config.json`). Configure once, here, and every
// project inherits it.
//
// This verb edits the non-secret, non-model settings: the backend mode and the
// notify / resilience knobs. Secrets go through `loom secrets`; per-agent models
// through `loom models`. Keys are allow-listed so a typo is rejected rather than
// silently written (and the file is re-validated through the schema before it
// lands).
//
// Pure `@loomfsm/config` — no kernel, no store — so it stays a flag-free command.

import {
  knownBackends,
  parseLoomConfig,
  readGlobalConfig,
  resolveLoomHome,
  type LoomConfig,
} from "@loomfsm/config";

import type { CliEnv } from "../lib/env.js";
import { writeGlobalConfig } from "@loomfsm/config";

export interface ConfigOverrides {
  loomHome?: string;
}

// Allow-listed settable keys, with how each value is coerced.
const STRING_KEYS = new Set([
  "backend",
  "notify.webhook_url",
  "notify.slack_url",
  "notify.telegram_token",
  "notify.telegram_chat",
  "notify.script",
  "resilience.rate_limit_wait",
]);
const NUMBER_KEYS = new Set([
  "notify.timeout_ms",
  "resilience.drive_deadline_ms",
  "resilience.spawn_session_timeout_ms",
  "resilience.spawn_idle_timeout_ms",
]);
const ARRAY_KEYS = new Set(["notify.events"]);
const SETTABLE = [...STRING_KEYS, ...NUMBER_KEYS, ...ARRAY_KEYS].sort();

export function config(argv: string[], env: CliEnv, overrides: ConfigOverrides = {}): number {
  const home = overrides.loomHome ?? resolveLoomHome(process.env, env.home);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "get":
      return get(rest, env, home);
    case "set":
      return set(rest, env, home);
    default:
      env.err(`loom config: expected 'get' or 'set', got ${sub ?? "(nothing)"}`);
      return 1;
  }
}

function get(rest: string[], env: CliEnv, home: string): number {
  let current: LoomConfig;
  try {
    current = readGlobalConfig(home);
  } catch (err) {
    env.err(`loom config: ${(err as Error).message}`);
    return 1;
  }
  const key = rest[0];
  if (key === undefined) {
    env.out(JSON.stringify(current, null, 2));
    return 0;
  }
  const value = readPath(current as Record<string, unknown>, key.split("."));
  if (value === undefined) {
    env.out(`${key} = (unset)`);
    return 0;
  }
  env.out(`${key} = ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return 0;
}

function set(rest: string[], env: CliEnv, home: string): number {
  const [key, ...valueParts] = rest;
  if (key === undefined || valueParts.length === 0) {
    env.err('loom config set: usage — loom config set <key> <value>');
    env.err(`  settable keys: ${SETTABLE.join(", ")}`);
    return 1;
  }
  const rawValue = valueParts.join(" ");

  if (!STRING_KEYS.has(key) && !NUMBER_KEYS.has(key) && !ARRAY_KEYS.has(key)) {
    env.err(`loom config set: unknown key '${key}'`);
    env.err(`  settable keys: ${SETTABLE.join(", ")}`);
    return 1;
  }

  if (key === "backend" && !knownBackends().includes(rawValue)) {
    env.err(`loom config set: unknown backend '${rawValue}' — one of: ${knownBackends().join(", ")}`);
    return 1;
  }

  let value: unknown = rawValue;
  if (NUMBER_KEYS.has(key)) {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 0) {
      env.err(`loom config set: '${key}' expects a non-negative integer, got '${rawValue}'`);
      return 1;
    }
    value = n;
  } else if (ARRAY_KEYS.has(key)) {
    value = rawValue
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }

  let current: LoomConfig;
  try {
    current = readGlobalConfig(home);
  } catch (err) {
    env.err(`loom config: ${(err as Error).message}`);
    return 1;
  }

  const next = structuredClone(current) as Record<string, unknown>;
  writePath(next, key.split("."), value);

  // Re-validate the whole document through the schema before writing.
  let validated: LoomConfig;
  try {
    validated = parseLoomConfig(next, "global config.json");
  } catch (err) {
    env.err(`loom config set: ${(err as Error).message}`);
    return 1;
  }
  writeGlobalConfig(home, validated);
  env.out(`set ${key} = ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return 0;
}

function readPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function writePath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    const existing = cur[seg];
    if (existing === null || typeof existing !== "object") cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = value;
}
