# Loom — Whitepaper

> A substrate for multi-agent LLM workflows. Atomic state. Replay-deterministic FSM. Policy-as-function autonomy.

## Abstract

Most LLM "agent frameworks" are inversion-of-control libraries built around prompt templates and a string-typed event bus. They scale until the first time something needs to be re-run after a crash, or a human needs to look at a multi-step trajectory and ask "why did the model decide that, then." This document describes a different shape: a small, generic FSM kernel that holds the authoritative state of a workflow in atomic transactions, treats LLM providers as a replaceable plugin axis, and decides autonomy via policy functions over state — not via mode flags or "autonomous: true" booleans. Domain knowledge lives in *bundles*, not in the kernel. The kernel does not know what "code review" or "research" is; it knows how to advance, fan out, gate, step, and finalize.

The system is designed for a single in-flight task per project. That constraint is load-bearing: it eliminates a class of concurrency questions that other agent runtimes inherit by accident, and it turns the kernel into something an operator can debug with `sqlite3 state.db`.

The name **Loom** reflects the design. State is the **warp** — structural threads that hold across crashes. Agents are the **weft** — passed through by the FSM, one pick at a time. Providers are the **shuttle** — `claude-code-shuttle` was already in the codebase when the metaphor crystallised; it fits the role too cleanly to call accidental. Each FSM tick is one *pick* of the loom: a complete pass of the shuttle, committed atomically.

## 1. The problem

Three observations motivate the design.

**LLM outputs are non-deterministic; the substrate must be deterministic.** If both the model and the orchestrator are stochastic, you cannot reason about why a workflow ended where it did. The substrate must be the part that holds still.

**Multi-agent workflows accrete state that outlives any single LLM call.** Phases, findings, gate decisions, agent verdicts, idempotency markers — these are first-class data, not stuff to keep in memory. If state lives in the orchestrator's heap, a crash erases the trajectory and the next run does double work or, worse, conflicting work.

**"Autonomous" is a policy, not a mode.** A mode flag like `autonomous: true` is a lie at scale: it forces the kernel to either ask humans about everything or ask humans about nothing. Real autonomy is per-gate, per-role, decided by data the substrate already holds. The decision is a function `(state, role, context) → decision` — and the kernel only knows *when* to ask via policy composition; the *what to auto-decide* belongs to the bundle.

## 2. Thesis — eight principles

The kernel commits to eight constraints, every one of them enforced by code or by a CI grep:

1. **Generic kernel.** No domain vocabulary in `@loomfsm/kernel`. No agent names, no phase names, no review semantics. The kernel runs *some* FSM over *some* bundle; the bundle names the world.
2. **Schemas at every IO boundary.** State, manifests, bundle outputs, MCP tool args — all validated against JSON Schema (Ajv) at every read/write boundary. No "trust the caller."
3. **Invariants over conventions.** Architectural rules are encoded as `Invariant` functions called inside the commit transaction. A violation rolls the transaction back. The 13 kernel invariants split into one schema-meta, nine state-shape, and three ledger-consistency rules.
4. **Code-and-LLM hybrid as methodology, not contract.** Classification = LLM-tool. Deterministic derivation = code. The substrate does not blur the line.
5. **Provider-agnostic.** `LLMProvider` is a plugin. The kernel never imports `@anthropic-ai/sdk` or `openai`; provider lookup is by capability, not by string-name.
6. **Atomic state mutations.** All writes go through `StateBackend.withTransaction`. Either the entire effect of a tick lands in SQLite + the idempotency ledger + the audit log in one commit, or none of it does. State-sync between an in-memory view and the disk view is structurally impossible.
7. **Gates are policy.** The map `gate_policies: Record<GateRole, PolicyName>` *is* the contract. The kernel does not switch on policy names. Adding a new policy is a new factory file + one map entry.
8. **Bundles via manifest.** Bundles declare their capabilities, vocabulary extensions, DDL allowlist, prompt directory, and provider defaults in a manifest. The bundle-loader fails loud at startup, not at first spawn.

