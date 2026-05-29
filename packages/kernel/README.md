# @loom/kernel

The FSM kernel: state machine, invariants, idempotency ledger, policy
engine, and the plugin contracts that providers, transports, and bundles
implement. Zero runtime dependencies — persistence rides on Node's
built-in `node:sqlite`.

## Runtime requirement

`@loom/kernel` imports `node:sqlite`. On **Node 22.x** that module is
behind a runtime flag, so any process that loads the kernel — your app,
your test runner, a one-off script — must pass it:

```bash
node --experimental-sqlite your-entry.js
node --experimental-sqlite --test            # node:test
```

`--no-warnings` additionally silences the once-per-process
`ExperimentalWarning` for `node:sqlite`:

```bash
node --experimental-sqlite --no-warnings --test
```

`node:sqlite` is unflagged on **Node 23+** and stable on **Node 24+**;
on those versions the flag is a harmless no-op, so it is safe to leave in
shared scripts that may run on either line.

## Install

```bash
pnpm add @loom/kernel
```

## License

Apache 2.0 — see the repository [LICENSE](../../LICENSE).
