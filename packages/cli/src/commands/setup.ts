// `loom setup` — turn the three manual install steps (register the MCP
// server, drop the `/task` + `/done` + `/resume` slash commands, then allowlist) into one
// idempotent command. This handles the first two; it prints `loom allowlist
// add` as the next step because allowlisting is the operator's deliberate,
// per-project authorization and is never implied by setup.
//
// Mechanism: write the host config directly rather than shelling out to a
// host-specific `mcp add` helper. A direct read-modify-write is host-agnostic,
// dry-runnable (we can print the exact intended config without a side effect),
// and idempotent by construction (re-running compares the desired entry to
// what is on disk). The registered command carries `--experimental-sqlite`
// because the server reaches its built-in SQLite store through that flag on
// current Node; the flag is forward-compatible and drops out once node:sqlite
// stabilizes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { firstUnknownFlag, parseArgs } from "../lib/args.js";
import type { CliEnv } from "../lib/env.js";
import { isRecord, jsonEqual, type JsonValue } from "../lib/json.js";

const SETUP_KNOWN_FLAGS = ["user", "project", "dry-run", "force"] as const;

// The server alias the slash commands address (`mcp__loom__pipeline_*`).
const SERVER_NAME = "loom";
const COMMAND_FILES = ["task.md", "done.md", "resume.md"] as const;

interface SetupConfig {
  scope: "user" | "project";
  dryRun: boolean;
  force: boolean;
}

// Where the MCP server entry and the slash commands land for each scope.
interface SetupTargets {
  configPath: string;
  commandsDir: string;
}

function resolveTargets(scope: "user" | "project", env: CliEnv): SetupTargets {
  if (scope === "project") {
    return {
      configPath: join(env.cwd, ".mcp.json"),
      commandsDir: join(env.cwd, ".claude", "commands"),
    };
  }
  return {
    configPath: join(env.home, ".claude.json"),
    commandsDir: join(env.home, ".claude", "commands"),
  };
}

// The installed @loomfsm/mcp-server package root + its declared entrypoint, both
// resolved through Node's resolver so they work from an installed
// node_modules copy and the monorepo workspace symlink alike.
export interface ServerSource {
  stdioPath: string;
  commandsSourceDir: string;
}

export function resolveServerSource(): ServerSource {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@loomfsm/mcp-server/package.json");
  const pkgRoot = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: JsonValue };
  const binRel =
    isRecord(pkg.bin) && typeof pkg.bin["loom-mcp-server"] === "string"
      ? pkg.bin["loom-mcp-server"]
      : typeof pkg.bin === "string"
        ? pkg.bin
        : undefined;
  if (binRel === undefined) {
    throw new Error("@loomfsm/mcp-server package.json declares no stdio entrypoint");
  }
  return {
    stdioPath: resolve(pkgRoot, binRel),
    commandsSourceDir: join(pkgRoot, "cc-adapter", "commands"),
  };
}

function desiredServerEntry(stdioPath: string): Record<string, JsonValue> {
  return {
    type: "stdio",
    command: "node",
    args: ["--experimental-sqlite", "--no-warnings", stdioPath],
  };
}

// One planned file/config mutation, rendered to the user before (dry-run) or
// after it is applied.
type Outcome = "create" | "update" | "unchanged" | "skip";

interface PlannedAction {
  outcome: Outcome;
  describe: string;
  apply?: () => void;
}

