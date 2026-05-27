// Idempotency contract — unified across every retryable kernel op.
//
// Every retryable kernel operation declares an `IdempotencyKey` and
// stores its committed response in `kernel_idempotency_ledger`. On
// replay the kernel returns the stored response verbatim; no double
// effects. The ledger row is written INSIDE the persistence tx
// alongside the state mutation it dedupes — row-exists-or-doesn't is
// atomic with the effect.

export type IdempotencyKey = `${IdempotencyOp}:${string}`;

export type IdempotencyOp =
  | "agent-result"
  | "user-answer"
  | "task-create"
  | "provider-call"
  | "provider-stream-resume"
  | "side-effect-hook"
  | "recovery"
  | "metric-finalize"
  | "mcp-tool-call";

export interface IdempotencyLedgerEntry {
  key: IdempotencyKey;
  first_seen_ts: string;
  last_seen_ts: string;
  // Null while the delivery has committed but the kernel has not yet
  // cached the computed next directive — crash-recovery path.
  response_blob: string | null;
  hook_results_json: string | null;
}
