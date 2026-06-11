# @loomfsm/bundle-code

The code-review / implementation bundle — loom's first domain plugin. It declares the
phases (**classify → plan → implement → review → validate → finalize**), the agents and
their typed prompts, the gates, and the commit-time safety invariants for review-gated
coding work.

## Shipped invariants include

- *Acceptance can't pass while a blocking finding is open* — a reviewer blocker structurally
  blocks the verdict until resolved or human-overridden.
- *If an agent modified the tests it's judged by, the final gate must be human-approved* —
  file accounting is read from the ledger, not from the agent's claims.

The bundle uses only the kernel's plugin contract — the kernel itself knows nothing about
code. A new domain is a new bundle: [how bundles plug in](https://loomfsm.dev/why/).

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
