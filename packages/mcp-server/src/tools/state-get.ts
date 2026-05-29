// pipeline_state_get — operator-inspection handler. Four output
// formats sit behind one entry: a compact summary keyed on the most-
// asked counters, the full PipelineState aggregate, per-table JSONL,
// and a stable-width ASCII rendering whose column widths are pinned
// so two snapshots diff cleanly.
//
// Every format reads inside a single `withReadTransaction`: one
// consistent committed snapshot per call (BEGIN DEFERRED + query_only),
// so a multi-statement inspection never sees a torn mix across an
// interleaved writer commit, and the reader never blocks the writer.

import { loadState, withReadTransaction } from "@loom/kernel";
import type { Transaction } from "@loom/kernel";

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
    return await withReadTransaction(input.project_dir, async (tx) => {
      if (format === "summary") return await renderSummary(tx);
      if (format === "json") return { format: "json", state: await loadState(tx) };
      if (format === "jsonl") return await renderJsonl(tx, input);
      return await renderPrettyTable(tx, input);
    });
  };
}

// ---------------------------------------------------------------------
// summary — small per-table counts. Avoids loading PipelineState so a
// state-get call against an uninitialized project still returns a
// useful envelope.
// ---------------------------------------------------------------------

async function renderSummary(tx: Transaction): Promise<PipelineStateView> {
  const ps = await tx.queryRow<{
    task_id: string | null;
    status: string;
    owner_id: string | null;
  }>("SELECT task_id, status, owner_id FROM pipeline_state WHERE id = 1");

  const pendingRow = await tx.queryRow<{ c: number }>(
    "SELECT COUNT(*) AS c FROM pending_agents",
  );
  const gatesRow = await tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM gates");
  const auditRow = await tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM audit");
  const findingsRow = await tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM findings");

  return {
    format: "summary",
    summary: {
      task_id: ps?.task_id ?? null,
      status: ps?.status ?? null,
      owner_id: ps?.owner_id ?? null,
      pending_agent_count: Number(pendingRow?.c ?? 0),
      gate_count: Number(gatesRow?.c ?? 0),
      audit_row_count: Number(auditRow?.c ?? 0),
      finding_count: Number(findingsRow?.c ?? 0),
    },
  };
}

// ---------------------------------------------------------------------
// jsonl — each row of the requested table on its own line.
// ---------------------------------------------------------------------

async function renderJsonl(tx: Transaction, input: StateGetInput): Promise<PipelineStateView> {
  const table = resolveTable(input.table);
  const limit = clampLimit(input.limit);
  const rows = await queryTable(tx, table, input.since, limit);
  return { format: "jsonl", lines: rows.map((r) => JSON.stringify(r)) };
}

// ---------------------------------------------------------------------
// pretty-table — stable-width ASCII renderer. Widths are
// max(column name length, max cell length) per column; the same input
// rows render identically across runs so two state-get snapshots diff
// cleanly without whitespace noise.
// ---------------------------------------------------------------------

async function renderPrettyTable(
  tx: Transaction,
  input: StateGetInput,
): Promise<PipelineStateView> {
  const limit = clampLimit(input.limit);
  const tables: Record<string, string> = {};

  if (input.table !== undefined) {
    const table = resolveTable(input.table);
    const rows = await queryTable(tx, table, input.since, limit);
    tables[table] = renderTable(rows);
    return { format: "pretty-table", tables };
  }

  const table = DEFAULT_TABLE;
  const rows = await queryTable(tx, table, input.since, limit);
  tables[table] = renderTable(rows);
  return { format: "pretty-table", tables };
}

// ---------------------------------------------------------------------
// Per-table query helper. Honors `since` only when the table exposes a
// timestamp column on the allowlist.
// ---------------------------------------------------------------------

async function queryTable(
  tx: Transaction,
  table: string,
  since: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const tsCol = tsColumnFor(table);
  if (since !== undefined && tsCol !== null && TS_FILTERED_TABLES.has(table)) {
    return await tx.queryAll<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE ${tsCol} >= ? LIMIT ?`,
      [since, limit],
    );
  }
  return await tx.queryAll<Record<string, unknown>>(`SELECT * FROM ${table} LIMIT ?`, [limit]);
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
