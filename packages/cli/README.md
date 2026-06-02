# @loomfsm/cli

The `loom` command-line tool. It registers the pipeline MCP server with your
agent host, installs the `/task`, `/done`, and `/resume` slash commands,
authorizes project directories, and inspects or drives the active task.

Most users install the [`@loomfsm/pipeline`](https://www.npmjs.com/package/@loomfsm/pipeline)
meta-package, which bundles this CLI together with the server, the default
bundle, and the provider in a single `npm i -g`. Install this package directly
only if you are assembling your own runtime.

## Commands

```
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
    Ensure this project's .claude/ exists, authorize it, then point at /task.

loom reset [path] [--force] [--dry-run]
    Archive this project's finished task into .claude/history/ and free the slot
    for the next one. An in-progress task is refused unless --force is given.

loom history [path]
    List the archived tasks for this project.

loom status [path]
    Show the active task: its status, where in the flow it sits, any pending
    agents and how long they've waited. Flags a stalled task (a likely dropped
    transport) — resume it with /resume.

loom run "<task>"
    Drive a task to its end non-interactively, executing each spawn with a
    configured provider instead of a host. Pauses and prints a human gate
    rather than answering it. Needs an async provider configured for the project.

loom --help | --version
```

Setup is idempotent: re-running changes nothing and never clobbers a command
you have edited. The project allowlist is default-deny and operator-authored —
the server never enrolls a directory on its own.

## License

Apache-2.0
