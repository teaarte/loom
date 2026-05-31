# Setting up the pipeline MCP server

This server exposes the pipeline tools over stdio. A host (e.g. an MCP-capable
agent CLI) spawns it, registers the two slash commands that drive it, and points
it at a project that has been added to the allowlist.

## Quick install (recommended)

If you installed the `loom` command (`npm i -g @loomfsm/pipeline`), the three steps
below are automated:

```
loom setup            # register the server + install /task and /done
loom allowlist add    # authorize the current project (run once per project)
```

`loom setup` is idempotent — re-running it changes nothing and never clobbers a
command you have edited (pass `--force` to overwrite, `--dry-run` to preview,
`--project` to scope to the current directory instead of your user profile).

The rest of this file documents the same three steps done by hand, as a fallback
or for a host that does not use the `loom` command.

## 1. Register the server

Build the workspace first so the entrypoint and the bundle it loads exist on disk:

```
pnpm -r build
```

The stdio entrypoint is `packages/mcp-server/dist/src/bin/stdio.js`. It uses the
built-in SQLite module, which on current Node releases is reached with
`--experimental-sqlite`. Register it under the name **`loom`** in your host's MCP
configuration.

`.mcp.json` (project- or user-level):

```json
{
  "mcpServers": {
    "loom": {
      "command": "node",
      "args": [
        "--experimental-sqlite",
        "--no-warnings",
        "/ABSOLUTE/PATH/TO/packages/mcp-server/dist/src/bin/stdio.js"
      ]
    }
  }
}
```

Or, if your host ships an `mcp add` helper:

```
claude mcp add loom -- node --experimental-sqlite --no-warnings \
  /ABSOLUTE/PATH/TO/packages/mcp-server/dist/src/bin/stdio.js
```

The server's tools are then exposed as `mcp__loom__pipeline_*`. If you register it
under a different name, swap the `mcp__loom__` prefix in the slash commands to match
(both command files note this).

## 2. Install the slash commands

The router commands live in `packages/mcp-server/cc-adapter/commands/`. Copy them into
your host's command directory (user-level shown; a project-level `.claude/commands/`
works too):

```
mkdir -p ~/.claude/commands
cp packages/mcp-server/cc-adapter/commands/task.md ~/.claude/commands/
cp packages/mcp-server/cc-adapter/commands/done.md ~/.claude/commands/
```

- **`/task <description>`** — starts a task and drives the spawn → deliver → gate loop
  to completion. It parses any leading flag itself; the server owns all semantics.
- **`/done`** — read-only review of a finished (or stuck) task.

Both files are dumb routers: they hold no gate vocabulary and edit no state. Adding a
preset, gate, or bundle never edits them.

## 3. Allowlist the project (per project, once)

The project-directory allowlist is **default-deny** and operator-authored: the server
never enrolls a project on its own, so a tool call against an unlisted directory is
refused with `PROJECT_DIR_NOT_ALLOWED`. The entrypoint ensures the file exists but
never adds entries. Add a project by appending its absolute path (one per line):

```
mkdir -p ~/.claude
echo "$(cd /path/to/project && pwd -P)" >> ~/.claude/projects.allow
```

Run it from the project root (`echo "$(pwd -P)" >> ~/.claude/projects.allow`) to add
the current directory. `#` comments and blank lines are ignored. Paths are compared on
their resolved (symlink-followed) identity, so a symlinked or `..`-laden path still
matches its real target.

## Run it

In an allowlisted project:

```
/task fix the typo in the module header comment
```

The server initializes the task, runs the bundle's default flow, and returns the first
directive. The host runs each spawned agent with the prompt the server provides (the
agent's real instruction body), feeds results back, surfaces each gate verbatim for
your approval, and reaches `complete`. Then `/done` shows the summary.

The first state DB is created at `<project>/.claude/state.db` on the first call; kernel
migrations apply automatically on open.

## Notes for operators

- **Provider / models.** The default bundle routes through the zero-config shuttle
  provider: no API key, no network. The provider declares no model list, so an agent's
  declared tier (`fast` / `premium` / `balanced`) is carried through to the spawn
  request's `model` field. The host's task runner may use that string or substitute its
  own model — the server does not require a concrete model id. If your runner needs real
  model ids, map the tier names on the host side.
- **Subagent routing.** Spawn requests carry `extras` (the routed provider, the agent's
  template path). The slash command passes `subagent_type` from `extras` only when
  present; absent that, every agent runs as the host's default task subagent.
- **Caller identity.** `owner_id` defaults to `anonymous` when the command does not pass
  one. It scopes ownership for recovery; supply one per caller if you want cross-owner
  recovery to require an explicit bypass marker.
- **Repair.** A stuck task is repaired only through the server's recovery options
  (surfaced by `/task` on an `error`, or by `/done`). Never hand-edit the state DB.
