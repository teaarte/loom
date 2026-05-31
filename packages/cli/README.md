# @loomfsm/cli

The `loom` command-line installer. It registers the pipeline MCP server with
your agent host, installs the `/task` and `/done` slash commands, and
authorizes project directories for tasks.

Most users install the [`@loomfsm/pipeline`](https://www.npmjs.com/package/@loomfsm/pipeline)
meta-package, which bundles this CLI together with the server, the default
bundle, and the provider in a single `npm i -g`. Install this package directly
only if you are assembling your own runtime.

## Commands

```
loom setup [--user|--project] [--dry-run] [--force]
    Register the MCP server and install the /task and /done commands.
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

loom --help | --version
```

Setup is idempotent: re-running changes nothing and never clobbers a command
you have edited. The project allowlist is default-deny and operator-authored —
the server never enrolls a directory on its own.

## License

Apache-2.0
