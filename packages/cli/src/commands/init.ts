// `loom init` — the friendly per-project entry point: ensure the project's
// `.claude/` directory exists and authorize the current directory for tasks.
// Authorization is the same operator action as `loom allowlist add` (cwd), so
// init delegates to it rather than forking the dedup/realpath logic, then
// points the user at `/task`.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { firstUnknownFlag, parseArgs } from "../lib/args.js";
import type { CliEnv } from "../lib/env.js";
import { allowlistAdd } from "./allowlist.js";

const INIT_KNOWN_FLAGS = ["dry-run"] as const;

export function init(argv: string[], env: CliEnv): number {
  const { flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, INIT_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom init: unknown flag --${unknown}`);
    return 1;
  }
  const dryRun = flags.has("dry-run");
  const claudeDir = join(env.cwd, ".claude");

  if (dryRun) {
    if (!existsSync(claudeDir)) env.out(`[dry-run] would create ${claudeDir}`);
  } else if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
    env.out(`created ${claudeDir}`);
  }

  // Allowlist the current directory (its own dedup keeps a re-run a no-op).
  const code = allowlistAdd(dryRun ? ["--dry-run"] : [], env);
  if (code !== 0) return code;

  if (!dryRun) {
    env.out("");
    env.out("ready — run /task <description> in this project to start a task.");
  }
  return 0;
}
