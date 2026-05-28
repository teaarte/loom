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
import type { BundleOp } from "../types/context.js";
import type { Finding } from "../types/findings.js";
import type { Transaction } from "../types/transaction.js";

const BUNDLE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

export async function applyBundleOps(
  tx: Transaction,
  ops: BundleOp[],
): Promise<void> {
  for (const op of ops) {
    await applyOne(tx, op);
  }
}

async function applyOne(tx: Transaction, op: BundleOp): Promise<void> {
  switch (op.op) {
    case "set_decision":
      await mergeJsonObjectColumn(tx, "decisions", { [op.key]: op.value });
      return;
    case "record_finding":
      await insertFinding(tx, op.finding);
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
    case "audit":
      tx.audit_buffer.push(op.payload);
      return;
    case "render_view":
      // Output rendering lands with the bundle output surface. The
      // op is accepted (so bundles can reference it today), recorded
      // for audit, and otherwise discarded — keeps bundles forward-
      // compatible without forcing the rendering subsystem into
      // every session.
      tx.audit_buffer.push({
        kind: "render_view-noop",
        path: op.path,
        bytes: op.content.length,
      });
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

async function insertFinding(tx: Transaction, f: Finding): Promise<void> {
  // Phase resolution for ops-buffered findings ships with the
  // bundle-loader's stage-aware scratch context — the BundleOp
  // shape today has no phase field, and the persistAgentResult
  // path is the production write surface that DOES thread phase.
  // The empty-string fallback below keeps a record landing on the
  // forensics surface even if a Step.run pushes record_finding
  // directly (no SQL constraint forbids empty TEXT, only NULL).
  const phaseFallback = "";
  await tx.exec(
    "INSERT INTO findings (id, task_id, agent, iteration, phase, file, " +
      "line_start, line_end, severity, category, proposed_new_category, " +
      "pattern_id, summary, evidence_excerpt, suggested_fix, status, " +
      "ref_rule_id, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      f.id,
      f.task_id.length > 0 ? f.task_id : null,
      f.agent,
      f.iteration,
      phaseFallback,
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
      tx.now,
    ],
  );
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
  const placeholders = keys.map(() => "?").join(", ");
  const values = keys.map((k) => row[k] as unknown);
  await tx.exec(
    `INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
    values,
  );
}

async function mergeJsonObjectColumn(
  tx: Transaction,
  column: "decisions" | "bundle_state",
  patch: Record<string, unknown>,
): Promise<void> {
  const row = await tx.queryRow<Record<string, string | null>>(
    `SELECT ${column} FROM pipeline_state WHERE id = 1`,
  );
  let current: Record<string, unknown> = {};
  const raw = row?.[column];
  if (raw !== null && raw !== undefined && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      current = {};
    }
  }
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
  let current: string[] = [];
  const raw = row?.[column];
  if (raw !== null && raw !== undefined && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        current = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      current = [];
    }
  }
  const merged = [...new Set([...current, ...add])];
  await tx.exec(
    `UPDATE pipeline_state SET ${column} = ? WHERE id = 1`,
    [JSON.stringify(merged)],
  );
}
