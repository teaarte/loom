---
system_prompt: body
---
# Checks runner (deterministic — not a model)

This agent is a placeholder template. Its spawn is **not** dispatched to a model:
the bundle declares its execution capability as `checks`, so the per-spawn
dispatch routes it to a deterministic executor that runs the project's
validation commands (typecheck / lint / test) inside the task's working copy and
reports their exit codes. No prompt is sent to an LLM; this file exists only so
the agent has the `template_path` every agent declares.

The executor returns a JSON envelope as the spawn's output:

```json
{
  "checks": [
    { "name": "typecheck", "status": "ok|fail|skipped", "exit_code": 0, "output_tail": "…", "command": "pnpm run typecheck" }
  ]
}
```

The bundle reads that envelope back into its own state (the safety-floor status
fields) and synthesizes a blocking finding for any failed check, so broken code
is caught — for free — before any review token is spent.
