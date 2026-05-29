// Consistent textual snapshot of the kernel-owned tables + the apply
// half of restore.
//
// `dumpStateSql` emits a deterministic `.sql` dump — a journal-mode
// header (`PRAGMA journal_mode=WAL` + `wal_autocheckpoint`, for an
// external consumer; the kernel restore path skips them), then
// `CREATE TABLE` / `CREATE INDEX` DDL (read verbatim from sqlite_master,
// rewritten to `IF NOT EXISTS` so a replay into an already-migrated
// database is a no-op for the schema), then explicit-column `INSERT`
// statements with values serialized as SQL literals. Column order comes
// from `PRAGMA table_info` (cid order) and row order from `rowid`, so the
// same state dumps byte-identical every time. `kernel_schema_versions` is
// excluded — it is migration-managed and a target database already owns
// its row.
//
// `bypass_markers` IS dumped, `hmac` + `key_id` included: a marker
// restored against a rotated key is correctly invalid (its key_id no
// longer matches the active key), which is the intended TTL/rotation
// semantics — a restored escape hatch is not silently re-armed.
//
// `applyRestoreStatements` executes a pre-parsed, allowlisted statement
// list (the output of `parseRestoreSql`) in order inside the caller's tx.
// It never sees raw input — the classifier already refused anything
// outside the allowlist.
//
// Wall-clock discipline: the dump serializes whatever timestamps are
// already stored (themselves NowTokens); this module reads no clock.

import type { Transaction } from "../types/transaction.js";

// Order matters for the foreign-key edge agent_records.phase →
// phases(name): phases must be created and populated before agent_records.
const DUMP_TABLES: readonly string[] = [
  "installed_extensions",
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
  "bypass_markers",
  "audit",
  "kernel_idempotency_ledger",
];

interface MasterRow {
  name: unknown;
  sql: unknown;
}

interface TableInfoRow {
  name: unknown;
}

export async function dumpStateSql(tx: Transaction): Promise<string> {
  const lines: string[] = [];

  // 0. Journal-mode header. A `journal_mode` switch cannot run inside a
  //    BEGIN IMMEDIATE tx, so `applyRestoreStatements` skips these on the
  //    kernel restore path (the target DB already sets WAL at open). They
  //    are emitted here so a dump consumed by an EXTERNAL tool (sqlite3
  //    CLI replaying the .sql at top level) carries the journal mode.
  lines.push("PRAGMA journal_mode=WAL;");
  lines.push("PRAGMA wal_autocheckpoint=4000;");

  // 1. CREATE TABLE DDL (verbatim, rewritten to IF NOT EXISTS).
  for (const table of DUMP_TABLES) {
    const ddl = await tableDdl(tx, table);
    if (ddl !== null) lines.push(`${ifNotExists(ddl, "TABLE")};`);
  }

  // 2. CREATE INDEX DDL for the explicit (non-auto) indexes.
  for (const table of DUMP_TABLES) {
    const idxRows = await tx.queryAll<MasterRow>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? " +
        "AND sql IS NOT NULL ORDER BY name",
      [table],
    );
    for (const row of idxRows) {
      if (row.sql === null) continue;
      lines.push(`${ifNotExists(String(row.sql), "INDEX")};`);
    }
  }

  // 3. INSERT rows, explicit column list, deterministic row order.
  for (const table of DUMP_TABLES) {
    const cols = await tableColumns(tx, table);
    if (cols.length === 0) continue;
    const colList = cols.join(", ");
    const rows = await tx.queryAll<Record<string, unknown>>(
      `SELECT ${colList} FROM ${table} ORDER BY rowid`,
    );
    for (const row of rows) {
      const values = cols.map((c) => sqlLiteral(row[c])).join(", ");
      lines.push(`INSERT INTO ${table} (${colList}) VALUES (${values});`);
    }
  }

  return `${lines.join("\n")}\n`;
}

// Execute the pre-validated statements in order. Caller guarantees they
// came through `parseRestoreSql` — this function does NOT re-validate.
//
// PRAGMA statements are SKIPPED: the only ones the allowlist accepts are
// `journal_mode=WAL` and `wal_autocheckpoint`, and a `journal_mode`
// switch is illegal inside the BEGIN IMMEDIATE this runs under. They are
// header hints for an external consumer; the kernel DB already sets both
// at open, so skipping them leaves the restore round-trip correct.
export async function applyRestoreStatements(
  tx: Transaction,
  statements: string[],
): Promise<void> {
  for (const stmt of statements) {
    if (/^PRAGMA\b/i.test(stmt)) continue;
    await tx.exec(stmt);
  }
}

async function tableDdl(tx: Transaction, table: string): Promise<string | null> {
  const row = await tx.queryRow<MasterRow>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  if (row === null || row.sql === null) return null;
  return String(row.sql);
}

async function tableColumns(tx: Transaction, table: string): Promise<string[]> {
  // table is drawn from the hard-coded DUMP_TABLES set, never caller input.
  const rows = await tx.queryAll<TableInfoRow>(`PRAGMA table_info(${table})`);
  return rows.map((r) => String(r.name));
}

// Rewrite `CREATE TABLE <name>` / `CREATE INDEX <name>` to the
// `IF NOT EXISTS` form so applying the dump to an already-migrated
// database leaves the schema untouched and only the rows land.
function ifNotExists(ddl: string, kind: "TABLE" | "INDEX"): string {
  if (/\bIF\s+NOT\s+EXISTS\b/i.test(ddl)) return ddl;
  const re = kind === "TABLE"
    ? /^CREATE\s+TABLE\s+/i
    : /^CREATE\s+(UNIQUE\s+)?INDEX\s+/i;
  return ddl.replace(re, (match) => `${match.trimEnd()} IF NOT EXISTS `);
}

// Serialize a column value as a SQL literal. Strings are single-quoted
// with the `''` escape; null is NULL; numbers / bigints are verbatim.
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  // No BLOB columns in the kernel schema; coerce defensively rather than
  // emit an unparseable literal.
  return `'${String(value).replace(/'/g, "''")}'`;
}
