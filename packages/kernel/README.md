# @loomfsm/kernel

The finite-state-machine kernel underneath loom: the state machine, commit-time safety
invariants, the idempotency ledger, the gate-policy engine, and the plugin contracts that
providers, transports, and bundles implement. **Zero runtime dependencies** — persistence
rides on Node's built-in `node:sqlite`. The kernel is domain-blind: it contains no vendor,
model, or transport names (enforced by CI), so a new domain is a new bundle and the kernel
never changes.

## What's inside

- **Atomic state** — every step commits through a SQLite transaction; invariants run inside
  it and roll it back on violation, so an unsafe state never exists.
- **Idempotency ledger** — every effect's ledger row is committed in the same transaction as
  the state change it dedupes; crash recovery is "restart and replay".
- **Replay determinism** — one timestamp token captured per tick and threaded through every
  call; the same (state, timestamp, ledger) yields the same trajectory.
- **Gate policies** — `human` / `on-blockers` / `auto`, dispatched as functions, not switches.
- **Plugin contracts** — the typed surfaces bundles, providers, and transports implement.

## Runtime requirement

`@loomfsm/kernel` imports `node:sqlite`. On **Node 22.x** that module is behind a runtime
flag, so any process that loads the kernel must pass it:

```bash
node --experimental-sqlite your-entry.js
node --experimental-sqlite --no-warnings --test   # node:test, warning silenced
```

`node:sqlite` is unflagged on **Node 23+** and stable on **Node 24+**; the flag is a
harmless no-op there.

## Install

```bash
pnpm add @loomfsm/kernel
```

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
