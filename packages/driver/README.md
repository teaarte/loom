# @loomfsm/driver

loom's transport-neutral orchestration runtime: the headless `drive()` loop every transport
wraps, the `Executor` seam, and the backend executors that actually run agents. The directive
contract is implemented once, here — the CLI, HTTP server, MCP server, and Telegram bot are
all thin clients of this loop.

## What's inside

- **`drive()`** — advances the state machine to the next genuine decision point: a human gate
  parks the run; everything else proceeds autonomously, under a hard total-spawn cap.
- **Executors** — Claude Code CLI (`claude -p`), Aider, opencode, and Docker-isolated
  variants, all behind one seam; a file-editing agent runs in an **isolated git worktree**,
  never your live checkout.
- **Resilience** — typed error classification (transient / rate-limit / permanent), per-agent
  model fallback chains, idempotent re-delivery on recovery.

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