The principles are constraints, not aspirations. Each one is paired with a way to falsify it. `grep -rEi "anthropic|openai" packages/kernel/` returns zero matches, or principle 5 is broken.

## 3. Architecture — kernel + three plug axes

```
┌─────────────────────────────────────────────────────────────┐
│                  Transports                                 │
│  (mcp-server · cli · daemon — orthogonal wire shapes)       │
└──────────────────┬──────────────────────────────────────────┘
                   │  KernelDirective ⇄ TransportResponse
                   ▼
┌─────────────────────────────────────────────────────────────┐
│                Kernel  (@loomfsm/kernel)                       │
│                                                             │
│   runFSM ── Stage interpreter (5 variants)                  │
│        ├── StateBackend.withTransaction (atomic)            │
│        ├── HookRunner (post-commit subscribers)             │
│        ├── Idempotency ledger (replay dedup)                │
│        ├── Invariants (in-tx assertions)                    │
│        ├── Gate-policy dispatcher (policy-as-function)      │
│        ├── NowToken (replay-deterministic clock)            │
│        └── Audit log (append-only, in-tx)                   │
└──────┬─────────────────────────────┬────────────────────────┘
       │                             │
       ▼                             ▼
┌──────────────────────┐      ┌──────────────────────────────┐
│      Bundles         │      │       LLM Providers          │
│  (domain knowledge)  │      │   (anthropic-sdk · openai ·  │
│  agents · phases ·   │      │    claude-code-shuttle · …)  │
│  hooks · invariants  │      │   capability-driven lookup   │
│  policy resolver     │      └──────────────────────────────┘
└──────────────────────┘
```

The three plug axes — **Bundles**, **Providers**, **Transports** — are orthogonal. Any (transport × provider × bundle) combination is valid at the kernel boundary. The v1 MVP ships one bundle (code review), three providers (claude-code-shuttle, anthropic-sdk, openrouter), and two transports (mcp-server, cli; daemon planned).

## 4. Core primitives

### `Stage` discriminated union

Five variants — `SpawnStage`, `FanoutStage`, `GateStage`, `StepStage`, `FinalizeStage` — over which a ~250 LOC interpreter performs an exhaustive switch. Every flow in every bundle is a sequence of these. There is no sixth kind escape hatch. New behavior is built by composing the five, not by extending the kernel.

### `Policy = (state, role, ctx) → Decision`

The smallest correct shape for an autonomy decision. The kernel hands the policy a bundle-scoped view of state, the gate role, and a context object; the policy returns `human-required`, `auto-approve`, or `auto-reject`. Three factories ship: `human`, `on-blockers`, `auto`. Bundles register additional factories via `Bundle.policy_factories`. The kernel does not switch on policy names; the map IS the contract.

### `StateBackend.withTransaction(now, fn)`

One verb. One law: atomicity. The default backend is SQLite WAL with `BEGIN IMMEDIATE`. Alternative backends (in-memory, libSQL, replicated) implement the same single interface. State mutation outside a transaction is a typing error — `tx` is the only handle that exposes writes.

### `NowToken`

A branded ISO-8601 string, captured once per tick, persisted in the idempotency ledger and the audit log. Replay reads the persisted token instead of calling `Date.now()`. The kernel's clock is data, not a syscall. Lint enforces: `grep -rE "Date\.now\(\)|new Date\(\)" packages/kernel/src/` returns zero matches. (Caveat: this gives replay *semantic* equivalence, not byte-equality — Ajv error ordering, Map iteration, and `JSON.stringify(Set)` are still hostile to bit-identical comparison.)

### Idempotency ledger

