// `loom allowlist add [path]` — append a project's resolved path to the
// operator-authored project-directory allowlist the server gates on. The
// allowlist stays default-deny and human-owned by design (the engine never
// self-enrolls a project — that is a security property); this command only
// turns the manual file edit into one typed command. Comparison is on the
// resolved (symlink-followed) identity, matching how the gate reads it, so a
// re-add of the same directory under a different spelling is a no-op.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { firstUnknownFlag, parseArgs } from "../lib/args.js";
import type { CliEnv } from "../lib/env.js";

const ALLOWLIST_KNOWN_FLAGS = ["dry-run"] as const;

export function allowlistFilePath(home: string): string {
  return join(home, ".claude", "projects.allow");
}

// The live (non-comment, non-blank) entries, trimmed. Mirrors the gate's
// parse: `#` comments and blank lines are ignored.
export function readAllowlistEntries(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Resolve an entry to its real path; entries that no longer exist on disk
// resolve to their literal value so a stale line never crashes the dedup.
function resolveOrLiteral(entry: string): string {
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

export function allowlistAdd(argv: string[], env: CliEnv): number {
  const { positionals, flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, ALLOWLIST_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom allowlist add: unknown flag --${unknown}`);
    return 1;
  }
  const dryRun = flags.has("dry-run");

  const target = positionals.length > 0 && positionals[0] !== undefined
    ? resolve(env.cwd, positionals[0])
    : env.cwd;

  if (!existsSync(target)) {
    env.err(`loom allowlist add: path does not exist: ${target}`);
    return 1;
  }
  const realTarget = realpathSync(target);

  const filePath = allowlistFilePath(env.home);
  const entries = readAllowlistEntries(filePath);
  const already = entries.some((entry) => resolveOrLiteral(entry) === realTarget);

  if (already) {
    env.out(`already allowlisted: ${realTarget}`);
    return 0;
  }

  if (dryRun) {
    env.out(`[dry-run] would append to ${filePath}:`);
    env.out(`[dry-run]   ${realTarget}`);
    return 0;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  // Append a single newline-terminated line; never rewrite the existing
  // content so an operator's comments and ordering survive.
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  writeFileSync(filePath, `${needsLeadingNewline ? "\n" : ""}${realTarget}\n`, { flag: "a" });
  env.out(`allowlisted: ${realTarget}`);
  env.out(`  (${filePath})`);
  return 0;
}

export function allowlistList(env: CliEnv): number {
  const filePath = allowlistFilePath(env.home);
  const entries = readAllowlistEntries(filePath);
  if (entries.length === 0) {
    env.out(`no projects allowlisted (${filePath})`);
    return 0;
  }
  for (const entry of entries) env.out(entry);
  return 0;
}
