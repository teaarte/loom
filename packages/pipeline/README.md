# @loom/pipeline

One-step install for the loom pipeline. Installing this package puts the
`loom` command on your PATH and pulls everything the pipeline needs to run:
the command-line installer, the MCP server, the default code bundle, and the
zero-config provider.

## Install

```
npm i -g @loom/pipeline
```

## Set up your agent host

```
loom setup           # register the MCP server + install the /task and /done commands
loom allowlist add   # authorize the current project for tasks (run once per project)
```

`loom setup` writes the MCP server registration and drops the `/task` and
`/done` slash commands into your host's command directory. It is idempotent —
re-running it changes nothing and never clobbers a command you have edited
(use `--force` to overwrite). Pass `--project` to scope the install to the
current directory instead of your user profile, or `--dry-run` to preview the
changes.

The project allowlist is default-deny by design: the server never enrolls a
project on its own, so each directory you want to use must be authorized once
with `loom allowlist add`.

## Run a task

In an authorized project, from your agent host:

```
/task fix the typo in the module header comment
```

The host runs each spawned agent with the prompt the server provides, surfaces
each approval gate for your decision, and drives the work to completion. Then
`/done` shows the summary.

## Commands

```
loom setup [--user|--project] [--dry-run] [--force]
loom allowlist add [path] [--dry-run]
loom allowlist list
loom init [--dry-run]
loom --help | --version
```

## License

Apache-2.0
