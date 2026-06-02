# @loomfsm/driver

The transport-neutral orchestration runtime for loom — the headless
driver-loop, the directive→wire adapter, and the conformant delivery
composition that every loom transport shares.

`drive(projectDir, { executor, resolveRegistry, … })` runs a task to its end
by spinning the kernel's directive contract — spawn / ask / complete / error —
with **zero domain branching**: it never learns what a bundle's stages *mean*.
The one injected seam is the `Executor` — "how to run a single spawn" — so a
host tool and a provider-backed backend drive the very same loop. A dropped
task re-attaches by reading the kernel (the resume re-emit, reusing the
existing ids), and the file-delta / audit / idempotency bookkeeping is
implemented here **once** so no transport can silently skip it.

This is the body a long-running daemon wraps, and the reference for a
conformant driver.

## What's in it

- **`drive(projectDir, opts)`** — the loop. Returns a `DriveOutcome`:
  `complete` · `paused` (a human gate — printed, never auto-answered) · `error`
  (routed to an injected recovery policy, or surfaced). Caps fanout
  concurrency + wall-time, and retries a failed executor via the resume
  re-emit without double-spawning.
- **`Executor` / `createProviderExecutor(provider)`** — the spawn seam. The
  provider-backed executor runs spawns in-process against an `async` provider;
  a shuttle-only provider is refused (it has no host to hand spawns to).
- **`createTransportAdapter` / `shape`** — the pure `KernelDirective → wire`
  mapping every transport carries.
- **`createAndStart` / `deliverAndAdvance` / `recoverAndAdvance`** — the shared
  create / deliver / recover compositions: one transaction over the kernel,
  the server-computed file delta, a co-committed audit row, the idempotency
  ledger, and the resume-point persist.
- **`resumeDirective(state, registry)`** — re-emit the directive a paused task
  is waiting on, reusing its ids (the restart head).

## Runtime requirement

`@loomfsm/driver` loads `@loomfsm/kernel`, which imports `node:sqlite` — on
**Node 22.x** that needs `--experimental-sqlite` (a harmless no-op on Node
23+). See [`@loomfsm/kernel`](../kernel/README.md) for details.

## CLI

`loom run "<task>"` (from [`@loomfsm/cli`](../cli/README.md)) is the
non-interactive entry to this runtime: it drives a task to its end with a
provider-backed executor, pausing and printing a human gate rather than
answering it.

## Install

```bash
pnpm add @loomfsm/driver
```

## License

Apache 2.0 — see the repository [LICENSE](../../LICENSE).
