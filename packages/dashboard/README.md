# @loomfsm/dashboard

loom's web control plane: a React SPA served as prebuilt static assets by
[`@loomfsm/server`](https://www.npmjs.com/package/@loomfsm/server). `loom up` opens it at
`http://127.0.0.1:4317` with a first-run wizard.

## What you can do from it

- Browse the fleet's live status; add projects with an in-app folder picker.
- Submit tasks with policy, complexity, Docker isolation, and push/merge-on-accept options.
- Answer gates reading the exact spawn output you're approving; tail a live log over SSE.
- Inspect the agent chain — model, tokens, duration, findings, verdicts — for live and
  archived tasks.
- Edit the configure-once layer (config, masked secrets, model map, provider keys) through
  schema-generated forms.

The package ships only `dist/` — React and the UI toolkit are build-time dependencies, so
nothing heavy lands in your install tree.

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
