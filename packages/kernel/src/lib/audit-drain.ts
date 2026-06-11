// Drain the per-tick audit buffer into the `audit` table — co-committed
// with the state mutation it describes.
//
// Bundle code and in-tick kernel sites accumulate forensic entries on
// `tx.audit_buffer` (via `ctx.tx.audit(...)` / `ctx.audit_extra(...)` and
// the BundleOp drain). Those entries were discarded when the tx closed —
// the whole audit trail a tick produced vanished. This drains them into
// the `audit` table INSIDE the same transaction as the effects they
// record, so a row exists exactly when (and only when) the tick it
// describes committed. A rolled-back tick leaves no orphan audit row —
// the ledger co-commit pattern, applied to the forensic trail.
//
// Each entry MUST carry a string `type` drawn from the active registry's
// merged `audit_types` vocabulary — the same insert-time discipline every
// other kernel-additive enum column gets (`assertVocabKnown`). An entry
// with no `type`, or an undeclared one, rolls the tick back rather than
// landing an un-typed forensic row. The audit-table `verdict` column is
// kernel-owned and fixed to `ok` for a buffered entry; a payload's own
// domain fields (including any `verdict` key the bundle chose) ride inside
// the JSON `payload`, never the kernel column.
//
// Wall-clock discipline: the row timestamp is `tx.now`, never the host clock.

import { KernelError } from "../state/db.js";
import { assertVocabKnown } from "../vocabularies.js";
import type { Transaction } from "../types/transaction.js";
import type { Vocabulary } from "../types/vocabulary.js";

export interface AuditDrainContext {
  // Bound onto each row so the forensic trail keys back to the task /
  // driver state the tick belonged to. `task_id` is null only before the
  // task-create row mints it (no tick buffers audit that early).
  task_id: string | null;
  driver_state_id: string;
  // Merged kernel-default + bundle-extension audit types. A buffered
  // entry's `type` is validated against this set before it lands.
  audit_types: Vocabulary<string>;
}

export async function drainAuditBuffer(
  tx: Transaction,
  ctx: AuditDrainContext,
): Promise<void> {
  if (tx.audit_buffer.length === 0) return;
  for (const entry of tx.audit_buffer) {
    const type = entry["type"];
    if (typeof type !== "string" || type.length === 0) {
      throw new KernelError({
        code: "AUDIT_ENTRY_UNTYPED",
        message:
          "a buffered audit entry carries no string 'type' — every audit " +
          "row must name a declared audit_types value",
        detail: { entry_keys: Object.keys(entry) },
      });
    }
    assertVocabKnown(ctx.audit_types, type, "audit_types");
    await tx.exec(
      "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, verdict) " +
        "VALUES (?, ?, ?, ?, ?, 'ok')",
      [tx.now, type, ctx.task_id, ctx.driver_state_id, JSON.stringify(entry)],
    );
  }
  // Cleared once landed so nothing re-drains the same entries within this
  // tx; a fresh tx starts with an empty buffer regardless.
  tx.audit_buffer.length = 0;
}
