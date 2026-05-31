---
mcp_protocol_required: "^3.0"
---

# /task — start or drive a pipeline task

<!--
  This file is a dumb router. It does no flag parsing, no output
  interpretation, and knows zero gate vocabulary: every semantic decision
  (which preset a flag maps to, what a gate's answers are, how to recover)
  lives server-side. That is why adding a new preset, gate role, or bundle
  never edits this file — the server ships the schema, the router renders it.

  `loom` below is the alias this MCP server is registered under in the
  host's MCP config; if you registered it under a different name, swap the
  `mcp__loom__` prefix to match. No other host detail is assumed.
-->

Call `mcp__loom__pipeline_run_task({ project_dir: <cwd>, task: "$ARGUMENTS", client_idempotency_uuid: <one crypto.randomUUID() bound to this invocation; reuse it verbatim on any transport-retry>, client_capabilities: { honors_shuttle: true } })`. Pass `$ARGUMENTS` exactly as typed — the server parses any leading flag.

Then loop on the returned response's `status`:

- **`spawn-agent`** → run the spawn with the Task tool using `spawn_request.{description, prompt, model}` (plus `subagent_type` from `spawn_request.extras` when present). Deliver the result back: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "agent-result", agent_run_id, agent_output, files_modified, files_created } })`. For `files_modified` / `files_created`: if `project_dir` is a git working tree, gather them after the spawn returns — `files_modified` from `git -C <project_dir> diff --name-only HEAD` and `files_created` from `git -C <project_dir> ls-files --others --exclude-standard` (both relative paths). The server unions them, so reporting the full current set on every delivery is correct and idempotent; a spawn that changed nothing contributes nothing. Omit both fields when the project is not a git repo.
- **`spawn-agents-parallel`** → run every entry in `spawns` the same way. When the response has `prompts_by_reference: true`, each `spawn_request` omits `prompt` — fetch it per entry with `mcp__loom__pipeline_get_spawn_prompt({ project_dir, driver_state_id, agent_run_id })` and use the returned `prompt` (still take `description` / `model` / `extras` from the entry's `spawn_request`). Then deliver all results together: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "agents-results", results: [{ agent_run_id, agent_output }, …] } })`. (A parallel batch is review-only; gather file accounting on the single-spawn deliveries above, where the working tree actually changes.)
- **`ask-user`** → show `message` and `valid_answers` to the user **verbatim** (the schema names exactly which replies are accepted and what each produces — do not invent or filter options). Deliver their choice: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "user-answer", gate_event_id, … } })` with the fields the chosen option declares.
- **`complete`** → display `summary`, suggest `/done`, and stop.
- **`error`** → display `message` and `recovery_options` verbatim, then call `mcp__loom__pipeline_recover({ project_dir, driver_state_id, choice })` with the option the user picks (passing `agent_run_ids` when that option lists them).

After any `pipeline_continue_task` or `pipeline_recover`, loop again on the new response's `status`. Never edit the state DB by hand — `pipeline_recover` is the only repair path.
