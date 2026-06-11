<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/teaarte/loom/main/assets/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/teaarte/loom/main/assets/logo.svg" alt="loom" width="200">
</picture>

**Agent runs you can prove — not just trust.**
</div>

# @loomfsm/pipeline

One-step install for [loom](https://loomfsm.dev). This meta-package puts the `loom` command
on your PATH and pulls everything the pipeline needs: the kernel, driver, daemon, server,
dashboard, MCP server, CLI, the `code` bundle, and the zero-config provider.

## Install

```bash
npm i -g @loomfsm/pipeline
```

## Run it

**Web dashboard** — the fastest path:

```bash
loom up      # start the local control plane + open the dashboard (127.0.0.1:4317)
```

**Inside your agent host (Claude Code)** — no API key, no network:

```bash
loom setup            # register the MCP server + the /task, /done, /proceed commands
loom allowlist add    # authorize the current project (once per project; default-deny)
```

then, in that project: `/task add rate limiting to the login endpoint`.

**Headless / autonomous:**

```bash
loom run "fix the flaky retry test"          # one task to the end, isolated git worktree
loom daemon start --watch                    # park on gates, wake on answers, recover on restart
loom bot telegram                            # drive the fleet from your phone
```

State lives at `<project>/.loom/state.db` — a plain SQLite file you own. Every mode drives
the identical state machine, gates, and invariants.

## Part of loom

[loom](https://loomfsm.dev) drives multi-step LLM agent work — code review, implementation,
any review-gated task — as a replay-deterministic state machine: safety invariants enforced
at commit time, human gates where they matter, and a complete, replayable audit trail in a
local SQLite file.

**Most users should install [`@loomfsm/pipeline`](https://www.npmjs.com/package/@loomfsm/pipeline)**
(`npm i -g @loomfsm/pipeline`), which pulls the whole runtime in one step. Install this
package directly only if you are assembling your own runtime.

[Website](https://loomfsm.dev) · [Quickstart](https://loomfsm.dev/docs/) · [Why loom](https://loomfsm.dev/why/) · [GitHub](https://github.com/teaarte/loom)

## License

Apache-2.0
