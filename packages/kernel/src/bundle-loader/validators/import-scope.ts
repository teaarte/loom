// Rule 13 — BUNDLE_IMPORT_SCOPE_VIOLATION.
//
// A bundle reaching for the raw kernel `Transaction` type bypasses the
// `BundleScratchTx` façade and the invariant-rollback boundary that
// goes with it. The loader sweeps the bundle's source tree at start
// and refuses any import that names `Transaction` from `@loom/kernel`
// or pulls it through the deeper path. The sweep is bounded to the
// first 200 lines of each source file so a `Transaction` mention deep
// inside a fixture string or test docstring does not surface as a
// false positive.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { KernelError } from "../../state/db.js";

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".claude",
  ".turbo",
  "coverage",
]);

// Matches `import { ... Transaction ... } from "@loom/kernel..."` and
// the more direct `from "@loom/kernel/.../transaction"` path import.
const TRANSACTION_BINDING_RE =
  /import\s+(?:type\s+)?\{[^}]*\bTransaction\b[^}]*\}\s+from\s+["']@loom\/kernel(?:\/[^"']*)?["']/;
const TRANSACTION_PATH_RE =
  /from\s+["']@loom\/kernel\/(?:[^"']*\/)?(?:transaction|state\/transaction)(?:\.[a-z]+)?["']/;

interface ImportViolation {
  path: string;
  line: number;
  match: string;
}

export function validateImportScope(dir: string): void {
  const violations: ImportViolation[] = [];
  scanDir(dir, violations);
  if (violations.length > 0) {
    throw new KernelError({
      code: "BUNDLE_IMPORT_SCOPE_VIOLATION",
      message: `bundle source imports the raw kernel Transaction type — bundle code must mutate through BundleScratchTx`,
      detail: { violations },
    });
  }
}

function scanDir(dir: string, out: ImportViolation[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SCAN_SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) {
      scanDir(full, out);
      continue;
    }
    if (!isFile) continue;
    const ext = extname(entry).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    scanFile(full, out);
  }
}

function scanFile(path: string, out: ImportViolation[]): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/, 200);
  // Walk lines from the top; the import block of a source file is
  // conventionally at the head, so a top-bounded sweep avoids matches
  // inside large fixture strings further down.
  let buffer = "";
  for (let i = 0; i < lines.length; i++) {
    buffer += (lines[i] ?? "") + "\n";
  }
  if (!TRANSACTION_BINDING_RE.test(buffer) && !TRANSACTION_PATH_RE.test(buffer)) {
    return;
  }
  // Locate the first matching line for the operator's debugging note.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (TRANSACTION_BINDING_RE.test(line) || TRANSACTION_PATH_RE.test(line)) {
      out.push({ path, line: i + 1, match: line.trim() });
      return;
    }
  }
  // Multi-line import — fall back to first line that mentions Transaction.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("Transaction")) {
      out.push({ path, line: i + 1, match: line.trim() });
      return;
    }
  }
}