A SQLite table co-committed with every state-changing operation. Each row keys an operation that crossed a system boundary (agent result delivery, user answer, provider call, side-effect hook, MCP tool call). Duplicate delivery returns the persisted response verbatim with `error_class: "duplicate-delivery-replayed"`. Transport-level retries are safe by construction. The ledger is the load-bearing answer to "what happens when the kernel crashes mid-tick" — replay reads the marker and refuses to do work twice.

### Invariants

Pure functions over state, called inside `runInvariants(tx)` at exactly three sites: every commit, every finalize, and every `--validate` run. A violation rolls back the transaction. Invariants declare their `reads` so the runtime can skip them when no relevant state changed. 13 kernel invariants are kernel-generic; bundles contribute their own (`INV_<BUNDLE>_<n>`, starting at 101 to avoid collision).

## 5. What this design gets close to right

**Idempotency discipline.** Every state-changing operation has a structured key. The ledger is co-committed. Crash matrices for the hot delivery path and the shuttle wire-emit are enumerated. A kernel that crashes mid-stage and restarts knows what to do — modulo a handful of edge cases at the MCP-tool-call and schema-migration seams that are documented honestly.

**Acceptance is not a safety boundary.** The substrate refuses to treat LLM-judged "acceptance" as the only line between FSM and "shipped." A bundle that sets any role to `"auto"` must ship deterministic safety-floor invariants (lint-clean, tests-pass, typecheck-clean for the code bundle); bundle-loader refuses otherwise. This is the difference between *honest autonomy* and *theatre*.

**No vendor strings in the kernel.** Provider names, transport names, and model names do not appear in `@loomfsm/kernel`. The CI grep enforces this. Swapping `anthropic-sdk` for `openrouter` is a config edit; swapping the kernel's idea of what a provider *is* — not a change a user can make, and that's the point.

**State is observable.** Operators inspect with `sqlite3 state.db`. The wiki is also the operator's runbook. There is no proprietary state format; there is no telemetry pipeline you need to stand up before you can debug.

## 6. What this design deliberately doesn't ship in v1.0

Scope honesty matters more than feature counting. The following are intentionally out of this release — additive, planned for later:

- **Bundle runtime isolation (worker-thread fence).** v1 MVP runs bundles in-process under curated trust. Manifest declares capabilities; the bundle-loader checks them at load. The *runtime* fence (separate worker, RPC marshalling of `BundleOp[]`) lands when the third-party marketplace lands. The MVP threat model has zero third-party bundles.
- **Memory subsystem.** Cross-task and cross-project memory is a deferred plugin. Substrate reserves the capability vocabulary and the `memory_query` MCP tool slot.
- **Daemon-mode transport.** The transport interface accommodates it; the daemon binary is planned. Single-process CLI + MCP-server are the current surface.
- **Multi-bundle parallelism in one project directory.** v1 enforces one bundle per project. The architecture admits more; the substrate doesn't ship the orchestration for it.
- **Observability backends beyond local logs and `/metrics`.** OTel attributes are declared but the production-grade collector wiring is planned.

The substrate is *additive* to all of these. None requires re-shaping the kernel. That property is what most of the architectural rigour is paying for.

## 7. Honest scope and timeline

- **Kernel size**: ~12-15k LOC, before the bundle.
- **Bundle authoring**: a new bundle is a focused, self-contained effort given the substrate — agents, flows, and invariants as data, no kernel changes.
- **Validation**: the `code` bundle has driven real `/task` runs end to end through an MCP host to `complete:accepted`, with the audit log recording every spawn, finding, verdict, and gate.

The kernel is not "production-ready" because of architectural elegance; it is production-ready because it is exercised on real work and the audit log lets an operator see what happened. Architectural elegance is the precondition, not the proof.

## 8. License and authorship

Solo-authored. Licensed under Apache 2.0 (see [LICENSE](LICENSE)) — permissive, with an explicit patent grant suited to the AI/LLM space. Contributions welcome via PR with conventional-commit subjects.

---

*Whitepaper version 1.0 · status: `v0.1.0`, published to npm under `@loomfsm/*`.*
