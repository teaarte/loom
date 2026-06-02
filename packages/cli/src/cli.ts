// Subcommand dispatcher for the `loom` binary. This is the install surface
// only — `setup`, `allowlist`, `init`, plus `--help`/`--version`. It is the
// seam a richer power-user command set extends; it deliberately ships nothing
// beyond what a first install needs.

import { allowlistAdd, allowlistList } from "./commands/allowlist.js";
import { init } from "./commands/init.js";
import { history, reset } from "./commands/reset.js";
import { runTask } from "./commands/run.js";
import { setup } from "./commands/setup.js";
import { status } from "./commands/status.js";
import { processEnv, type CliEnv } from "./lib/env.js";
import { readCliVersion } from "./version.js";

const HELP = `loom — set up and authorize the pipeline for your agent host

Usage:
  loom setup [--user|--project] [--dry-run] [--force]
      Register the MCP server and install the /task, /done, and /resume commands.
      --user      install for your user (default): ~/.claude.json + ~/.claude/commands/
      --project   install for this project only:  ./.mcp.json + ./.claude/commands/
      --dry-run   print what would change without writing anything
      --force     overwrite a divergent registration or a locally-edited command

  loom allowlist add [path] [--dry-run]
      Authorize a project directory for tasks (default: current directory).
  loom allowlist list
      Show the authorized project directories.

  loom init [--dry-run]
      Ensure this project's .claude/ exists and authorize it, then point at /task.

  loom reset [path] [--force] [--dry-run]
      Archive this project's finished task into .claude/history/ and free the
      slot so the next task starts clean (default: current directory).
      An in-progress task is refused unless --force is given.
  loom history [path]
      List the archived tasks for this project.

  loom status [path]
      Show this project's task: its status, where in the flow it sits, any
      pending agents and how long they've waited. Flags a stalled task (a
      likely dropped transport) — resume it with /resume or 'loom resume'.

  loom run "<task>"
      Drive a task to its end non-interactively, executing each spawn with a
      configured provider instead of a host. Pauses and prints a human gate
      rather than answering it. Needs an async provider configured for this
      project.

  loom --help | --version

Typical first run:
  npm i -g @loomfsm/pipeline
  loom setup
  loom allowlist add        # in each project you want to use
`;

// Returns a number for the synchronous (filesystem-only) commands, or a
// Promise for the commands that open the project store (`reset`). The bin
// awaits either form; tests of the sync commands keep asserting a number.
export function run(argv: string[], env: CliEnv = processEnv()): number | Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    env.out(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    env.out(readCliVersion());
    return 0;
  }

  switch (command) {
    case "setup":
      return setup(rest, env);
    case "init":
      return init(rest, env);
    case "reset":
      return reset(rest, env);
    case "history":
      return history(rest, env);
    case "status":
      return status(rest, env);
    case "run":
      return runTask(rest, env);
    case "allowlist": {
      const [sub, ...subRest] = rest;
      if (sub === "add") return allowlistAdd(subRest, env);
      if (sub === "list") return allowlistList(env);
      env.err(`loom allowlist: expected 'add' or 'list', got ${sub ?? "(nothing)"}`);
      return 1;
    }
    default:
      env.err(`loom: unknown command '${command}'`);
      env.err("run 'loom --help' for usage");
      return 1;
  }
}
