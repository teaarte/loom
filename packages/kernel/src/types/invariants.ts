// Invariants — pure functions over state called inside the commit
// transaction. A non-null return rolls the tx back. Determinism is
// load-bearing: replay re-runs the same invariants against the stored
// state and expects the same verdict, so `Date.now()` calls here are a
// bug (read `state.now` instead).

import type { AgentRecord } from "./agent-result.js";
import type { IdempotencyLedgerEntry } from "./idempotency.js";
import type { BundleStateView } from "./state.js";

export interface Violation {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

// Kernel-materialized read-only snapshots — populated from the union of
// `reads` declarations across registered invariants. Invariants that
// did not declare a snapshot receive `undefined` for that field.
export interface KernelSnapshots {
  agent_records?: ReadonlyArray<AgentRecord>;
  ledger?: ReadonlyArray<IdempotencyLedgerEntry>;
}

// Callable + declared metadata. `reads` lists the `BundleStateView`
// field paths plus snapshot roots ("agent_records",
// "kernel_idempotency_ledger") the invariant body touches; the kernel
// uses the union of these declarations to materialize
// `KernelSnapshots` (so an invariant that never reads the ledger never
// pays the SELECT cost). A skip-on-unchanged optimizer can later use
// the same metadata to drop invariants whose declared paths did not
// move on a given commit — wiring lands when the typed-mutator tracker
// arrives.
export interface Invariant {
  (state: BundleStateView, snapshots: KernelSnapshots): Violation | null;
  reads: readonly string[];
}
