# @loomfsm/loader

loom's build-time assembly layer. The loader discovers bundles, providers, and extensions,
validates them against the kernel's plugin contracts, and assembles the registry the runtime
boots from — so the kernel never performs dynamic discovery at tick time.

## What's inside

- **Bundle loading** — manifest validation with specific failure codes; a static import-scope
  check refuses bundles that reach past the plugin contract.
- **Extension reconciliation** — fail-soft: a broken extension records a `failed` row with an
  audit entry instead of taking the runtime down.
- **Provider routing** — builds the per-agent dispatch table from the config's model map.

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
