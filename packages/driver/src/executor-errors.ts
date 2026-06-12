// Typed executor errors the sandbox shell raises — distinct from the PERMANENT
// provider errors (provider-error.ts) and from the rate-limit / timeout codes
// the backends surface.
//
// EXECUTOR_EMPTY_DIFF rides the drive loop's GENERIC executor-retry path
// (deliberately NOT in the loop's NO_RETRY set, so one fast re-run IS
// attempted) but IS in its SURFACEABLE set: after the in-loop budget the code
// must reach the supervisor intact. Relabelled to the generic EXECUTOR_FAILED
// it read as transient and the daemon re-drove the whole task with backoff —
// each round re-running the agent that keeps deciding there is nothing to
// edit. Surfaced by code, the supervisor parks it for the operator after the
// loop's single retry — the intended "retry once, then park" disposition.

import { KernelError, type ProviderShuttleIntent } from "@loomfsm/kernel";

// A file-editing agent's spawn produced no change to the project tree.
export const EXECUTOR_EMPTY_DIFF = "EXECUTOR_EMPTY_DIFF";

// Raised by the sandbox shell when an edit-expecting spawn's self-diff is empty
// on an isolated tree — a no-op that must fail fast instead of riding an empty
// diff downstream.
export function emptyDiffError(intent: ProviderShuttleIntent): KernelError {
  return new KernelError({
    code: EXECUTOR_EMPTY_DIFF,
    message:
      `agent '${intent.agent}' was expected to edit files but produced an empty ` +
      `diff — no change to the project tree`,
    detail: {
      agent: intent.agent,
      agent_run_id: intent.agent_run_id,
      phase: intent.phase,
    },
  });
}
