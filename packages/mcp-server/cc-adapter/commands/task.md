---
mcp_protocol_required: "^3.0"
---

# /task — start or drive a pipeline task

<!--
  This file is a dumb router. It does no flag parsing, no output
  interpretation, no file accounting, and knows zero gate vocabulary: every
  semantic decision (which preset a flag maps to, what a gate's answers are,
  how to recover, what files a spawn changed) lives server-side. That is why
  adding a new preset, gate role, or bundle never edits this file — the
  server ships the schema, the router renders it.

  `loom` below is the alias this MCP server is registered under in the
  host's MCP config; if you registered it under a different name, swap the
  `mcp__loom__` prefix to match. No other host detail is assumed.
-->

Call `mcp__loom__pipeline_run_task({ project_dir: <cwd>, task: "$ARGUMENTS", client_idempotency_uuid: <one crypto.randomUUID() bound to this invocation; reuse it verbatim on any transport-retry>, client_capabilities: { honors_shuttle: true } })`. Pass `$ARGUMENTS` exactly as typed — the server parses any leading flag.

Then loop on the returned response's `status`:

- **`spawn-agent`** → run the spawn with the Task tool using `spawn_request.{description, prompt, model}` (plus `subagent_type` from `spawn_request.extras` when present). Deliver the result back: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "agent-result", agent_run_id, agent_output } })`. You do **not** gather changed files: for a git project the server computes the delta itself — diffing the working tree against the ref it captured when the task started, so committed *and* uncommitted edits are both accounted for. You MAY still pass `files_modified` / `files_created` (arrays of relative paths) when you have an authoritative source the server cannot reach (for example a non-git project); the server unions whatever you send with what it computes, so reporting is idempotent and an empty or absent contribution is a no-op.
- **`spawn-agents-parallel`** → run every entry in `spawns` the same way. When the response has `prompts_by_reference: true`, each `spawn_request` omits `prompt` — fetch it per entry with `mcp__loom__pipeline_get_spawn_prompt({ project_dir, driver_state_id, agent_run_id })` and use the returned `prompt` (still take `description` / `model` / `extras` from the entry's `spawn_request`). Then deliver all results together: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "agents-results", results: [{ agent_run_id, agent_output }, …] } })`.
- **`ask-user`** → show `message` and `valid_answers` to the user **verbatim** (the schema names exactly which replies are accepted and what each produces — do not invent or filter options). Deliver their choice: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "user-answer", gate_event_id, … } })` with the fields the chosen option declares.
- **`complete`** → display `summary`, suggest `/done`, and stop.
- **`error`** → display `message` and `recovery_options` verbatim, then call `mcp__loom__pipeline_recover({ project_dir, driver_state_id, choice })` with the option the user picks (passing `agent_run_ids` when that option lists them).

After any `pipeline_continue_task` or `pipeline_recover`, loop again on the new response's `status`. Never edit the state DB by hand — `pipeline_recover` is the only repair path.

## Gate modes — when the pipeline pauses for a human

By default the pipeline pauses for a human only at a **real** decision: a gate where there is still an open blocking finding (e.g. a reviewer raised something that must be resolved). Clean gates resolve on their own, so a routine task runs end to end without a rubber-stamp prompt — every `ask-user` you see is a genuine choice, not a formality.

A user can change that posture for a single task by prefixing the task with one leading policy flag — conceptually: **stop at every gate** (review each step), **stop only before finishing**, or **run fully unattended**. Either way, pass `$ARGUMENTS` through to `pipeline_run_task` exactly as typed: the server parses the leading flag and resolves the posture; this router never interprets it. The exact flag strings are advertised by `mcp__loom__pipeline_meta({ project_dir })` under `flag_vocabulary` (the authoritative, drift-free list) — surface them to the user if they ask which modes exist.
