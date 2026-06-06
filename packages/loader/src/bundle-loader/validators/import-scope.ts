// Rule 13 — BUNDLE_IMPORT_SCOPE_VIOLATION.
//
// A bundle reaching for the raw kernel `Transaction` type bypasses the
// `BundleScratchTx` façade and the invariant-rollback boundary that
// goes with it. The loader sweeps the bundle's source tree at start and
// refuses every way the raw handle could be named: a named import, the
// deeper `.../transaction` path, a re-export (`export { Transaction }
// from "@loomfsm/kernel"`), and a namespace import (`import * as K`) whose
// `K.Transaction` member access reaches the type indirectly. The sweep
// is bounded to the first 200 lines of each source file so a
// `Transaction` mention deep inside a fixture string or test docstring
// does not surface as a false positive.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { KernelError } from "@loomfsm/kernel";

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".loom",
  ".claude",
  ".turbo",
  "coverage",
]);

// Matches `import { ... Transaction ... } from "@loomfsm/kernel..."` and
// the more direct `from "@loomfsm/kernel/.../transaction"` path import.
// The leading verb is `import` OR `export` so a re-export
// (`export { Transaction } from "@loomfsm/kernel"`) — which hands the raw
// handle out the bundle's own barrel — is refused on the same footing.
const TRANSACTION_BINDING_RE =
  /(?:import|export)\s+(?:type\s+)?\{[^}]*\bTransaction\b[^}]*\}\s+from\s+["']@loomfsm\/kernel(?:\/[^"']*)?["']/;
const TRANSACTION_PATH_RE =
  /from\s+["']@loomfsm\/kernel\/(?:[^"']*\/)?(?:transaction|state\/transaction)(?:\.[a-z]+)?["']/;
// Namespace import — `import * as K from "@loomfsm/kernel..."` (or the
// `export * as K` re-export). The binding name is captured; a
// `K.Transaction` member access elsewhere in the file is the actual
// reach for the raw handle.
const TRANSACTION_NAMESPACE_RE =
  /(?:import|export)\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']@loomfsm\/kernel(?:\/[^"']*)?["']/g;

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Locate a `<ns>.Transaction` reach where `<ns>` was bound by a
// namespace import of `@loomfsm/kernel`. Returns the 1-based line of the
// member access (the real violation) or null when no namespace binding
// touches `Transaction` — a namespace import of some OTHER symbol is
// legitimate and must pass.
function namespaceTransactionLine(lines: string[]): number | null {
  const names: string[] = [];
  for (const line of lines) {
    TRANSACTION_NAMESPACE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TRANSACTION_NAMESPACE_RE.exec(line)) !== null) {
      if (m[1] !== undefined) names.push(m[1]);
    }
  }
  if (names.length === 0) return null;
  const memberRes = names.map(
    (n) => new RegExp(`\\b${escapeForRegExp(n)}\\.Transaction\\b`),
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (memberRes.some((re) => re.test(line))) return i + 1;
  }
  return null;
}

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
  const bindingOrPath =
    TRANSACTION_BINDING_RE.test(buffer) || TRANSACTION_PATH_RE.test(buffer);
  const nsLine = namespaceTransactionLine(lines);
  if (!bindingOrPath && nsLine === null) {
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
  // A namespace binding's `<ns>.Transaction` reach — point at the
  // member-access line, which is where the raw handle is actually
  // grabbed.
  if (nsLine !== null) {
    out.push({ path, line: nsLine, match: (lines[nsLine - 1] ?? "").trim() });
    return;
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
