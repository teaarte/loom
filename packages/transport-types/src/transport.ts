// Transport-adapter wire shape — shared by every transport adapter and
// every client that consumes one.
//
// The kernel emits a `KernelDirective` (transport-neutral) and never
// names anything in this file. Each transport ships a small pure
// adapter that maps a directive into a `TransportResponse`; pushing the
// wire shape into its own package keeps the kernel free of wire-shape
// coupling and lets adapters + clients share one definition without
// importing kernel internals. The kernel-to-wire seam is enforced by a
// CI grep that refuses any mention of this type inside the kernel
// source tree.

import type { KernelDirective, UserAnswerSchema } from "@loomfsm/kernel";

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
      // When true, each `spawn_request` carries NO `prompt`: the host
      // fetches each agent's prompt by reference (one small read-only call
      // per `agent_run_id`) instead of receiving every full prompt inline.
      // A wide fanout inlining N×~20k-char prompts blows past an MCP
      // client's inline-response cap; by-reference keeps this envelope's
      // size bounded by the agent count, not the prompt sizes. The model /
      // extras the host needs to dispatch stay inline — only the bulky
      // prompt moves behind the reference.
      prompts_by_reference?: boolean;
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

// Pure mapping `KernelDirective → TransportResponse`. Same directive in
// produces the same response out — no I/O, no state, no clock read.
export interface TransportAdapter {
  shape(directive: KernelDirective, ctx: { driver_state_id: string }): TransportResponse;
}

// Opaque, transport-neutral spawn descriptor. The kernel produces an
// abstract intent (`ProviderShuttleIntent`); the transport adapter
// shapes it into the `SpawnRequest` carried on the spawn-agent wire
// envelope. Fields like `runner_hint` are set by the adapter, not the
// kernel.
export interface SpawnRequest {
  runner_hint: string;
  description: string;
  // The rendered prompt. Present on a single spawn-agent descriptor; on a
  // by-reference fanout (see `prompts_by_reference`) it is omitted and the
  // host fetches it with a small read-only call keyed by agent_run_id.
  prompt?: string;
  model?: string;
  extras?: Record<string, unknown>;
}
