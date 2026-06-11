# @loomfsm/config

loom's configure-once control layer: the global config, the machine-local secret store, the
per-agent model map, and the catalog of projects. Set keys and model bindings once — from the
CLI or the dashboard — and every project inherits them.

## What's inside

- **Config store** — schema-validated (with the offending file named in errors), written
  atomically, with legacy-location fallback.
- **Secrets** — stored `chmod 600`, referenced as `secret:<name>`, masked on every read;
  write-only through the API.
- **Model map** — bind any bundle agent to `provider:model` or a tier, with per-agent
  fallback chains.
- **Project catalog** — the directories loom may drive, default-deny.

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
