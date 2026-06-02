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

import { extractInsertTable, KERNEL_OWNED_TABLES } from "./ddl-allowlist.js";

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
//
// Forward-compat column projection: an INSERT into a kernel-owned table is
// reshaped against the LIVE schema (PRAGMA table_info) — any column the dump
// names that the current table no longer has is dropped along with its value.
// A dump captured before a column-removal migration carries the retired
// column in its INSERT; the dump's own `CREATE TABLE IF NOT EXISTS` no-ops
// against the already-migrated table, so without this the stale column would
// hit a "no such column" on apply. The projection is generic — it names no
// column — so it covers ANY past or future column drop, not one field. Adding
// a column is the symmetric case and needs nothing: an older dump simply omits
// the new column and the table default fills it.
export async function applyRestoreStatements(
  tx: Transaction,
  statements: string[],
): Promise<void> {
  const liveColsByTable = new Map<string, Set<string>>();
  for (const stmt of statements) {
    if (/^PRAGMA\b/i.test(stmt)) continue;
    const toRun = /^INSERT\s+INTO\b/i.test(stmt)
      ? await projectInsertToLiveSchema(tx, stmt, liveColsByTable)
      : stmt;
    await tx.exec(toRun);
  }
}

// Reshape an `INSERT INTO <kernel table> (cols) VALUES (vals)` so its column
// list is the intersection of the dump's columns and the live table's
// columns, in the dump's order. Returns the statement unchanged when it is
// not a recognizable single-row INSERT into a kernel-owned table, when no
// column needs dropping, or when the parse is ambiguous (a degenerate shape
// is left to fail loud rather than silently rewritten wrong).
async function projectInsertToLiveSchema(
  tx: Transaction,
  stmt: string,
  cache: Map<string, Set<string>>,
): Promise<string> {
  const table = extractInsertTable(stmt);
  if (table === null || !KERNEL_OWNED_TABLES.has(table)) return stmt;

  let liveCols = cache.get(table);
  if (liveCols === undefined) {
    // table is from the validated kernel-owned set, never caller input.
    const rows = await tx.queryAll<{ name: unknown }>(`PRAGMA table_info(${table})`);
    liveCols = new Set(rows.map((r) => String(r.name)));
    cache.set(table, liveCols);
  }

  const open1 = stmt.indexOf("(");
  if (open1 === -1) return stmt;
  const close1 = matchParen(stmt, open1);
  if (close1 === -1) return stmt;
  const valuesKw = /^\s*VALUES\s*\(/i.exec(stmt.slice(close1 + 1));
  if (valuesKw === null) return stmt;
  const open2 = close1 + valuesKw[0].length; // index of the VALUES '('
  const close2 = matchParen(stmt, open2);
  if (close2 === -1) return stmt;

  const cols = splitListItems(stmt.slice(open1 + 1, close1)).map(stripIdentifier);
  const vals = splitListItems(stmt.slice(open2 + 1, close2));
  if (cols.length === 0 || cols.length !== vals.length) return stmt;

  const keep: number[] = [];
  for (let i = 0; i < cols.length; i += 1) {
    if (liveCols.has(cols[i] as string)) keep.push(i);
  }
  if (keep.length === cols.length || keep.length === 0) return stmt;

  const head = stmt.slice(0, open1);
  const tail = stmt.slice(close2 + 1);
  const newCols = keep.map((i) => cols[i]).join(", ");
  const newVals = keep.map((i) => vals[i]).join(", ");
  return `${head}(${newCols}) VALUES (${newVals})${tail}`;
}

// Index of the `)` that closes the `(` at `open`, honoring single-quote
// string literals (with the SQL `''` escape) so a paren inside a value does
// not throw off the depth count. -1 when unbalanced.
function matchParen(s: string, open: number): number {
  let depth = 0;
  let i = open;
  const n = s.length;
  while (i < n) {
    const ch = s[i] as string;
    if (ch === "'") {
      i += 1;
      while (i < n) {
        const c = s[i] as string;
        i += 1;
        if (c === "'") {
          if (i < n && s[i] === "'") { i += 1; continue; }
          break;
        }
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// Split a parenthesized list body on top-level commas, honoring single-quote
// string literals (with the `''` escape) so a comma inside a value does not
// split it. Trims each item; mirrors the scanner in ddl-allowlist.ts.
function splitListItems(body: string): string[] {
  const items: string[] = [];
  let buf = "";
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i] as string;
    if (ch === "'") {
      buf += ch;
      i += 1;
      while (i < n) {
        const c = body[i] as string;
        buf += c;
        i += 1;
        if (c === "'") {
          if (i < n && body[i] === "'") { buf += "'"; i += 1; continue; }
          break;
        }
      }
      continue;
    }
    if (ch === ",") {
      items.push(buf.trim());
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  items.push(buf.trim());
  return items;
}

// Strip an optional surrounding quote/backtick pair from a column identifier.
// The kernel dump emits bare identifiers; this is defensive only.
function stripIdentifier(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && /^(["'`]).*\1$/.test(t)) return t.slice(1, -1);
  return t;
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
