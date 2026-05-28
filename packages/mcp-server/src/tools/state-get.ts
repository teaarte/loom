// pipeline_state_get — operator-inspection handler. Four output
// formats sit behind one entry: a compact summary keyed on the most-
// asked counters, the full PipelineState aggregate, per-table JSONL,
// and a stable-width ASCII rendering whose column widths are pinned
// so two snapshots diff cleanly.

import type { DatabaseSync } from "node:sqlite";

import {
  captureNow,
  loadState,
  openDb,
  TransactionImpl,
} from "@loom/kernel";

import type {
  PipelineStateView,
  StateGetFormat,
  StateGetInput,
  ToolHandler,
} from "../types.js";

const DEFAULT_TABLE = "audit";
const DEFAULT_TABLE_LIMIT = 100;
const MAX_TABLE_LIMIT = 1000;

// Tables the caller may inspect via `jsonl` / `pretty-table`. The
// allowlist closes the surface against accidental cross-table reads
// from the same handler — the operator cannot trick the tool into
// dumping the idempotency ledger by passing `kernel_idempotency_ledger`
// as the table filter, because that table is not on the list.
const INSPECTABLE_TABLES: ReadonlySet<string> = new Set([
  "pipeline_state",
  "pipeline_counters",
  "pipeline_gate_counters",
  "driver_state",
  "phases",
  "agent_records",
  "pending_agents",
  "agent_verdicts",
  "findings",
  "gates",
  "audit",
  "installed_extensions",
]);

// Tables that carry a `ts` column the `since` filter can target. Other
// inspectable tables use a `recorded_at` or `started_at` column; the
// `since` filter intentionally stays narrow to keep the contract
// predictable.
const TS_FILTERED_TABLES: ReadonlySet<string> = new Set(["audit", "findings"]);

function tsColumnFor(table: string): string | null {
  if (table === "audit") return "ts";
  if (table === "findings") return "recorded_at";
  return null;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_TABLE_LIMIT;
  if (raw > MAX_TABLE_LIMIT) return MAX_TABLE_LIMIT;
  return Math.floor(raw);
}

export function createStateGetTool(): ToolHandler<StateGetInput, PipelineStateView> {
  return async (input) => {
    const format: StateGetFormat = input.format ?? "summary";
    const db = openDb(input.project_dir);

    if (format === "summary") return renderSummary(db);
    if (format === "json") return await renderJson(input.project_dir);
    if (format === "jsonl") return renderJsonl(db, input);

    return renderPrettyTable(db, input);
  };
}

// ---------------------------------------------------------------------
// summary — small per-table counts. Avoids loading PipelineState so a
// state-get call against an uninitialized project still returns a
// useful envelope.
// ---------------------------------------------------------------------

function renderSummary(db: DatabaseSync): PipelineStateView {
  const ps = db
    .prepare("SELECT task_id, status, owner_id FROM pipeline_state WHERE id = 1")
    .get() as { task_id: string | null; status: string; owner_id: string | null } | undefined;

  const pendingRow = db
    .prepare("SELECT COUNT(*) AS c FROM pending_agents")
    .get() as { c: number };
  const gatesRow = db
    .prepare("SELECT COUNT(*) AS c FROM gates")
    .get() as { c: number };
  const auditRow = db
    .prepare("SELECT COUNT(*) AS c FROM audit")
    .get() as { c: number };
  const findingsRow = db
    .prepare("SELECT COUNT(*) AS c FROM findings")
    .get() as { c: number };

  return {
    format: "summary",
    summary: {
      task_id: ps?.task_id ?? null,
      status: ps?.status ?? null,
      owner_id: ps?.owner_id ?? null,
      pending_agent_count: Number(pendingRow.c),
      gate_count: Number(gatesRow.c),
      audit_row_count: Number(auditRow.c),
      finding_count: Number(findingsRow.c),
    },
  };
}

// ---------------------------------------------------------------------
// json — full PipelineState aggregate. Uses a read-only tx wrapper:
// the handler never commits, so the now token threaded through
// `TransactionImpl` is local to this scope and not observable on disk.
// ---------------------------------------------------------------------

async function renderJson(projectDir: string): Promise<PipelineStateView> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  const state = await loadState(tx);
  return { format: "json", state };
}

// ---------------------------------------------------------------------
// jsonl — each row of the requested table on its own line.
// ---------------------------------------------------------------------

function renderJsonl(db: DatabaseSync, input: StateGetInput): PipelineStateView {
  const table = resolveTable(input.table);
  const limit = clampLimit(input.limit);
  const rows = queryTable(db, table, input.since, limit);
  return { format: "jsonl", lines: rows.map((r) => JSON.stringify(r)) };
}

// ---------------------------------------------------------------------
// pretty-table — stable-width ASCII renderer. Widths are
// max(column name length, max cell length) per column; the same input
// rows render identically across runs so two state-get snapshots diff
// cleanly without whitespace noise.
// ---------------------------------------------------------------------

function renderPrettyTable(db: DatabaseSync, input: StateGetInput): PipelineStateView {
  const limit = clampLimit(input.limit);
  const tables: Record<string, string> = {};

  if (input.table !== undefined) {
    const table = resolveTable(input.table);
    const rows = queryTable(db, table, input.since, limit);
    tables[table] = renderTable(rows);
    return { format: "pretty-table", tables };
  }

  const table = DEFAULT_TABLE;
  const rows = queryTable(db, table, input.since, limit);
  tables[table] = renderTable(rows);
  return { format: "pretty-table", tables };
}

// ---------------------------------------------------------------------
// Per-table query helper. Honors `since` only when the table exposes a
// timestamp column on the allowlist.
// ---------------------------------------------------------------------

function queryTable(
  db: DatabaseSync,
  table: string,
  since: string | undefined,
  limit: number,
): Record<string, unknown>[] {
  const tsCol = tsColumnFor(table);
  if (since !== undefined && tsCol !== null && TS_FILTERED_TABLES.has(table)) {
    return db
      .prepare(`SELECT * FROM ${table} WHERE ${tsCol} >= ? LIMIT ?`)
      .all(since, limit) as Record<string, unknown>[];
  }
  return db.prepare(`SELECT * FROM ${table} LIMIT ?`).all(limit) as Record<string, unknown>[];
}

function resolveTable(requested: string | undefined): string {
  const candidate = requested ?? DEFAULT_TABLE;
  if (!INSPECTABLE_TABLES.has(candidate)) {
    // Fall through to default rather than throwing: the tool is an
    // operator inspection surface, and a typo on the table name should
    // not nuke the call. Future work may surface this as a warning
    // envelope alongside the table dump.
    return DEFAULT_TABLE;
  }
  return candidate;
}

function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(empty)";
  const headers = Object.keys(rows[0] as Record<string, unknown>);

  const widths = headers.map((h) => {
    let w = h.length;
    for (const row of rows) {
      const cell = stringifyCell(row[h]);
      if (cell.length > w) w = cell.length;
    }
    return w;
  });

  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i] as number))
    .join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const body = rows
    .map((row) =>
      headers
        .map((h, i) => stringifyCell(row[h]).padEnd(widths[i] as number))
        .join(" | "),
    )
    .join("\n");

  return `${headerLine}\n${sep}\n${body}`;
}

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  return JSON.stringify(v);
}
