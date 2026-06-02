// Co-committed audit row — the one INSERT every composition writes inside
// its state-mutating tx so the forensic trail lands atomically with the
// effect it records. Shared so the deliver / create / recover paths emit a
// structurally identical row regardless of which transport drives them.

import type { Transaction } from "@loomfsm/kernel";

export interface AuditRowArgs {
  type: string;
  taskId: string | null;
  driverStateId: string;
  payload: Record<string, unknown>;
  // Forensic classification; null for the ordinary "ok" path. A recovery
  // tags `recovery-idempotent` / `recovery-raced` here.
  errorClass?: string | null;
}

export async function writeAuditRow(tx: Transaction, args: AuditRowArgs): Promise<void> {
  await tx.exec(
    "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, verdict, error_class) " +
      "VALUES (?, ?, ?, ?, ?, 'ok', ?)",
    [
      tx.now,
      args.type,
      args.taskId,
      args.driverStateId,
      JSON.stringify(args.payload),
      args.errorClass ?? null,
    ],
  );
}

export async function readTaskId(tx: Transaction): Promise<string | null> {
  const row = await tx.queryRow<{ task_id: unknown }>(
    "SELECT task_id FROM pipeline_state WHERE id = 1",
  );
  if (row === null || row.task_id === null) return null;
  return String(row.task_id);
}
