// Subcommand dispatcher for the `loom` binary. This is the install surface
// only — `setup`, `allowlist`, `init`, plus `--help`/`--version`. It is the
// seam a richer power-user command set extends; it deliberately ships nothing
// beyond what a first install needs.

import { allowlistAdd, allowlistList } from "./commands/allowlist.js";
import { config } from "./commands/config.js";
import { daemon } from "./commands/daemon.js";
import { init } from "./commands/init.js";
import { models } from "./commands/models.js";
import { projects } from "./commands/projects.js";
import { history, reset } from "./commands/reset.js";
import { runTask } from "./commands/run.js";
import { secrets } from "./commands/secrets.js";
import { serve } from "./commands/serve.js";
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
      Drive a task to its end non-interactively, executing each spawn through
      the Claude Code CLI (claude -p) in an isolated git worktree — on your
      existing Claude Code login (subscription), no API key required. Pauses
      and prints a human gate rather than answering it. Needs Claude Code
      installed and signed in.

  loom daemon start [--watch] [--detach] ["<task>"]
      Run a long-lived supervisor over this project: drive the task headless,
      PARK on a human gate and WAKE when it's answered, retry transient
      failures with backoff, recover an in-flight task on restart, and commit
      finished work to a 'loom/<task>' branch (never auto-merged). With a task,
      start it; without, attach to the active task. --watch keeps supervising
      the slot for the next task; --detach forks a background daemon.
  loom daemon stop [path]
      Signal a running daemon to stop gracefully.
  loom daemon status [path]
      Show whether a daemon is running and where its task sits.

  loom serve [--project <dir>]... [--host h] [--port p] [--token t] [--detach]
      Run a network control plane: supervise a fleet of projects from one
      process (each over the same headless loop) and expose them over HTTP on
      loopback — submit a task, read status, answer a gate, tail the log. A
      dashboard is served at the bind address. Re-attaches every registered
      project on start; a token makes the API require a bearer header.
  loom serve stop
      Signal a running control plane to stop gracefully.
  loom serve status
      Show whether the control plane is running, where it binds, and how many
      projects it supervises.

  loom config get [key] | set <key> <value>
      Read or edit the global config (~/.config/loom/config.json): the backend
      mode and the notify / resilience defaults. Configure once; every project
      inherits it. (Models: 'loom models'; secrets: 'loom secrets'.)
  loom secrets set <name> <value> | list
      Manage the global, machine-local secret store (chmod 600). Reference a
      secret from config as 'secret:<name>'. 'list' shows masked values.
  loom models set <agent> <provider:model|tier> | list
      Bind a bundle's agents to models in the global config. Rejects a model the
      configured backend can't run. 'list' shows each agent's effective model.
  loom projects add [path] [--label <l>] | list | remove <id|path>
      The project catalog — the projects you've worked on, with their current
      status (read even when idle). Distinct from the live supervised set.

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
    case "daemon":
      return daemon(rest, env);
    case "serve":
      return serve(rest, env);
    case "allowlist": {
      const [sub, ...subRest] = rest;
      if (sub === "add") return allowlistAdd(subRest, env);
      if (sub === "list") return allowlistList(env);
      env.err(`loom allowlist: expected 'add' or 'list', got ${sub ?? "(nothing)"}`);
      return 1;
    }
    case "config":
      return config(rest, env);
    case "secrets":
      return secrets(rest, env);
    case "models":
      return models(rest, env);
    case "projects":
      return projects(rest, env);
    default:
      env.err(`loom: unknown command '${command}'`);
      env.err("run 'loom --help' for usage");
      return 1;
  }
}