function planServerEntry(
  targets: SetupTargets,
  stdioPath: string,
  cfg: SetupConfig,
): PlannedAction {
  const { configPath } = targets;
  let config: Record<string, JsonValue> = {};
  if (existsSync(configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (isRecord(parsed)) config = parsed;
  }
  const servers = isRecord(config["mcpServers"]) ? { ...config["mcpServers"] } : {};
  const desired = desiredServerEntry(stdioPath);
  const existing = servers[SERVER_NAME];

  let outcome: Outcome;
  if (existing === undefined) outcome = "create";
  else if (jsonEqual(existing, desired)) outcome = "unchanged";
  else if (cfg.force) outcome = "update";
  else outcome = "skip";

  const describe =
    outcome === "unchanged"
      ? `MCP server '${SERVER_NAME}' already registered in ${configPath}`
      : outcome === "skip"
        ? `MCP server '${SERVER_NAME}' differs in ${configPath} (re-run with --force to overwrite)`
        : `${outcome === "create" ? "register" : "update"} MCP server '${SERVER_NAME}' in ${configPath}`;

  const apply =
    outcome === "create" || outcome === "update"
      ? (): void => {
          servers[SERVER_NAME] = desired;
          config["mcpServers"] = servers;
          mkdirSync(dirname(configPath), { recursive: true });
          writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        }
      : undefined;

  return { outcome, describe, ...(apply ? { apply } : {}) };
}

function planCommand(
  name: string,
  sourceDir: string,
  targets: SetupTargets,
  cfg: SetupConfig,
): PlannedAction {
  const sourcePath = join(sourceDir, name);
  const targetPath = join(targets.commandsDir, name);
  const sourceContent = readFileSync(sourcePath, "utf8");

  let outcome: Outcome;
  if (!existsSync(targetPath)) outcome = "create";
  else if (readFileSync(targetPath, "utf8") === sourceContent) outcome = "unchanged";
  else if (cfg.force) outcome = "update";
  else outcome = "skip";

  const describe =
    outcome === "unchanged"
      ? `command /${name.replace(/\.md$/, "")} already installed at ${targetPath}`
      : outcome === "skip"
        ? `command /${name.replace(/\.md$/, "")} locally modified at ${targetPath} (re-run with --force to overwrite)`
        : `${outcome === "create" ? "install" : "update"} command /${name.replace(/\.md$/, "")} at ${targetPath}`;

  const apply =
    outcome === "create" || outcome === "update"
      ? (): void => {
          mkdirSync(targets.commandsDir, { recursive: true });
          writeFileSync(targetPath, sourceContent, "utf8");
        }
      : undefined;

  return { outcome, describe, ...(apply ? { apply } : {}) };
}

export interface SetupOpts {
  // Tests inject a controlled server source; production resolves the installed
  // @loomfsm/mcp-server package.
  source?: ServerSource;
}

export function setup(argv: string[], env: CliEnv, opts: SetupOpts = {}): number {
  const { flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, SETUP_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom setup: unknown flag --${unknown}`);
    return 1;
  }
  if (flags.has("user") && flags.has("project")) {
    env.err("loom setup: --user and --project are mutually exclusive");
    return 1;
  }
  const cfg: SetupConfig = {
    scope: flags.has("project") ? "project" : "user",
    dryRun: flags.has("dry-run"),
    force: flags.has("force"),
  };

  let source: ServerSource;
  try {
    source = opts.source ?? resolveServerSource();
  } catch (err) {
    env.err(`loom setup: ${(err as Error).message}`);
    return 1;
  }
  if (!existsSync(source.stdioPath)) {
    env.err(`loom setup: server entrypoint not found at ${source.stdioPath} (build the workspace first?)`);
    return 1;
  }

  const targets = resolveTargets(cfg.scope, env);

  const actions: PlannedAction[] = [];
  try {
    actions.push(planServerEntry(targets, source.stdioPath, cfg));
    for (const name of COMMAND_FILES) {
      actions.push(planCommand(name, source.commandsSourceDir, targets, cfg));
    }
  } catch (err) {
    env.err(`loom setup: ${(err as Error).message}`);
    return 1;
  }

  const prefix = cfg.dryRun ? "[dry-run] " : "";
  for (const action of actions) {
    env.out(`${prefix}${action.describe}`);
    if (!cfg.dryRun && action.apply) action.apply();
  }

  if (cfg.dryRun) {
    env.out("[dry-run] no changes written");
  } else {
    env.out("");
    env.out("next: loom allowlist add   # authorize this project for /task");
  }
  // A `skip` (a locally-edited command or a divergent registration left
  // untouched) is a deliberate no-clobber, not a failure — setup still exits 0.
  return 0;
}
