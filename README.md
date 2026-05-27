# loom

> A small, generic FSM kernel for multi-agent LLM workflows. Atomic state. Replay-deterministic. Policy-as-function autonomy. SQLite-backed. No framework, no inversion of control.

**Status:** pre-implementation. The substrate is specified; K1-K19 build it. See [WHITEPAPER.md](WHITEPAPER.md) for the design.

---

## What it is

A kernel that holds the authoritative state of a multi-agent workflow in atomic SQLite transactions, drives it via a five-variant `Stage` discriminated union, and decides autonomy via policy functions — not mode flags. Domain knowledge (agents, phases, gate semantics, finding categories) lives in **bundles**, not in the kernel. The v1 MVP ships one bundle: `code` — multi-agent code-review and implementation pipeline.

The kernel exposes three plug axes:

- **Bundles** — domain. The `code` bundle ships first. Other domains (research, VFX, ops) are additive.
- **Providers** — LLM backend. `claude-code-shuttle`, `anthropic-sdk`, `openrouter`. Capability-driven, not name-driven.
- **Transports** — wire shape. `mcp-server`, `cli`, daemon (deferred to v1.1).

The name reflects the design: state is the **warp**, agents are the **weft**, providers are the **shuttle**. One FSM tick = one pick of the loom, committed atomically.

## What it isn't

- Not a prompt-template framework. Templates live in bundles, typed and validated.
- Not an agent IDE. It runs underneath your IDE / shell / MCP host.
- Not a distributed runtime. Single in-flight task per project, by design.
- Not "AGI plumbing." A finite-state machine that survives crashes and tells the operator what happened.

## Quick facts

| | |
|---|---|
| Kernel size (target) | ~12-15k LOC |
| Language | TypeScript (Node 22+, pnpm workspaces) |
| State store | SQLite WAL, `BEGIN IMMEDIATE` |
| Determinism | Replay-deterministic via persisted `NowToken` |
| Atomicity | Single `StateBackend.withTransaction` per kernel call |
| Idempotency | Co-committed ledger keyed per boundary-crossing op |
| Invariants | 13 kernel-generic + bundle-declared, in-tx, rollback on violation |
| Autonomy model | `Policy = (state, role, ctx) → Decision` — kernel does not switch on policy names |
| Default policy preset | `gates-on-blockers` (asks human only if blocking findings exist) |
| Threat model (MVP) | Curated trust: zero third-party bundles. Runtime fence deferred to v1.1. |
| Build envelope | 38-44 days realistic, 46-52 days conservative |
| Validation | 4-5 real-task bridge runs after integration phase |
| License | Apache 2.0 |

## Repository layout

```
packages/
  kernel/                       FSM, invariants, ledger, gate-policy, types
  mcp-server/                   MCP transport (stdio + remote)
  cli/                          `loom` binary — power-user transport
  providers/
    claude-code-shuttle/        Default shuttle provider (no API key needed)
    anthropic-sdk/              Direct Anthropic with prompt-caching + idempotent_spawn
    openrouter/                 Multi-model routing
  bundles/
    code/                       Code-review / implementation bundle (MVP)

WHITEPAPER.md                   Design rationale and architecture
README.md                       This file
LICENSE                         Apache 2.0
```

npm packages are published under the `@loom/*` scope: `@loom/kernel`, `@loom/mcp-server`, `@loom/cli`, `@loom/provider-anthropic-sdk`, `@loom/provider-claude-code-shuttle`, `@loom/provider-openrouter`, `@loom/bundle-code`.

## Getting started

> Repository is pre-implementation. The commands below describe the v1.0 surface; they will become real as K12 (mcp-server) and K17 (cli) land.

```bash
# Install (placeholder)
pnpm install
pnpm -r build

# CLI — drive a task
loom run "fix login bug" --bundle=code --policy=gates-on-blockers

# Inspect state
loom state --format=summary
loom audit --since=1h
loom findings --phase=implementation

# Continue from a paused gate
loom continue --gate-event-id=<id> --answer=approve

# MCP server (for Claude Desktop / Claude Code integration)
loom-mcp        # stdio transport
```

## Concept primer

- **Stage** — one of five variants (`SpawnStage`, `FanoutStage`, `GateStage`, `StepStage`, `FinalizeStage`). A `Bundle.flows` map names sequences of stages.
- **Gate** — a checkpoint whose outcome is decided by a `Policy`. Roles: `classify`, `plan`, `final` (kernel-recognized; bundles add more).
- **Policy** — function `(state, role, ctx) → Decision`. Decision is one of: `human-required`, `auto-approve`, `auto-reject`. Five YAML presets compose the three stock factories.
- **Hook** — post-commit subscriber. Side-effect-only (no state writes). Declared `idempotent: true`; loader refuses otherwise.
- **Invariant** — pure function over state, called in-transaction. Violation rolls the tx back.
- **NowToken** — branded ISO timestamp captured once per tick, persisted, replayed.

Full vocabulary in [WHITEPAPER.md](WHITEPAPER.md) §4.

## Design highlights

- **Atomicity, not coordination.** A single `StateBackend.withTransaction` per kernel call eliminates state-sync between the orchestrator and the disk. No reconciliation loop, no observer pattern.
- **Replay-deterministic FSM.** Same `(state, NowToken, ledger)` → same trajectory. Crash recovery is "restart and let the ledger dedup."
- **Honest autonomy.** A bundle that wants `"auto"` on the `final` gate must ship deterministic safety-floor invariants (lint-clean, tests-pass, typecheck-clean). Bundle-loader refuses otherwise. Acceptance verdicts from an LLM are not a safety boundary.
- **No vendor strings in the kernel.** Enforced by CI grep. `@loom/kernel` contains no provider names, transport names, or model names.
- **Operator-debuggable.** Open the SQLite file. Tail the audit log. Inspect with `loom state --format=json | jq`. The runtime does not hide.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| v1.0 | Kernel + `code` bundle + 3 providers + mcp-server/cli; one task per project | In progress |
| v1.1 | Bundle runtime isolation (worker fence), memory subsystem, daemon transport, second bundle | Deferred — additive |
| v1.2 | Third-party bundle marketplace + signed manifests + observability backends | Deferred |

## Contributing

- One package per session (K1-K19 ordering enforced).
- Spec changes ship as `[spec]`-prefixed commits, separate from `[K<n>]` code commits.
- Tests green before declaring DONE. `pnpm -r test` and `pnpm -r typecheck` are the floor.
- No "tests later." Each package ships with the tests it claims.

## License

Apache 2.0 — see [LICENSE](LICENSE). Permissive with an explicit patent grant.

## Further reading

- [WHITEPAPER.md](WHITEPAPER.md) — the design, in prose. ~12 KB. Read this before opening a PR.
