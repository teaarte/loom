// Best-effort lint for ambient wall-clock reads.
//
// Replay determinism is load-bearing: a `Date.now()` / `new Date()`
// call inside the kernel transaction graph reads the host clock,
// which makes the same input → same output contract silently false
// across the original commit and any replay. The lint catches the
// usual JS forms plus the three SQLite-side equivalents.
//
// Comment-only mentions are ignored — kernel source comments describe
// the rule, and matching against them would force authors to talk
// around the very thing the lint protects. The scanner strips
// single-line and block comments before applying patterns; string-
// literal contents survive (a SQL fragment with datetime('now')
// inside a quoted string SHOULD trip the lint).
//
// Allowed call sites carry a `// allow-ambient-clock: <reason>`
// marker on the same physical line as the call — that lets future
// readers see the exception in context rather than chasing an
// external allow-list. The current exceptions are the mint-time
// fallback in ids.ts, the captureNow read in state/db.ts, and the
// migration applied_at stamp also in state/db.ts; plus the
// NowToken-parsing helpers in invariants.ts and guards.ts whose
// `Date` use operates on the supplied string, not the host clock.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const REPO_PACKAGES = resolve(PKG_ROOT, "..");

const PATTERNS = [
  { name: "Date.now()", regex: /Date\.now\s*\(/ },
  { name: "new Date()", regex: /new\s+Date\s*\(/ },
  { name: "datetime('now')", regex: /datetime\s*\(\s*['"]now['"]/ },
  { name: "strftime(..., 'now')", regex: /strftime\s*\([^)]*['"]now['"]/ },
  { name: "julianday('now')", regex: /julianday\s*\(\s*['"]now['"]/ },
];

const ALLOW_MARKER = /\/\/\s*allow-ambient-clock\b/;

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return out;
    throw err;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      out.push(...(await walk(full)));
    } else if (ent.isFile() && ent.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

async function bundleSrcRoots() {
  const out = [];
  const bundlesDir = join(REPO_PACKAGES, "bundles");
  let st;
  try {
    st = await stat(bundlesDir);
  } catch {
    return out;
  }
  if (!st.isDirectory()) return out;
  const subs = await readdir(bundlesDir, { withFileTypes: true });
  for (const sub of subs) {
    if (!sub.isDirectory()) continue;
    out.push(join(bundlesDir, sub.name, "src"));
  }
  return out;
}

// Strip TypeScript comments from a line while tracking whether the
// previous line ended inside a `/* */` block. Single-line `// ...`
// comments are dropped from the offset where they begin; block
// comments are tracked across lines via the `inBlock` state. String
// literals are NOT stripped — a SQL fragment carrying a wall-clock
// read inside a quoted string should still trip the lint.
function stripCommentsForScan(line, state) {
  let out = "";
  let i = 0;
  let inString = null; // null | "'" | '"' | "`"
  let inBlock = state.inBlock;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString !== null) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      // Rest of line is a comment.
      break;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  state.inBlock = inBlock;
  return out;
}

async function main() {
  const roots = [join(PKG_ROOT, "src"), ...(await bundleSrcRoots())];
  const files = [];
  for (const root of roots) files.push(...(await walk(root)));

  const hits = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const lines = raw.split(/\r?\n/);
    const state = { inBlock: false };
    for (let i = 0; i < lines.length; i++) {
      const original = lines[i];
      const code = stripCommentsForScan(original, state);
      if (code.length === 0) continue;
      for (const { name, regex } of PATTERNS) {
        if (!regex.test(code)) continue;
        if (ALLOW_MARKER.test(original)) continue;
        hits.push({
          file: relative(process.cwd(), file),
          line: i + 1,
          pattern: name,
          excerpt: original.trim().slice(0, 160),
        });
      }
    }
  }

  if (hits.length === 0) {
    process.exit(0);
  }
  for (const h of hits) {
    process.stderr.write(
      `${h.file}:${h.line}: ambient clock read (${h.pattern}) — use tx.now\n  ${h.excerpt}\n`,
    );
  }
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`lint:no-ambient-clock crashed: ${err.stack ?? err}\n`);
  process.exit(2);
});
