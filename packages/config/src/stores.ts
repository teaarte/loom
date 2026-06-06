// The four stores' I/O. Each read tolerates an absent file (→ empty), validates
// a present one through the Zod schema (→ a clear sourced error on malformed),
// and each write is atomic (temp + rename) so a concurrent reader never sees a
// half-written file — the same posture `server/src/process-control.ts` takes for
// its state files. `secrets.json` is written chmod 600.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  configPath,
  legacyProjectConfigPath,
  projectConfigPath,
  secretsPath,
  workspacePath,
} from "./paths.js";
import {
  parseLoomConfig,
  parseSecretsFile,
  parseWorkspaceFile,
} from "./schema.js";
import type { LoomConfig, SecretsFile, WorkspaceEntry } from "./types.js";

// ----- low-level helpers ---------------------------------------------------

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON at ${path}: ${(err as Error).message}`);
  }
}

// Atomic write: temp in the same dir + rename. `mode` is applied to the temp
// (and re-asserted via chmod) before the rename so the final file lands with the
// intended permissions — used for the 600 secrets file.
function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(tmp, body, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// ----- global config (config.json) -----------------------------------------

export function readGlobalConfig(loomHome: string): LoomConfig {
  const raw = readJson(configPath(loomHome));
  if (raw === undefined) return {};
  return parseLoomConfig(raw, "global config.json");
}

export function writeGlobalConfig(loomHome: string, config: LoomConfig): void {
  writeJsonAtomic(configPath(loomHome), config);
}

// ----- project config (<repo>/.loom/loom.json) ------------------------------

export function readProjectConfig(projectDir: string): LoomConfig {
  // Prefer the new `.loom/` location; fall back to a legacy `.claude/loom.json`
  // a kernel-side footprint migration has not relocated yet.
  let raw = readJson(projectConfigPath(projectDir));
  let source = "<repo>/.loom/loom.json";
  if (raw === undefined) {
    raw = readJson(legacyProjectConfigPath(projectDir));
    source = "<repo>/.claude/loom.json";
  }
  if (raw === undefined) return {};
  return parseLoomConfig(raw, source);
}

export function writeProjectConfig(projectDir: string, config: LoomConfig): void {
  writeJsonAtomic(projectConfigPath(projectDir), config);
}

// ----- secrets (secrets.json, chmod 600) ------------------------------------

const SECRETS_MODE = 0o600;

export function readSecrets(loomHome: string): SecretsFile {
  const raw = readJson(secretsPath(loomHome));
  if (raw === undefined) return {};
  return parseSecretsFile(raw, "secrets.json");
}

export function writeSecrets(loomHome: string, secrets: SecretsFile): void {
  writeJsonAtomic(secretsPath(loomHome), secrets, SECRETS_MODE);
}

// ----- workspace catalog (workspace.json) -----------------------------------

export function readWorkspace(loomHome: string): WorkspaceEntry[] {
  const raw = readJson(workspacePath(loomHome));
  if (raw === undefined) return [];
  return parseWorkspaceFile(raw, "workspace.json");
}

export function writeWorkspace(loomHome: string, projects: WorkspaceEntry[]): void {
  writeJsonAtomic(workspacePath(loomHome), { projects });
}
