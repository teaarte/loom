// The MCP transport adapter — pure mapping `KernelDirective →
// TransportResponse`.
//
// No I/O, no DB reads, no clock reads: the same directive in produces a
// structurally-equal envelope out. Pushing the kernel-to-wire seam into
// one pure function lets every transport carry its own copy without
// re-implementing kernel reads, and keeps the kernel free of any
// wire-shape coupling.
//
// `runner_hint` is hard-coded to "mcp-server" on every emitted spawn
// descriptor; the hint is opaque to the kernel and lets the host
// disambiguate provider routing.
//
// `advance` is never a top-level `runFSM` result — the tick loop
// swallows it internally and only returns at a terminal directive. The
// adapter refuses the impossible with a `KERNEL_INVARIANT` error rather
// than crashing, so a kernel regression surfaces as a structured wire
// error the client can display.

import type { KernelDirective, ProviderShuttleIntent } from "@loomfsm/kernel";
import type {
  SpawnRequest,
  TransportAdapter,
  TransportResponse,
} from "@loomfsm/transport-types";

const RUNNER_HINT = "mcp-server";

export function createTransportAdapter(): TransportAdapter {
  return { shape };
}

export function shape(
  directive: KernelDirective,
  ctx: { driver_state_id: string },
): TransportResponse {
  switch (directive.kind) {
    case "advance":
      return {
        status: "error",
        driver_state_id: ctx.driver_state_id,
        code: "KERNEL_INVARIANT",
        message:
          "top-level advance directive surfaced — kernel must terminate at a non-advance kind",
        recovery_options: [],
      };
    case "shuttle": {
      const intent = directive.spawn;
      return {
        status: "spawn-agent",
        driver_state_id: ctx.driver_state_id,
        agent_run_id: intent.agent_run_id,
        agent: intent.agent,
        // A single spawn carries its one prompt inline — no reference round
        // trip for the common case.
        spawn_request: toSpawnRequest(intent, { inlinePrompt: true }),
      };
    }
    case "shuttle-batch":
      // Fanout prompts go by reference: each descriptor carries model +
      // extras (small, host needs them to dispatch) but NOT the prompt, so
      // this envelope's size scales with the agent count, not the sum of
      // every prompt. The host fetches each prompt via a read-only call
      // keyed by agent_run_id.
      return {
        status: "spawn-agents-parallel",
        driver_state_id: ctx.driver_state_id,
        prompts_by_reference: true,
        spawns: directive.spawns.map((intent) => ({
          agent_run_id: intent.agent_run_id,
          agent: intent.agent,
          spawn_request: toSpawnRequest(intent, { inlinePrompt: false }),
        })),
      };
    case "ask-user":
      return {
        status: "ask-user",
        driver_state_id: directive.driver_state_id,
        gate: directive.gate,
        gate_event_id: directive.gate_event_id,
        message: directive.message,
        valid_answers: directive.valid_answers,
      };
    case "complete":
      return {
        status: "complete",
        task_id: directive.task_id,
        verdict: directive.verdict,
        summary: directive.summary,
      };
    case "error":
      return {
        status: "error",
        driver_state_id: directive.driver_state_id,
        code: directive.code,
        message: directive.message,
        recovery_options: directive.recovery_options,
      };
    default: {
      const _exhaustive: never = directive;
      return _exhaustive;
    }
  }
}

function toSpawnRequest(
  intent: ProviderShuttleIntent,
  opts: { inlinePrompt: boolean },
): SpawnRequest {
  const req: SpawnRequest = {
    runner_hint: RUNNER_HINT,
    description: `${intent.agent} (${intent.phase})`,
    model: intent.model,
  };
  if (opts.inlinePrompt) req.prompt = intent.prompt;
  if (intent.extras !== undefined) req.extras = intent.extras;
  return req;
}
