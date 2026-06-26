// BundleOp dispatcher — drains the per-tick scratch buffer into
// kernel-owned SQLite tables inside the caller's open transaction.
//
// The eight variants are exhaustive: stage interpreters and event-
// Steps push their writes as typed ops; this is the single applier
// that knows how to land each one. A throw out of any handler aborts
// the outer tx — invariants on commit catch what mutators alone
// cannot.
//
// `mergeJsonObjectColumn` / `mergeJsonArrayColumn` read-merge-write
// under the open writer lock; `BEGIN IMMEDIATE` already prevents
// concurrent writers from racing the read/write pair.

import { KernelError } from "../state/db.js";
import { parseStateJson } from "../state/json.js";
import type { BundleOp } from "../types/context.js";
import type { Finding, FindingSeverity, FindingStatus } from "../types/findings.js";
import type { Phase } from "../types/row-types.js";
import type { Transaction } from "../types/transaction.js";

// Bundle-supplied identifier shape — the single rule both a bundle table
// name and a bundle column key must satisfy before either is interpolated
// into SQL text. A value failing it is refused, never coerced.
const BUNDLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const BUNDLE_TABLE_NAME = BUNDLE_IDENTIFIER;

// `phase` is the active stage's phase, threaded from the FSM tick so a
// `record_finding` op buffered by a bundle Step lands under the real
// phase rather than a placeholder. The BundleOp envelope itself carries
// no phase — it is worker-portable and the phase is a kernel-side fact —
// so the kernel stamps it here, at the single drain point. Defaults to
// the empty string for the few callers (FinalizeStage, a phase-less
// event Step) where the active stage has no phase.
//
// `iteration` is the phase's current round, read from the kernel-owned
// per-phase counter by the caller. Like `phase`, it is stamped here at the
// drain point rather than trusted from the bundle-supplied `Finding`, so a
// bundle-authored finding shares the same kernel provenance the
// agent-result path stamps. Defaults to round 1.
export async function applyBundleOps(
  tx: Transaction,
  ops: BundleOp[],
  phase: Phase = "",
  iteration = 1,
): Promise<void> {
  for (const op of ops) {
    await applyOne(tx, op, phase, iteration);
  }
}

async function applyOne(
  tx: Transaction,
  op: BundleOp,
  phase: Phase,
  iteration: number,
): Promise<void> {
  switch (op.op) {
    case "set_decision":
      await mergeJsonObjectColumn(tx, "decisions", { [op.key]: op.value });
      return;
    case "record_finding":
      await insertFinding(tx, op.finding, phase, iteration);
      return;
    case "set_bundle_state_field":
      await mergeJsonObjectColumn(tx, "bundle_state", { [op.path]: op.value });
      return;
    case "record_files_modified":
      await mergeJsonArrayColumn(tx, "files_modified", op.paths);
      return;
    case "record_files_created":
      await mergeJsonArrayColumn(tx, "files_created", op.paths);
      return;
    case "upsert_bundle_row":
      await upsertBundleRow(tx, op.table, op.row);
      return;
    case "update_finding_status":
      await updateFindingStatus(tx, op.id, op.status, op.severity);
      return;
    case "audit":
      tx.audit_buffer.push(op.payload);
      return;
    case "render_view":
      // Output rendering lands with the bundle output surface. The op is
      // accepted (so bundles can reference it today) and otherwise a no-op
      // — it writes nothing. It deliberately emits NO audit entry: the
      // forensic drain now lands every buffered entry as a real row, and a
      // no-op that rendered nothing has no honest forensic event to record.
      // Real rendering + its audit arrive with the output subsystem.
      return;
    default: {
      const _exhaustive: never = op;
      throw new KernelError({
        code: "BUNDLE_OP_UNKNOWN",
        message: "unknown BundleOp variant",
        detail: { op: _exhaustive as unknown as Record<string, unknown> },
      });
    }
  }
}

async function insertFinding(
  tx: Transaction,
  f: Finding,
  phase: Phase,
  iteration: number,
): Promise<void> {
  // `phase` and `iteration` are the active stage's phase + current round,
  // threaded from the tick. A bundle Step that pushes `record_finding`
  // directly through `ctx.tx.record_finding(...)` now lands its forensics
  // row under the running phase and round; the empty-string phase fallback
  // applies only when the active stage genuinely has none (FinalizeStage /
  // a phase-less event Step). A fresh row is LIVE — `superseded_by_iteration`
  // defaults to NULL (omitted from the column list below).
  //
  // Idempotent on the finding `id` (the PRIMARY KEY, the dedup key): a Step
  // that re-runs on restart — or a replayed tick — pushing the same finding
  // re-derives the same `id` and lands a no-op rather than a duplicate row
  // (or a PK-conflict abort). The bundle owns `id` stability: a finding it
  // means to dedupe across a re-run supplies a deterministic id (derived
  // from its content/location), and ON CONFLICT keeps a single row.
  await tx.exec(
    "INSERT INTO findings (id, task_id, agent, iteration, phase, file, " +
      "line_start, line_end, severity, category, proposed_new_category, " +
      "pattern_id, summary, evidence_excerpt, suggested_fix, status, " +
      "ref_rule_id, origin, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO NOTHING",
    [
      f.id,
      f.task_id.length > 0 ? f.task_id : null,
      f.agent,
      iteration,
      phase,
      f.file,
      f.line_start,
      f.line_end,
      f.severity,
      f.category,
      f.proposed_new_category,
      f.pattern_id,
      f.summary,
      f.evidence_excerpt,
      f.suggested_fix,
      f.status,
      f.ref_rule_id,
      // Absent ⇒ a code finding (the default); a bundle Step never mints
      // harness provenance — that is the kernel's alone.
      f.origin ?? "code",
      tx.now,
    ],
  );
}

