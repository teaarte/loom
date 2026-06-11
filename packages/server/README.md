# @loomfsm/server

loom's network control plane: an HTTP transport over the headless driver loop. One local
server supervises a fleet of projects — submit tasks, read live state, answer gates, tail
logs over SSE — and serves the web dashboard. The Telegram bot intake lives here too.

## What's inside

- **HTTP API** — submit / read-model / answer / pause / resume / cancel / ship, multi-project.
- **SSE** — live log and state streaming to the dashboard.
- **Security posture** — binds loopback by default and refuses non-loopback hosts without a
  bearer token; project registration is allowlist-gated; secrets are masked on every read.
- **Telegram intake** — outbound-only long-poll bot with a default-deny user-id allowlist.

Start it with `loom up` (with the dashboard) or `loom serve` (headless) from the
[`@loomfsm/pipeline`](https://www.npmjs.com/package/@loomfsm/pipeline) install.

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
