// Crash-safe create-id derivation — the single home for the
// `client_idempotency_uuid` both intake paths mint from a task: the
// control-plane `submit` and the daemon watcher's seed.
//
// The two MUST agree byte-for-byte. The uuid keys the `task-create`
// idempotency-ledger row, so a resubmit of the same task has to derive the
// SAME uuid to replay the cached creation envelope; if the two derivations
// ever drifted, a resubmit would mint a different uuid, miss the cache, and
// either trip a spurious `PROJECT_TASK_ACTIVE` against the occupied slot or
// create a duplicate task. Two byte-identical copies kept "in sync by hand"
// is exactly the unenforced-invariant trap — so it lives here, in the driver,
// the lowest common dependency of both callers and the home of
// `createAndStart`, which consumes the uuid.
//
// Pure over the task string (sha256 → hex slice) — no clock, no randomness —
// so the same task always yields the same id, the property the ledger relies
// on. Ambient `node:crypto` is fine: this is transport runtime outside the
// kernel's replay graph.

import { createHash } from "node:crypto";

export function deterministicUuid(task: string): string {
  return `cidem-${createHash("sha256").update(task).digest("hex").slice(0, 24)}`;
}
