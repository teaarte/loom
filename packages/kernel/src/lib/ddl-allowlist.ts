// Restore DDL allowlist — the statement classifier a restore runs an
// untrusted dump through BEFORE touching the connection.
//
// A backup file is untrusted input: a hostile or corrupt dump must never
// reach `db.exec(rawSql)`. This module splits the dump into statements
// (string-aware, so a `;` inside a quoted literal does not split) and
// classifies each one against a fixed allowlist. The first statement
// that falls outside the allowlist throws
// `KernelError({code:"RESTORE_REJECTED"})` naming the offender — a hard
// refusal, never a warning.
//
// Allowed: CREATE TABLE / CREATE INDEX on a kernel-owned table,
// INSERT INTO a kernel-owned table, `PRAGMA journal_mode=WAL`, and
// `PRAGMA wal_autocheckpoint`. Everything else — ATTACH, DETACH,
// load_extension, PRAGMA locking_mode, PRAGMA foreign_keys=OFF, any
// UPDATE / DELETE / DROP / ALTER, any statement carrying a host-clock
// function (datetime('now'), strftime(..., 'now'), julianday('now')), and
// any INSERT / CREATE targeting a non-kernel table — is refused by
// default-deny.
//
// Scope: this is a statement splitter plus a per-statement keyword +
// table-name classifier, NOT a full SQL grammar. It is deliberately
// conservative — an ambiguous statement is refused, not parsed.

import { KernelError } from "../state/db.js";

// Kernel-owned table set. CREATE / INSERT against any other name is
// refused so a dump cannot plant a side table or overwrite host data.
export const KERNEL_OWNED_TABLES: ReadonlySet<string> = new Set([
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
  "installed_extensions",
  "kernel_schema_versions",
]);

// Host-clock functions: a stored timestamp must come from the captured
// NowToken, never the wall clock — a clock call inside a restored row
// would diverge from the original commit on replay.
const HOST_CLOCK_RE =
  /\b(?:datetime|strftime|julianday)\s*\([^)]*'now'/i;

const LOAD_EXTENSION_RE = /\bload_extension\s*\(/i;

export interface ParseRestoreSqlOptions {
  // Override the kernel-owned table set (bundle-migration validation
  // passes its own table allowlist). Defaults to the kernel set above.
  ownedTables?: ReadonlySet<string>;
}

// Parse + classify a dump. Returns the ordered allowed statements (trimmed,
// no trailing `;`); throws on the first offender.
export function parseRestoreSql(
  sql: string,
  opts?: ParseRestoreSqlOptions,
): string[] {
  const owned = opts?.ownedTables ?? KERNEL_OWNED_TABLES;
  const statements = splitStatements(sql);
  const out: string[] = [];
  for (const stmt of statements) {
    classify(stmt, owned);
    out.push(stmt);
  }
  return out;
}

// String-aware split on `;`. Tracks single-quote string literals (with
// the SQL `''` escape) and `--` / `/* */` comments so a delimiter inside
// any of them does not split the statement.
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i] as string;
    const next = i + 1 < n ? (sql[i + 1] as string) : "";

    if (ch === "'") {
      // Consume the whole literal, honoring the '' escape.
      buf += ch;
      i += 1;
      while (i < n) {
        const c = sql[i] as string;
        buf += c;
        i += 1;
        if (c === "'") {
          if (i < n && sql[i] === "'") {
            buf += "'";
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      // Line comment to end of line.
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      // Block comment to the closing */.
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    if (ch === ";") {
      const trimmed = buf.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      buf = "";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function classify(stmt: string, owned: ReadonlySet<string>): void {
  // A host-clock call anywhere in the statement is fatal regardless of
  // the statement's shape — an otherwise-allowed INSERT carrying
  // datetime('now') is still refused.
  if (HOST_CLOCK_RE.test(stmt)) {
    throw reject(stmt, "host-clock function is not permitted in a restored statement");
  }
  if (LOAD_EXTENSION_RE.test(stmt)) {
    throw reject(stmt, "load_extension is not permitted");
  }

  const upper = stmt.toUpperCase();

  if (upper.startsWith("ATTACH") || upper.startsWith("DETACH")) {
    throw reject(stmt, "ATTACH/DETACH is not permitted");
  }

  if (upper.startsWith("PRAGMA")) {
    if (/^PRAGMA\s+JOURNAL_MODE\s*=\s*WAL\b/i.test(stmt)) return;
    if (/^PRAGMA\s+WAL_AUTOCHECKPOINT\b/i.test(stmt)) return;
    throw reject(stmt, "only PRAGMA journal_mode=WAL and PRAGMA wal_autocheckpoint are permitted");
  }

  if (upper.startsWith("CREATE TABLE")) {
    const name = extractCreateTableName(stmt);
    if (name !== null && owned.has(name)) return;
    throw reject(stmt, `CREATE TABLE targets a non-kernel table '${name ?? "?"}'`);
  }

  if (upper.startsWith("CREATE INDEX") || upper.startsWith("CREATE UNIQUE INDEX")) {
    const table = extractIndexTable(stmt);
    if (table !== null && owned.has(table)) return;
    throw reject(stmt, `CREATE INDEX targets a non-kernel table '${table ?? "?"}'`);
  }

  if (upper.startsWith("INSERT INTO")) {
    const name = extractInsertTable(stmt);
    if (name !== null && owned.has(name)) return;
    throw reject(stmt, `INSERT targets a non-kernel table '${name ?? "?"}'`);
  }

  // Default-deny: UPDATE / DELETE / DROP / ALTER and anything else.
  throw reject(stmt, "statement is outside the restore allowlist");
}

function extractCreateTableName(stmt: string): string | null {
  const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
    stmt,
  );
  return m && m[1] !== undefined ? m[1] : null;
}

function extractIndexTable(stmt: string): string | null {
  const m = /\bON\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(stmt);
  return m && m[1] !== undefined ? m[1] : null;
}

export function extractInsertTable(stmt: string): string | null {
  const m = /^INSERT\s+INTO\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)/i.exec(stmt);
  return m && m[1] !== undefined ? m[1] : null;
}

function reject(stmt: string, why: string): KernelError {
  const offender = stmt.length > 120 ? `${stmt.slice(0, 117)}...` : stmt;
  return new KernelError({
    code: "RESTORE_REJECTED",
    message: `${why}: ${offender}`,
    detail: { statement: offender, reason: why },
  });
}
