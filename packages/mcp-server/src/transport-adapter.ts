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

// Inline-vs-by-reference threshold for a parallel fanout, measured in
// prompt characters summed across the batch. At or under this cap every
// prompt ships inline so the host dispatches the batch and returns one
// results payload — zero per-agent fetch round-trips. Over it, the batch
// falls back to by-reference so the response can't blow past the host's
// inline-response cap.
//
// Anchored to the one hard datapoint: a 4-way implementation-review
// fanout measured ~84k chars in a single response and spilled past that
// cap — the incident that introduced the by-reference path. 50k sits
// well under it, leaving headroom for envelope overhead (agent ids,
// models, extras, JSON framing) and prompt-size variance, while still
// inlining the common narrow fanout (a 2-way review lands near ~40k).
// Revisit if the real host inline cap is ever measured directly.
const INLINE_FANOUT_PROMPT_CHAR_CAP = 50_000;

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
    case "shuttle-batch": {
      // Fanout-prompt delivery is chosen by size — a domain-blind
      // transport-shaping decision. When the batch's prompts sum at or
      // under the inline cap, every prompt ships inline: the host
      // dispatches the whole fanout and returns one results payload with
      // no per-agent fetch round-trip. Over the cap, the descriptors omit
      // the prompt (model + extras stay inline — small, and the host
      // needs them to dispatch) so the envelope's size scales with the
      // agent count, not the sum of every prompt; the host then fetches
      // each prompt by reference, keyed by agent_run_id.
      const totalPromptChars = directive.spawns.reduce(
        (sum, intent) => sum + intent.prompt.length,
        0,
      );
      const inline = totalPromptChars <= INLINE_FANOUT_PROMPT_CHAR_CAP;
      const base = {
        status: "spawn-agents-parallel" as const,
        driver_state_id: ctx.driver_state_id,
        spawns: directive.spawns.map((intent) => ({
          agent_run_id: intent.agent_run_id,
          agent: intent.agent,
          spawn_request: toSpawnRequest(intent, { inlinePrompt: inline }),
        })),
      };
      // `prompts_by_reference` is set ONLY on the over-cap path; the
      // inline path omits it so the host treats every prompt as present
      // and never calls the by-reference fetch.
      return inline ? base : { ...base, prompts_by_reference: true };
    }
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
