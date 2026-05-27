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

export type Invariant = (
  state: BundleStateView,
  snapshots: KernelSnapshots,
) => Violation | null;
