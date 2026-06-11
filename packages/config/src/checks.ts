// Per-project validation commands — the "configure once" home for the
// deterministic checks (typecheck / lint / test) the pipeline runs before it
// spends a single review token on a change.
//
// A leaf concern: this module reads the project's `package.json` + lockfile to
// auto-detect commands when none are configured, and never names an agent, a
// bundle, or a kernel concept. The resolution is consumed by the transport
// (the CLI), which hands the resolved command list to the driver's deterministic
// executor — config decides WHAT to run, the executor decides HOW.
//
// Precedence per check: an explicit config string wins (run verbatim via the
// user's shell); else a matching `package.json` script (run through the detected
// package manager, argv form, no shell); else the check is SKIPPED — a skipped
// check is recorded but is not a failure, so a project that configures nothing
// and exposes no scripts is never blocked by a check it never asked for.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The three deterministic checks. Names are stable wire keys the bundle maps
// onto its own state fields; they are not a kernel or bundle vocabulary.
export type CheckName = "typecheck" | "lint" | "test";

export const CHECK_NAMES: readonly CheckName[] = ["typecheck", "lint", "test"];

// Per-project validation commands. Each value is a shell command line executed
// VERBATIM in the task's working copy (POSIX shells only — see the executor).
// A loom-controlled value is never interpolated into it; the string is owned by
// the operator's config and run as-is.
export interface ChecksConfig {
  typecheck?: string;
  lint?: string;
  test?: string;
}

// How one resolved check should run:
//   - "shell": a configured command line, run via the user's shell verbatim.
//   - "argv":  an auto-detected package-manager invocation, run as an argv
//              vector (no shell, nothing to interpolate). `display` is the
//              human-readable form for messages / finding summaries.
//   - "skip":  nothing configured and nothing detected — recorded, not failed.
export type ResolvedCheckRun =
  | { kind: "shell"; command: string }
  | { kind: "argv"; argv: string[]; display: string }
  | { kind: "skip"; reason: string };

export interface ResolvedCheckCommand {
  name: CheckName;
  run: ResolvedCheckRun;
}

// Map a project's lockfile to its package-manager run prefix. Defaults to npm
// when no lockfile is recognized — `<pm> run <script>` is the shared form every
// supported manager honors.
const LOCKFILE_PM: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

export function detectPackageManager(projectDir: string): string {
  for (const [lockfile, pm] of LOCKFILE_PM) {
    if (existsSync(join(projectDir, lockfile))) return pm;
  }
  return "npm";
}

// The set of `scripts` declared in the project's `package.json` (empty when the
// file is absent or unreadable — auto-detection simply finds nothing then).
function readPackageScripts(projectDir: string): Set<string> {
  const out = new Set<string>();
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return out; // a malformed package.json yields no detected scripts
  }
  if (parsed === null || typeof parsed !== "object") return out;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (scripts === null || typeof scripts !== "object") return out;
  for (const key of Object.keys(scripts as Record<string, unknown>)) out.add(key);
  return out;
}

// Resolve the command for each of the three checks against the project.
// Returns one entry per check, always in `CHECK_NAMES` order, so the executor
// and the bundle see a stable, complete picture (a skipped check is explicit,
// never an absent entry).
export function resolveCheckCommands(
  projectDir: string,
  configChecks?: ChecksConfig,
): ResolvedCheckCommand[] {
  const scripts = readPackageScripts(projectDir);
  const pm = detectPackageManager(projectDir);
  return CHECK_NAMES.map((name): ResolvedCheckCommand => {
    const configured = configChecks?.[name];
    if (typeof configured === "string" && configured.trim().length > 0) {
      return { name, run: { kind: "shell", command: configured } };
    }
    if (scripts.has(name)) {
      const argv = [pm, "run", name];
      return { name, run: { kind: "argv", argv, display: argv.join(" ") } };
    }
    const reason =
      configured === undefined
        ? `no '${name}' command configured and no matching package.json script`
        : `configured '${name}' command is empty`;
    return { name, run: { kind: "skip", reason } };
  });
}
