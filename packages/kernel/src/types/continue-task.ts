// `pipeline_continue_task` payload variants — what hosts deliver back
// to the kernel after a `KernelDirective`. The wire envelope is
// `{ project_dir, driver_state_id, input: ContinueTaskInput }`;
// variants below carry only the payload.

import type { RejectIntent, UserDecision } from "./user-answer.js";

export type ContinueTaskInput =
  | { type: "agent-result"; agent_run_id: string; agent_output: string }
  | {
      type: "agents-results";
      results: { agent_run_id: string; agent_output: string }[];
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