// Generic finding-status edit. Sets only the supplied lifecycle columns
// (`status` / `severity`) on the row keyed by `id`. No clock: `recorded_at`
// is the finding's creation time and a status edit leaves it untouched.
// Idempotent — re-applying the same op rewrites the same column values, so a
// replayed tick re-deriving this op is a no-op the second time. An op that
// supplies neither column is a no-op (the SET list would be empty).
async function updateFindingStatus(
  tx: Transaction,
  id: string,
  status: FindingStatus | undefined,
  severity: FindingSeverity | undefined,
): Promise<void> {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (status !== undefined) {
    sets.push("status = ?");
    values.push(status);
  }
  if (severity !== undefined) {
    sets.push("severity = ?");
    values.push(severity);
  }
  if (sets.length === 0) return;
  values.push(id);
  await tx.exec(
    `UPDATE findings SET ${sets.join(", ")} WHERE id = ?`,
    values,
  );
}

interface ColumnInfoRow {
  name: unknown;
  // PRAGMA table_info `pk`: 0 for a non-key column, else the 1-based
  // position of the column within the primary key.
  pk: unknown;
}

async function upsertBundleRow(
  tx: Transaction,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  if (!BUNDLE_TABLE_NAME.test(table)) {
    throw new KernelError({
      code: "BUNDLE_TABLE_NAME_INVALID",
      message: `upsert_bundle_row table='${table}' does not match the bundle-table name shape`,
      detail: { table },
    });
  }
  const keys = Object.keys(row);
  if (keys.length === 0) return;

  // Resolve the live schema of the target. The table name passed the
  // identifier shape above, so it is safe to interpolate into the PRAGMA;
  // a non-existent table returns zero columns.
  const info = await tx.queryAll<ColumnInfoRow>(`PRAGMA table_info(${table})`);
  if (info.length === 0) {
    throw new KernelError({
      code: "BUNDLE_TABLE_UNKNOWN",
      message: `upsert_bundle_row table='${table}' has no columns — the bundle table does not exist`,
      detail: { table },
    });
  }
  const columns = new Set(info.map((c) => String(c.name)));
  const pk = info
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((c) => String(c.name));

  // Validate every ROW KEY before it reaches the column list. The table
  // name is checked above; the keys flow into SQL text too, so an
  // unchecked key is an injection vector. Each must be a bare identifier
  // AND a real column of the target — a key failing either is refused, not
  // silently coerced or dropped.
  for (const k of keys) {
    if (!BUNDLE_IDENTIFIER.test(k) || !columns.has(k)) {
      throw new KernelError({
        code: "BUNDLE_COLUMN_INVALID",
        message: `upsert_bundle_row column '${k}' is not a valid column of '${table}'`,
        detail: { table, column: k },
      });
    }
  }

  const placeholders = keys.map(() => "?").join(", ");
  const values = keys.map((k) => row[k] as unknown);
  const cols = keys.join(", ");

  // A table with no declared primary key has no conflict target, so a true
  // UPSERT has no key to match on — every row is distinct and a plain
  // INSERT is the only meaningful semantics.
  if (pk.length === 0) {
    await tx.exec(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, values);
    return;
  }

  // True UPSERT on the declared primary key. `ON CONFLICT ... DO UPDATE`
  // preserves the existing rowid and fires UPDATE (not DELETE) triggers,
  // unlike `INSERT OR REPLACE` (delete-then-insert, which churns the rowid
  // and fires delete triggers). A row that supplies only key columns has
  // nothing to update → DO NOTHING.
  const updatable = keys.filter((k) => !pk.includes(k));
  const conflict = pk.join(", ");
  const sql =
    updatable.length === 0
      ? `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO NOTHING`
      : `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ` +
        updatable.map((k) => `${k} = excluded.${k}`).join(", ");
  await tx.exec(sql, values);
}

async function mergeJsonObjectColumn(
  tx: Transaction,
  column: "decisions" | "bundle_state",
  patch: Record<string, unknown>,
): Promise<void> {
  const row = await tx.queryRow<Record<string, string | null>>(
    `SELECT ${column} FROM pipeline_state WHERE id = 1`,
  );
  // An unparseable blob here is a corrupted state row: the json_valid CHECK
  // should have refused the write that produced it, so reaching a parse
  // failure means tampering or a backend skew. `parseStateJson` fails loud
  // (STATE_CORRUPT rolls this tick's tx back) rather than resetting the
  // column to `{}` and silently dropping whatever was actually on disk —
  // the same discipline the authoritative state readers already hold to.
  const parsed = parseStateJson<unknown>(row?.[column] ?? null, null);
  const current: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const merged = { ...current, ...patch };
  await tx.exec(
    `UPDATE pipeline_state SET ${column} = ? WHERE id = 1`,
    [JSON.stringify(merged)],
  );
}

async function mergeJsonArrayColumn(
  tx: Transaction,
  column: "files_modified" | "files_created",
  add: string[],
): Promise<void> {
  const row = await tx.queryRow<Record<string, string | null>>(
    `SELECT ${column} FROM pipeline_state WHERE id = 1`,
  );
  // Fail loud on a corrupt blob (STATE_CORRUPT rolls back) rather than
  // resetting the column to `[]` and silently dropping the file accounting
  // — see the note on the object-merge helper above.
  const parsed = parseStateJson<unknown>(row?.[column] ?? null, null);
  const current: string[] = Array.isArray(parsed)
    ? parsed.filter((v): v is string => typeof v === "string")
    : [];
  const merged = [...new Set([...current, ...add])];
  await tx.exec(
    `UPDATE pipeline_state SET ${column} = ? WHERE id = 1`,
    [JSON.stringify(merged)],
  );
}
