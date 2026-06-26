# @loomfsm/repo-memory

Persistent, model-agnostic structural memory of a code repository. It maintains a plain-markdown
**repo brief** — key types, public API, layout, and stack, each with a `file:line` anchor — so a
planning agent cites structure from the brief instead of cold-reading the whole tree on every run.
The brief persists across runs under loom's footprint and delta-refreshes cheaply, so the second
task on the same project starts from a warm map rather than re-deriving it.

## What's inside

- **`ensureBrief(projectDir)`** — builds or delta-refreshes the brief at
  `.loom/memory/<hash>/repo-brief.md`. Lists tracked files, content-hashes them, and re-extracts
  **only the files that changed** (a content-hash cache carries the rest verbatim); an unchanged
  tree is reused byte-for-byte. Degrades to a no-op (never throws) on a non-git project, a repo
  past the size cap, or any error — a stale brief can only cost tokens, never correctness.
- **Importance ranking** — the brief orders files by module in-degree (how many other files
  import them), then public-surface size, fitting the highest-signal contracts into a token
  budget instead of dumping the tree.
- **Cross-model by construction** — the output is plain markdown and JSON. Any model or backend
  consumes it identically; a cheap pass can author what an expensive planner reads.

It is **ambient**: no clock or replay state is threaded through it, so it lives entirely outside
loom's deterministic kernel — which never depends on this package.

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
