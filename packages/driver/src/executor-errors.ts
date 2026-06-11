// Typed executor errors the sandbox shell raises — distinct from the PERMANENT
// provider errors (provider-error.ts) and from the rate-limit / timeout codes
// the backends surface.
//
// EXECUTOR_EMPTY_DIFF rides the drive loop's GENERIC executor-retry path by
// design: it is deliberately NOT in the loop's NO_RETRY set (so a retry IS
// attempted) and NOT in its SURFACEABLE set (so it relabels to EXECUTOR_FAILED
// after the budget is spent). That is exactly the "retry once, then park"
// disposition a no-op implementation wants — re-run the editing agent, and if
// it STILL changes nothing, surface a terminal failure for the operator rather
// than feeding an empty diff to the reviewers and the final gate.

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
