# @loomfsm/mcp-server

loom's MCP transport: exposes the pipeline tools over stdio so an MCP host (such as Claude
Code) can run loom with **zero additional infrastructure** — the host executes each agent
step itself, no API key, no network.

## What's inside

- The MCP server registration plus the `/task`, `/done`, and `/proceed` slash commands that
  `loom setup` installs into your host.
- The pipeline tools: run / continue / state / recover / resume / archive and friends, all
  delegating to the same driver loop every other transport uses.

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
