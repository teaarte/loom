// `pipeline_continue_task` payload variants — what hosts deliver back
// to the kernel after a `KernelDirective`. The wire envelope is
// `{ project_dir, driver_state_id, input: ContinueTaskInput }`;
// variants below carry only the payload.

import type { RejectIntent, UserDecision } from "./user-answer.js";

export type ContinueTaskInput =
  | {
      type: "agent-result";
      agent_run_id: string;
      agent_output: string;
      // File accounting the host gathered for this result (e.g. the
      // implementer's `git diff --name-only` after it ran). The kernel
      // unions these into pipeline_state.files_{modified,created} inside
      // the delivery tx, so the next FSM pass — which derives the review
      // shaping (ui/api/security touched) and the diff snapshot — sees the
      // real surface instead of an empty list. Absent → no file update.
      files_modified?: string[];
      files_created?: string[];
      // Per-spawn token usage the host's executor captured (e.g. from a
      // backend that reports `usage`). Persisted to agent_records.tokens_*
      // and rolled into the counters, so the store can report per-task spend.
      // Absent → the row's token columns stay null (no spend recorded).
      tokens?: { in: number; out: number; cached?: number };
    }
  | {
      type: "agents-results";
      results: {
        agent_run_id: string;
        agent_output: string;
        files_modified?: string[];
        files_created?: string[];
        // Per-sibling token usage — same persistence as the single-result
        // variant above.
        tokens?: { in: number; out: number; cached?: number };
      }[];
      // True when host delivers some fanout siblings while others still
      // run — kernel accepts what arrived without advancing step_index.
      partial?: boolean;
    }
  | {
      type: "user-answer";
      gate_event_id: string;
      decision: UserDecision;
      reject_intent?: RejectIntent;
      message?: string;
    }
  | {
      type: "recovery";
      choice: RecoveryChoice;
      agent_run_ids?: string[];
    };

export type RecoveryChoice =
  | "abandon"
  | "force-close"
  | "retry"
  | "retry-failed"
  | "cancel-pending";
