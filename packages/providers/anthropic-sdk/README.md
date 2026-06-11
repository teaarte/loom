# @loomfsm/provider-anthropic-sdk

Direct Anthropic API provider for loom: runs decision agents through the Anthropic SDK with
prompt caching and idempotent spawn support. Configure it once
(`loom secrets set ANTHROPIC_API_KEY …`, `loom models set <agent> anthropic:<model>`), and
every project inherits it. Installed on demand — the base `@loomfsm/pipeline` stays lean.

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
