---
mcp_protocol_required: "^3.0"
---

# /done — review a finished task

<!--
  Read-then-rotate by design. This command presents the finished task's
  review WITHOUT altering its outcome, then rotates the finished record into
  history so the project is clear for the next task. The only state
  transition it performs is that post-review archival of an ALREADY-FINISHED
  task; it never edits a task's content, never acts on the user's behalf (no
  commit, no code change), and never hand-edits the state DB. If the task is
  stuck, the only repair path is the server-issued recovery options.

  Sequencing matters: read and display the record FIRST, archive LAST — the
  archive moves the state DB aside, so reading it afterward would find
  nothing.

  Bundle-neutral: it renders whatever the kernel's summary carries
  (verdict, counts, outputs) and never assumes a particular kind of work.
  Any "next step" it offers (a commit, a publish, a hand-off) is a
  suggestion the user acts on, not something this command performs.

  `loom` below is the alias this MCP server is registered under in the
  host's MCP config; swap the `mcp__loom__` prefix if you registered it
  under a different name.
-->

Call `mcp__loom__pipeline_state_get({ project_dir: <cwd>, format: "summary" })` to check readiness.

- If there is **no active task** (the summary reports none — e.g. it was already finished and archived) → tell the user there is nothing to review and stop.
- If the task is in an **error / stuck** state (or still has pending agents or an unanswered gate) → display the recovery options verbatim and call `mcp__loom__pipeline_recover({ project_dir, driver_state_id, choice })` with the option the user picks. Stop here; rerun `/done` once the task settles.
- Otherwise (in progress with nothing pending, or already completed):
  1. Call `mcp__loom__pipeline_state_get({ project_dir, format: "json" })` for the final metrics.
  2. Display the kernel summary to the user verbatim — verdict, agent count, outputs, key findings.
  3. Optionally suggest a sensible next step for that result (for a code task that is usually a commit message). It is a suggestion only — the user acts on it.
  4. Do **not** perform the next step yourself, do **not** auto-commit, and do **not** mutate state.
  5. **Only if the task is finished** (status `completed` or `abandoned`): free the project's slot for the next task by calling `mcp__loom__pipeline_archive_and_reset({ project_dir })` **after** the summary above has been displayed. This archives the finished task's record into `.claude/history/` and clears the live slot, so the next `/task` starts clean. If the task is still in progress, skip this — it is not finished. If the tool reports nothing to reset, the slot is already clear.
