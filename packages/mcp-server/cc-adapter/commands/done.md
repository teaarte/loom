---
mcp_protocol_required: "^3.0"
---

# /done — review a finished task

<!--
  Read-only by design. The task is already finalized by the server when it
  reaches its terminal step; this command never mutates state and never
  acts on the user's behalf. If the task is stuck, the only repair path is
  the server-issued recovery options — never a hand-edit of the state DB.

  Bundle-neutral: it renders whatever the kernel's summary carries
  (verdict, counts, outputs) and never assumes a particular kind of work.
  Any "next step" it offers (a commit, a publish, a hand-off) is a
  suggestion the user acts on, not something this command performs.

  `loom` below is the alias this MCP server is registered under in the
  host's MCP config; swap the `mcp__loom__` prefix if you registered it
  under a different name.
-->

Call `mcp__loom__pipeline_state_get({ project_dir: <cwd>, format: "summary" })` to check readiness.

- If the task is in an **error / stuck** state (or still has pending agents or an unanswered gate) → display the recovery options verbatim and call `mcp__loom__pipeline_recover({ project_dir, driver_state_id, choice })` with the option the user picks. Stop here; rerun `/done` once the task settles.
- Otherwise (in progress with nothing pending, or already completed):
  1. Call `mcp__loom__pipeline_state_get({ project_dir, format: "json" })` for the final metrics.
  2. Display the kernel summary to the user verbatim — verdict, agent count, outputs, key findings.
  3. Optionally suggest a sensible next step for that result (for a code task that is usually a commit message). It is a suggestion only — the user acts on it.
  4. Do **not** perform the next step yourself, do **not** auto-commit, and do **not** mutate state.
