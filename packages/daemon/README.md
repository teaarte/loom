# @loomfsm/daemon

The long-lived supervisor over loom's headless driver loop — "set it and check back". It
drives a project's tasks server-side and surfaces you only at decision points.

## What it does

- **Parks** on a genuine human gate and **wakes** when you answer (from the dashboard, the
  Telegram bot, or the CLI).
- **Retries** transient failures with backoff; a permanent provider error parks the task
  instead of retry-looping.
- **Recovers** an interrupted task on restart — idempotent re-delivery, no double work.
- **Commits** finished work to a `loom/<task>` branch: reviewable, never auto-merged, with
  optional push / squash-merge on accept.

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
