// Kernel ↔ transport seam.
//
// `KernelDirective` is what `runFSM` returns to the host — a
// transport-neutral, vendor-neutral union describing what the kernel
// wants done next. `TransportResponse` is what the transport adapter
// emits to its external client (mcp-server, daemon, cli) after shaping
// the directive. `TransportResponse` lives in transport-types and is
// not named by anything inside `packages/kernel/` — enforced by CI grep.

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

export type TransportResponse =
  | {
      status: "spawn-agent";
      driver_state_id: string;
      agent_run_id: string;
      agent: string;
      spawn_request: SpawnRequest;
    }
  | {
      status: "spawn-agents-parallel";
      driver_state_id: string;
      spawns: { agent_run_id: string; agent: string; spawn_request: SpawnRequest }[];
    }
  | {
      status: "ask-user";
      driver_state_id: string;
      gate: string;
      gate_event_id: string;
      message: string;
      valid_answers: UserAnswerSchema;
    }
  | {
      status: "complete";
      task_id: string | null;
      verdict: "accepted" | "rejected" | "failed_force_closed";
      summary: string;
    }
  | {
      status: "error";
      driver_state_id: string;
      code: string;
      message: string;
      recovery_options: { choice: string; label: string; agent_run_ids?: string[] }[];
    };

export interface TransportAdapter {
  shape(directive: KernelDirective, ctx: { driver_state_id: string }): TransportResponse;
}

// Opaque, transport-neutral spawn descriptor. The kernel produces an
// abstract intent (`ProviderShuttleIntent`); the transport adapter
// shapes it into the `SpawnRequest` carried on
// `TransportResponse.spawn-agent`. Fields like `runner_hint` are set by
// the adapter, not the kernel.
export interface SpawnRequest {
  runner_hint: string;
  description: string;
  prompt: string;
  model?: string;
  extras?: Record<string, unknown>;
}
