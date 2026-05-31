# loom

> A small, generic FSM kernel for multi-agent LLM workflows. Atomic state. Replay-deterministic. Policy-as-function autonomy. SQLite-backed. No framework, no inversion of control.

**Status:** `v0.1.0`, published to npm under `@loomfsm/*`. The `code` bundle runs end to end through an MCP host — classify → plan → implement → review → finalize, with human gates and replay-deterministic state. Early and evolving; one bundle today. See [WHITEPAPER.md](WHITEPAPER.md) for the design.

---

## What it is

A kernel that holds the authoritative state of a multi-agent workflow in atomic SQLite transactions, drives it via a five-variant `Stage` discriminated union, and decides autonomy via policy functions — not mode flags. Domain knowledge (agents, phases, gate semantics, finding categories) lives in **bundles**, not in the kernel. The v1 MVP ships one bundle: `code` — multi-agent code-review and implementation pipeline.

The kernel exposes three plug axes:

- **Bundles** — domain. The `code` bundle ships first. Other domains (research, VFX, ops) are additive.
- **Providers** — LLM backend. `claude-code-shuttle`, `anthropic-sdk`, `openrouter`. Capability-driven, not name-driven.
- **Transports** — wire shape. `mcp-server`, `cli`, daemon (planned).

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
| Threat model (v1) | Curated trust: no third-party bundles; runtime isolation is planned. |
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

npm packages are published under the `@loomfsm/*` scope: `@loomfsm/kernel`, `@loomfsm/mcp-server`, `@loomfsm/cli`, `@loomfsm/provider-anthropic-sdk`, `@loomfsm/provider-claude-code-shuttle`, `@loomfsm/provider-openrouter`, `@loomfsm/bundle-code`.

## Getting started

Install the CLI and the runtime in one step:

```bash
npm i -g @loomfsm/pipeline
```

Register it with your agent host — this writes the MCP server config and installs the
`/task` and `/done` commands — then authorize a project:

```bash
loom setup            # idempotent; --user (default) or --project; --dry-run to preview
loom allowlist add    # authorize the current project (run once per project)
```

Then, from your MCP host (e.g. Claude Code), inside an authorized project:

```
/task fix the typo in the module header comment
```

The host runs each spawned agent with the prompt the server provides, surfaces every
approval gate for your decision, and drives the work to completion; `/done` shows the
summary. State lives in `<project>/.claude/state.db` — a plain SQLite file.

### CLI commands

```
loom setup [--user|--project] [--dry-run] [--force]   register the server + install /task,/done
loom allowlist add [path] [--dry-run]                 authorize a project directory
loom allowlist list                                   show authorized directories
loom init [--dry-run]                                 ensure .claude/ + authorize the current project
loom --help | --version
```

Setup is idempotent: re-running changes nothing and never overwrites a command you have
edited (`--force` to override). The allowlist is default-deny and operator-authored — the
server never enrolls a project on its own.

Working from source instead? `pnpm install && pnpm -r build`, then run
`packages/cli/dist/src/bin/loom.js` (or `pnpm --filter @loomfsm/cli exec pnpm link --global`).

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
- **No vendor strings in the kernel.** Enforced by CI grep. `@loomfsm/kernel` contains no provider names, transport names, or model names.
- **Operator-debuggable.** The state is a plain SQLite file — open it, tail the audit log, query it with `sqlite3` / `jq`. The runtime does not hide.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| Now | Kernel + `code` bundle + 3 providers + mcp-server/cli; one task per project | Shipping (`v0.1.0` on npm) |
| Planned | Bundle runtime isolation (worker fence), memory subsystem, daemon transport, more bundles | — |
| Later | Third-party bundle marketplace + signed manifests + observability backends | — |

## Contributing

- `pnpm -r typecheck` and `pnpm -r test` must be green before a change is done — that's the floor.
- Tests ship with the code they cover. No "tests later."
- Conventional-commit subjects (`feat:` / `fix:` / `chore:` / `refactor:` / `docs:`).
- The kernel carries no provider, transport, or model names — a CI grep enforces it.

## License

Apache 2.0 — see [LICENSE](LICENSE). Permissive with an explicit patent grant.

## Further reading

- [WHITEPAPER.md](WHITEPAPER.md) — the design, in prose. ~12 KB. Read this before opening a PR.
