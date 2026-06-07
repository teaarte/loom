---
mcp_protocol_required: "^3.0"
---

# /proceed — re-attach to a paused task

<!--
  A dumb router, like /task. Use it when a task's loop stopped without the
  task finishing — a dropped socket, a slept laptop, a crashed turn — and
  you want to pick it back up. The task's state is intact server-side; this
  command asks the server for the directive the task is currently paused on
  and drives the SAME loop /task does.

  It performs no mutation of its own. The re-emitted directive carries the
  task's EXISTING agent_run_ids, so if a result was already delivered before
  the drop, delivering it again is deduped by the server — re-attaching is
  always safe to repeat.

  `loom` below is the alias this MCP server is registered under in the
  host's MCP config; swap the `mcp__loom__` prefix if you registered it
  under a different name.
-->

Call `mcp__loom__pipeline_resume({ project_dir: <cwd> })` to fetch the directive the paused task is waiting on. Then loop on the returned response's `status` — the same loop `/task` runs:

- **`spawn-agent`** → a resumed pending spawn's inline `spawn_request.prompt` is a placeholder, **not** the real prompt, so always fetch the authoritative prompt with `mcp__loom__pipeline_get_spawn_prompt({ project_dir, driver_state_id, agent_run_id })` and run the spawn with that `prompt` (take `description` / `model` / `extras` from the entry's `spawn_request`). Deliver the result with the **same** `agent_run_id`: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "agent-result", agent_run_id, agent_output } })`.
- **`spawn-agents-parallel`** → fetch each entry's prompt via `pipeline_get_spawn_prompt` the same way, run every spawn, then deliver all results together: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "agents-results", results: [{ agent_run_id, agent_output }, …] } })`.
- **`ask-user`** → the task is parked at a human gate. Show `message` and `valid_answers` to the user **verbatim** and deliver their choice: `mcp__loom__pipeline_continue_task({ project_dir, driver_state_id, input: { type: "user-answer", gate_event_id, … } })`. The `gate_event_id` is the original one the task paused on — the answer binds to that exact gate.
- **`complete`** → the task is already finished; display `summary`, suggest `/done`, and stop.
- **`error`** with code **`NO_ACTIVE_TASK`** → there is no task to resume in this project; tell the user and stop. Any other `error` → display `message` and `recovery_options` verbatim, then call `mcp__loom__pipeline_recover({ project_dir, driver_state_id, choice })` with the option the user picks (passing `agent_run_ids` when that option lists them).

After the first `pipeline_continue_task` you are in the ordinary `/task` loop — keep looping on each new response's `status` the way `/task` describes. Never edit the state DB by hand; `pipeline_recover` is the only repair path.
