<div align="center">

# 🧵 loom

**Durable, auditable orchestration for LLM agents.**

Multi-step agent work — code review, implementation, any review-gated task — driven as a
replay-deterministic state machine, with human approval gates and safety guarantees
enforced at commit time, not hoped for from the model.

Run it **interactively** inside your agent host, **headless** as a one-shot command, or
as a **self-driving daemon** that parks on your gates and wakes when you answer.

[![npm](https://img.shields.io/npm/v/@loomfsm/pipeline.svg?logo=npm&label=%40loomfsm%2Fpipeline&color=cb3837)](https://www.npmjs.com/package/@loomfsm/pipeline)
[![license](https://img.shields.io/badge/license-Apache--2.0-3da639.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933.svg?logo=node.js&logoColor=white)](.nvmrc)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg?logo=typescript&logoColor=white)](#)

[Quickstart](#quickstart) · [How you run it](#how-you-run-it) · [Why loom](#why-loom) · [What you can build](#what-you-can-build) · [How it works](#how-it-works) · [Whitepaper](WHITEPAPER.md)

</div>

---

## The one-minute version

You hand loom a task. It drives a sequence of LLM agents through phases — roughly
**classify → plan → implement → review → validate → finalize** — committing every step
atomically to a local SQLite database. Humans approve at the gates that matter. The
whole run is recorded and replayable, and a set of invariants makes certain failures
*structurally impossible*: an agent can't sign off while a blocking issue is open, or
rewrite the tests it's being judged by and self-approve.

```mermaid
flowchart LR
    C([classify]) --> P([plan]) --> I([implement]) --> R([review]) --> V([validate]) --> F([finalize])
```

*You approve at the gates — after **classify**, after **plan**, and before **finalize** —
or hand the dial to `on-blockers` / full `auto`. Every step commits atomically to SQLite
and is replayable.*

Think **"Temporal for LLM agents"** — but with human-in-the-loop, structured review,
and provable safety as first-class primitives, not bolted on.

The same engine runs three ways: type `/task …` inside your agent host (e.g. Claude
Code), fire a one-shot `loom run "…"` from a terminal, or leave a `loom daemon` running
that drives work server-side and only surfaces you at decision points.

> The name reflects the design: state is the **warp**, agents are the **weft**,
> providers are the **shuttle**. One state-machine tick = one pick of the loom,
> committed atomically.

## Quickstart

```bash
npm i -g @loomfsm/pipeline
```

Register it with your agent host and authorize a project (one-time):

```bash
loom setup            # writes the MCP server config + installs the /task, /done, /resume commands
loom allowlist add    # authorize the current project (run once per project)
```

Then pick how you want to run it (next section). The fastest path — inside your MCP host
(e.g. Claude Code), in that project:

```
/task add rate limiting to the login endpoint
```

State lives at `<project>/.claude/state.db` — a plain SQLite file you own. Setup is
idempotent: re-running changes nothing and never overwrites a command you've edited. The
allowlist is default-deny and operator-authored — the server never enrolls a project on
its own.

## How you run it

Every mode drives the **identical** state machine, gates, and invariants. They differ
only in *who executes each step* and *how long it waits for you*.

### 1 · Interactive — inside your agent host

The zero-setup path: your host (Claude Code) executes each agent step, and loom surfaces
each gate inline for your decision.

```
/task add rate limiting to the login endpoint   # start a task
/resume                                          # re-attach to a task that was interrupted
/done                                            # show the result + clear the slot
```

No API key, no network setup — it runs through the host you already use.

### 2 · Headless one-shot — `loom run`

Drive a task to the end from a terminal, no live host:

```bash
loom run "add rate limiting to the login endpoint"
```

Each step runs through the Claude Code CLI (`claude -p`) in an **isolated git worktree**,
on your existing Claude Code login — your subscription, **no API key**. A genuine human
gate **pauses** and is printed for you to answer (`/resume` in the host); otherwise it
runs straight to a verdict. Your main working tree is never touched.

### 3 · Autonomous daemon — `loom daemon`

A long-lived supervisor over the headless loop — the "set it and check back" mode:

```bash
loom daemon start "migrate the auth module to the new SDK"
loom daemon status     # is it running? driving / parked at a gate / backing off?
loom daemon stop
```

It runs the work server-side and surfaces you **only at decision points**:

- **parks** on a human gate and **wakes** when you answer it (via `/resume`),
- **retries** transient failures with exponential backoff,
- **recovers** an interrupted task on restart (a slept laptop / killed process just
  resumes — same agent ids, idempotent re-delivery, no double work),
- **commits** finished work to a `loom/<task>` branch — reviewable, **never** auto-merged
  into your checked-out branch.

`--watch` keeps supervising the slot for the next task; `--detach` runs it in the
background.

### CLI reference

```
loom setup [--user|--project] [--dry-run] [--force]   register the MCP server + install /task,/done,/resume
loom allowlist add [path] [--dry-run]                 authorize a project directory (default-deny)
loom allowlist list                                   show authorized directories
loom init [--dry-run]                                 ensure .claude/ + authorize this project

loom run "<task>"                                     drive a task to the end headless (claude -p, isolated worktree)
loom daemon start [--watch] [--detach] ["<task>"]     supervise a project: park/wake, retry, recover, merge-back
loom daemon stop  [path]                              signal a running daemon to stop gracefully
loom daemon status [path]                             show the daemon + where the task sits

loom status  [path]                                   read-only snapshot of the project's task (flags a stalled run)
loom reset   [path] [--force] [--dry-run]             archive a finished task to .claude/history/, free the slot
loom history [path]                                   list this project's archived tasks
loom --help | --version
```

> `loom run` and `loom daemon` need the Claude Code CLI installed and signed in (they run
> on your subscription). The interactive `/task` path does not — it uses your host
> directly. The permission posture defaults to safe (`acceptEdits` — file edits proceed,
> shell stays gated); raise it deliberately with `LOOM_CLAUDE_PERMISSION_MODE`.

## Why loom

**🔁 Replay-deterministic and fully auditable.** State lives in atomic SQLite
transactions with a single timestamp token threaded through every step, so a run is
reproducible bit-for-bit. Every spawn, finding, verdict, and gate is recorded — open
the database and see exactly what happened and why. You can even replay a recorded run
against a *changed* invariant to ask "what if". The audit trail is the product, not an
afterthought.

**🛡️ Safety enforced at commit time, not promised by a prompt.** Invariants run inside
the transaction and roll it back on violation. The `code` bundle ships ones like
*"acceptance cannot pass while a blocking finding is open"* and *"if an agent touched
the test files, the final gate must be human-approved"* — so an autonomous agent can't
quietly rewrite the tests it's judged by and approve itself. Structural guarantees, not
behavioral hopes.

**🎚️ Human-in-the-loop, on a dial.** Gates are a primitive, and a policy decides each
one: `human` (approve every step), `on-blockers` (ask only when there's a real blocker
— the default), or `auto` (full autonomy, backed by a deterministic safety floor that
only wakes up in auto mode). One bundle scales from "approve everything" to "let it
run" — a built-in trust ramp you tighten or loosen as you go.

**🔌 Pluggable by design.** Three orthogonal axes: **bundles** (the domain — agents,
phases, gates, invariants), **providers** (the LLM backend), **transports** (the wire).
Any combination is valid at the kernel boundary. A new domain is a new bundle; the
kernel never changes.

**🚀 Zero-config to start, no lock-in.** The default provider runs through your agent
host — no API key, no network setup. State is plain SQLite you own. The kernel contains
no vendor, model, or transport names (enforced by CI). Apache 2.0.

**💥 Crash-safe.** Same `(state, timestamp, ledger)` → same trajectory. Recovery is
"restart and let the idempotency ledger dedup" — no half-applied steps, no reconciliation
loop. The daemon turns this into a feature: a drop just pauses it, and it resumes on its own.

> **What it guarantees — honestly.** loom guarantees the *process*: the declared review
> ran, nothing was bypassed, irreversible steps got a human. It does **not** guarantee
> the model's *output* is correct — that's the agents' job. What you get is the ability
> to *prove* which process ran and to *see* every decision behind a result.

## What you can build

loom is for **high-stakes, multi-step, review-gated work where being wrong is
expensive** — not throwaway one-shot prompts. The shipping `code` bundle does
multi-agent code review and implementation; the same substrate fits any domain where
process, review, and audit matter:

- **Code review & implementation** *(ships today)* — plan-grounding checks, an
  adversarial reviewer panel, a final human gate.
- **Regulated / compliance work** (finance, KYC, records) — the replayable audit trail
  and enforced gates are the deliverable.
- **Legal / clause review** — draft → per-clause fanout → compliance invariant → human gate.
- **Incident runbooks** — deterministic stages with human gates on irreversible actions.
- **Content & publishing** — draft → fact-check → style → legal → publish gate.
- **Data migrations** — discover → transform in isolation → verify gate.

A new domain is a new bundle (agents + flows + invariants, authored as data). The kernel
doesn't change.

## How it works

The kernel is generic — it knows nothing about code review or any domain. Three
orthogonal axes plug into it: **bundles** (the domain), **providers** (the LLM backend),
and **transports** (the wire). Any combination is valid.

```mermaid
flowchart TB
    T["🔌 Transports — the wire<br/>mcp-server · cli · daemon"]
    K["⚙️ @loomfsm/kernel<br/>generic FSM · atomic state · invariants · policy · audit"]
    B["📦 Bundles — the domain<br/>code · …your own"]
    P["🧠 Providers — the LLM backend<br/>shuttle · anthropic · openrouter"]
    T -->|"directive ⇄ response"| K
    K --> B
    K --> P
```

A second runtime, `@loomfsm/driver`, holds the transport-neutral orchestration loop
(`drive()`) that both `loom run` and `loom daemon` wrap — so the directive contract is
implemented once and every transport behaves identically.

And the core vocabulary:

- **Stage** — one of five variants (`SpawnStage`, `FanoutStage`, `GateStage`,
  `StepStage`, `FinalizeStage`). A bundle's `flows` map names sequences of stages.
- **Gate** — a checkpoint whose outcome a **Policy** decides. Roles: `classify`, `plan`,
  `final` (kernel-recognized; bundles add more).
- **Policy** — a function `(state, role, ctx) → Decision`. The kernel never switches on
  policy names; the function *is* the contract. Stock factories: `human`, `on-blockers`,
  `auto`.
- **Invariant** — a pure function over state, called in-transaction; a violation rolls
  the transaction back. Kernel-generic ones plus bundle-declared safety rules.
- **Provider** — the LLM backend, chosen by *capability*, not name. Per-agent / per-phase
  routing.

Full design rationale in [WHITEPAPER.md](WHITEPAPER.md).

## At a glance

| | |
|---|---|
| Language | TypeScript (Node 22+, pnpm workspaces) |
| State | SQLite (WAL, `BEGIN IMMEDIATE`), atomic per kernel call |
| Determinism | Replay-deterministic via a persisted timestamp token |
| Idempotency | Co-committed ledger keyed per boundary-crossing op |
| Autonomy | `Policy = (state, role, ctx) → Decision` — three stock factories |
| Default policy | `on-blockers` — asks a human only when a blocking finding exists |
| Concurrency | One task in flight per project; finished tasks archive to `.claude/history/` |
| Providers | `claude-code-shuttle` (zero-config, published); `anthropic-sdk` + `openrouter` ship in the repo |
| Transports | `mcp-server` (stdio), `cli`, and the local-process `daemon`; HTTP transport planned |
| License | Apache 2.0 |

## Repository layout

```
packages/
  kernel/                  FSM, invariants, ledger, gate-policy, types — no vendor names
  driver/                  transport-neutral orchestration runtime — the headless drive() loop + Executor seam
  daemon/                  long-lived supervisor over drive() — park/wake, retry, recovery, worktree merge-back
  mcp-server/              MCP transport (stdio); the /task, /done, /resume commands
  cli/                     the `loom` binary (setup / allowlist / init / status / reset / run / daemon)
  pipeline/                @loomfsm/pipeline — the one-step `npm i -g` meta-package
  providers/
    claude-code-shuttle/   default provider, no API key needed (published)
    anthropic-sdk/         direct Anthropic with prompt-caching + idempotent spawn (in-repo)
    openrouter/            multi-model routing (in-repo)
  bundles/
    code/                  the code-review / implementation bundle
```

Published under the `@loomfsm/*` scope: install **`@loomfsm/pipeline`**, which pulls
`@loomfsm/{kernel, driver, daemon, mcp-server, cli, bundle-code, provider-claude-code-shuttle}`
(plus `transport-types`). The `anthropic-sdk` and `openrouter` providers live in the repo
and build from source.

## What it isn't

- Not a prompt-template framework — templates live in bundles, typed and validated.
- Not an agent IDE — it runs underneath your IDE / shell / MCP host.
- Not a distributed runtime — single in-flight task per project, by design.
- Not "AGI plumbing" — a finite-state machine that survives crashes and tells you what happened.

## Status & roadmap

`v0.2.0` (current): headless, non-interactive execution. `loom run` drives a task to the
end without a live host; `loom daemon` wraps it in a long-lived supervisor that parks on
human gates and wakes on your answer, retries, recovers on restart, and commits finished
work to a `loom/<task>` branch. The code-domain toolchain moved out of the kernel, so the
substrate stays domain-blind. On the near horizon: **task intake** (pull work from an
issue tracker or a chat, submit from anywhere), **multi-project supervision**, and an
**HTTP transport** — all *additive* over the same driver; none reshapes the kernel.

`v0.1.x`: the interactive foundation — kernel + the `code` bundle + mcp-server & cli;
one task in flight per project, archived to `.claude/history/` on finish; safe resume of
an interrupted task; an honest finding lifecycle (a settled blocker can't haunt an
accepted task); a generic conditional-verify primitive a bundle uses to escalate to an
empirical check before finalizing. Early and evolving.

## Contributing

- `pnpm -r typecheck` and `pnpm -r test` must be green before a change is done — the floor.
