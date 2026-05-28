// Kernel → host seam.
//
// `KernelDirective` is what `runFSM` returns to the host — a
// transport-neutral, vendor-neutral union describing what the kernel
// wants done next. The kernel never produces wire-shaped output: each
// transport ships its own pure adapter that maps a directive into the
// transport's own wire envelope. Those wire-shape types live in a
// separate package and are not named by anything inside
// `packages/kernel/` — a CI grep enforces the seam at the type level.

import type { ProviderShuttleIntent } from "./provider.js";
import type { UserAnswerSchema } from "./user-answer.js";

export type KernelDirective =
  | { kind: "advance" }
  | { kind: "shuttle"; spawn: ProviderShuttleIntent }
  | { kind: "shuttle-batch"; spawns: ProviderShuttleIntent[] }
  | {
      kind: "ask-user";
      driver_state_id: string;
      gate: string;
      gate_event_id: string;
      message: string;
      valid_answers: UserAnswerSchema;
    }
  | {
      kind: "complete";
      task_id: string | null;
      verdict: "accepted" | "rejected" | "failed_force_closed";
      summary: string;
    }
  | {
      kind: "error";
      driver_state_id: string;
      code: string;
      message: string;
      recovery_options: { choice: string; label: string; agent_run_ids?: string[] }[];
    };
