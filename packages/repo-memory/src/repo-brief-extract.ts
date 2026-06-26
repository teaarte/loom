// Pure structural extraction + brief rendering for the persistent repo-brief.
//
// No I/O, no clock, no git here — the caller (`repo-brief.ts`) owns reading the
// tree and persisting the result. These are deterministic functions of their
// inputs so the brief is byte-identical for an unchanged tree (the "empty
// changed set → reuse" property the cache relies on) and trivially unit-tested.
//
// The extractors are intentionally LIGHTWEIGHT (line/regex heuristics, no
// parser dependency): a structural map with real `file:line` anchors the
// planner cites instead of cold-reading. They degrade silently on exotic syntax
// — a missed declaration only costs the planner a cold read of that one span,
// never a wrong decision (the brief is ambient, outside the kernel's replay).

// A captured top-level declaration. `exported` marks the public surface (an
// `export` in TS, an uppercase Go name, a `pub` in Rust, a non-underscore
// Python name) so the renderer can foreground contracts over internals.
export interface ExtractedSymbol {
  name: string;
  kind:
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "function"
    | "const"
    | "struct"
    | "trait"
    | "module";
  line: number; // 1-based
  exported: boolean;
  // The trimmed declaration line (capped) — kept only for exported symbols to
  // bound the brief's size; internals carry just a name + line anchor.
  signature?: string;
}

export interface FileEntry {
  path: string; // repo-relative, posix
  lang: string; // "ts" | "py" | "go" | … | "other"
  symbols: ExtractedSymbol[];
  loc: number; // line count
  // Intra-repo modules this file imports, as normalized extension-stripped
  // repo-relative target keys (e.g. `src/foo` for `import "./foo.js"`). Used to
  // build a module-reference graph so the brief ranks the most depended-upon
  // files first. Captured for the TS/JS family; empty/absent elsewhere (a
  // best-effort signal — its absence only weakens ranking, never breaks it).
  imports?: readonly string[];
  skipped?: boolean; // present but not extracted (too large / binary)
}

export interface StackFacts {
  languages: ReadonlyArray<{ lang: string; files: number }>;
  packageManager?: string;
  commands: ReadonlyArray<{ name: string; command: string }>;
  frameworks: readonly string[];
  monorepo?: boolean;
}

const SIG_CAP = 140;
const MAX_SYMBOLS_PER_FILE = 250;

// Extension → language label. Anything unlisted is "other" (recorded in the
// layout / counts but not symbol-extracted).
const LANG_BY_EXT: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  py: "py",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  scala: "scala",
};

// Files with no useful structure that are also frequently huge — recorded in
// the file count but never read for extraction.
const SKIP_EXTRACT_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "composer.lock",
  "Cargo.lock",
  "go.sum",
]);

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function langOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "other";
  return LANG_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? "other";
}

export function shouldExtract(path: string): boolean {
  const base = basename(path);
  if (SKIP_EXTRACT_BASENAMES.has(base)) return false;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return false;
  return langOf(path) !== "other";
}

function cap(line: string): string {
  const t = line.trim().replace(/\s*\{\s*$/, "").trim();
  return t.length > SIG_CAP ? `${t.slice(0, SIG_CAP - 1)}…` : t;
}

// ----- import graph (TS/JS) --------------------------------------------------
//
// Cheap module-reference extraction: capture intra-repo relative imports so the
// renderer can rank the most depended-upon files first (a degree-centrality
// proxy — aider's file-reference graph idea without the parser). Best-effort and
// incremental: an import list rides on the file's cached entry, so ranking is
// recomputed from the cache each render with no whole-tree re-scan.

const MAX_IMPORTS_PER_FILE = 200;
const CODE_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function stripCodeExt(path: string): string {
  return path.replace(CODE_EXT, "");
}

// Resolve `..`/`.` segments in a posix relative path. Pure string math (no fs).
function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(part);
    }
  }
  return out.join("/");
}

const IMPORT_FROM = /\bfrom\s+['"]([^'"]+)['"]/g;
const IMPORT_BARE = /^\s*import\s+['"]([^'"]+)['"]/;
const REQUIRE_CALL = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYN_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

// Extract the intra-repo (relative) import targets of a TS/JS file, normalized
// to extension-stripped repo-relative keys resolved against the file's own dir.
// Bare/package specifiers (not starting with `.`) are external → dropped.
function extractImports(path: string, lines: string[]): string[] {
  const dir = dirOf(path);
  const targets = new Set<string>();
  const add = (spec: string): void => {
    if (!spec.startsWith(".")) return; // external/package import
    const resolved = normalizePosix(`${dir}/${spec}`);
    if (resolved.length > 0) targets.add(stripCodeExt(resolved));
  };
  for (const raw of lines) {
    let m: RegExpExecArray | null;
    IMPORT_FROM.lastIndex = 0;
    while ((m = IMPORT_FROM.exec(raw)) !== null) if (m[1] !== undefined) add(m[1]);
    const bare = IMPORT_BARE.exec(raw);
    if (bare?.[1] !== undefined) add(bare[1]);
    REQUIRE_CALL.lastIndex = 0;
    while ((m = REQUIRE_CALL.exec(raw)) !== null) if (m[1] !== undefined) add(m[1]);
    DYN_IMPORT.lastIndex = 0;
    while ((m = DYN_IMPORT.exec(raw)) !== null) if (m[1] !== undefined) add(m[1]);
    if (targets.size >= MAX_IMPORTS_PER_FILE) break;
  }
  return [...targets];
}

// ----- per-language extractors ----------------------------------------------

const TS_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/;

function extractTsLike(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trimStart();
    const topLevel = raw.length === trimmed.length; // no leading whitespace
    const exported = /^export\b/.test(trimmed);
    if (!topLevel && !exported) continue;
    const m = TS_DECL.exec(trimmed);
    if (m === null) continue;
    const kw = m[1] ?? "";
    const name = m[2] ?? "";
    let kind: ExtractedSymbol["kind"];
    if (kw === "class") kind = "class";
    else if (kw === "interface") kind = "interface";
    else if (kw === "type") kind = "type";
    else if (kw === "enum") kind = "enum";
    else if (kw.startsWith("function")) kind = "function";
    else kind = "const"; // const | let | var
    // Internal const/let/var is noise — keep value-bindings only when exported.
    if (kind === "const" && !exported) continue;
    out.push({ name, kind, line: i + 1, exported, ...(exported ? { signature: cap(trimmed) } : {}) });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

const PY_DECL = /^(class|def|async\s+def)\s+([A-Za-z_]\w*)/;

function extractPy(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.length !== raw.trimStart().length) continue; // top-level only
    const m = PY_DECL.exec(raw);
    if (m === null) continue;
    const name = m[2] ?? "";
    const kind: ExtractedSymbol["kind"] = (m[1] ?? "").startsWith("class") ? "class" : "function";
    const exported = !name.startsWith("_");
    out.push({ name, kind, line: i + 1, exported, ...(exported ? { signature: cap(raw) } : {}) });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

const GO_FUNC = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/;
const GO_TYPE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)?/;

function extractGo(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const fn = GO_FUNC.exec(raw);
    const ty = fn === null ? GO_TYPE.exec(raw) : null;
    const name = (fn?.[1] ?? ty?.[1]) ?? "";
    if (name === "") continue;
    const exported = /^[A-Z]/.test(name);
    let kind: ExtractedSymbol["kind"] = "function";
    if (ty !== null) kind = ty[2] === "struct" ? "struct" : ty[2] === "interface" ? "interface" : "type";
    out.push({ name, kind, line: i + 1, exported, ...(exported ? { signature: cap(raw) } : {}) });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

const RUST_DECL = /^(pub(?:\([^)]*\))?\s+)?(fn|struct|trait|enum|type|mod)\s+([A-Za-z_]\w*)/;

function extractRust(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trimStart();
    const m = RUST_DECL.exec(raw);
    if (m === null) continue;
    const exported = m[1] !== undefined;
    const kw = m[2] ?? "";
    const name = m[3] ?? "";
    const kind: ExtractedSymbol["kind"] =
      kw === "fn"
        ? "function"
        : kw === "struct"
          ? "struct"
          : kw === "trait"
            ? "trait"
            : kw === "enum"
              ? "enum"
              : kw === "mod"
                ? "module"
                : "type";
    if (!exported) continue; // Rust files are noisy; the public surface is the signal.
    out.push({ name, kind, line: i + 1, exported, signature: cap(raw) });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

const JVM_DECL =
  /^(?:(?:public|private|protected|abstract|final|static|sealed|internal|partial)\s+)*(class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/;

function extractJvmLike(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trimStart();
    const m = JVM_DECL.exec(raw);
    if (m === null) continue;
    const kw = m[1] ?? "";
    const name = m[2] ?? "";
    const exported = /\bpublic\b/.test(lines[i] ?? "");
    const kind: ExtractedSymbol["kind"] =
      kw === "interface" ? "interface" : kw === "enum" ? "enum" : kw === "struct" ? "struct" : "class";
    out.push({ name, kind, line: i + 1, exported, ...(exported ? { signature: cap(raw) } : {}) });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

const RUBY_DECL = /^(class|module|def)\s+([A-Za-z_][\w:]*[?!]?)/;

function extractRuby(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (raw.length !== raw.trimStart().length) continue;
    const m = RUBY_DECL.exec(raw);
    if (m === null) continue;
    const kw = m[1] ?? "";
    const name = m[2] ?? "";
    const kind: ExtractedSymbol["kind"] = kw === "class" ? "class" : kw === "module" ? "module" : "function";
    out.push({ name, kind, line: i + 1, exported: true, signature: cap(raw) });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

const PHP_TYPE = /^(?:abstract\s+|final\s+)?(class|interface|trait)\s+([A-Za-z_]\w*)/;
const PHP_FUNC = /^function\s+([A-Za-z_]\w*)/;

function extractPhp(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trimStart();
    const ty = PHP_TYPE.exec(raw);
    const fn = ty === null ? PHP_FUNC.exec(raw) : null;
    const name = (ty?.[2] ?? fn?.[1]) ?? "";
    if (name === "") continue;
    const kind: ExtractedSymbol["kind"] =
      ty === null ? "function" : ty[1] === "interface" ? "interface" : ty[1] === "trait" ? "trait" : "class";
    out.push({ name, kind, line: i + 1, exported: true, signature: cap(raw) });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

// Extract a file's top-level declarations from its text. The path's language
// chooses the extractor; an unknown language returns no symbols (the file still
// counts toward the layout). Pure: same (path, content) → same symbols.
export function extractFile(path: string, content: string): FileEntry {
  const lang = langOf(path);
  const lines = content.split("\n");
  const loc = lines.length;
  let symbols: ExtractedSymbol[] = [];
  let imports: string[] = [];
  switch (lang) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      symbols = extractTsLike(lines);
      imports = extractImports(path, lines);
      break;
    case "py":
      symbols = extractPy(lines);
      break;
    case "go":
      symbols = extractGo(lines);
      break;
    case "rust":
      symbols = extractRust(lines);
      break;
    case "java":
    case "kotlin":
    case "csharp":
    case "scala":
      symbols = extractJvmLike(lines);
      break;
    case "ruby":
      symbols = extractRuby(lines);
      break;
    case "php":
      symbols = extractPhp(lines);
      break;
    default:
      symbols = [];
  }
  return { path, lang, symbols, loc, ...(imports.length > 0 ? { imports } : {}) };
}

// ----- module-reference ranking ----------------------------------------------

// In-degree per file: how many OTHER files import it (a degree-centrality proxy
// for importance). Pure function of the entries' cached import lists — no tree
// re-scan. A file addressable as `dir/index.*` is matched by an import of `dir`
// too, mirroring how the module resolver treats an index file.
export function computeInDegree(entries: readonly FileEntry[]): Map<string, number> {
  // addressable key → the entry paths reachable under that key.
  const keyToPaths = new Map<string, string[]>();
  const addKey = (key: string, path: string): void => {
    const list = keyToPaths.get(key);
    if (list === undefined) keyToPaths.set(key, [path]);
    else if (!list.includes(path)) list.push(path);
  };
  for (const e of entries) {
    addKey(stripCodeExt(e.path), e.path);
    if (/^index\./.test(basename(e.path))) addKey(dirOf(e.path), e.path);
  }
  const inDeg = new Map<string, number>();
  for (const e of entries) {
    if (e.imports === undefined) continue;
    const counted = new Set<string>(); // one importer counts a target at most once
    for (const target of e.imports) {
      for (const dest of keyToPaths.get(target) ?? []) {
        if (dest === e.path || counted.has(dest)) continue;
        counted.add(dest);
        inDeg.set(dest, (inDeg.get(dest) ?? 0) + 1);
      }
    }
  }
  return inDeg;
}

// ----- rendering -------------------------------------------------------------

export interface RenderInput {
  entries: readonly FileEntry[]; // already sorted by path
  stackFacts: StackFacts;
  fileCount: number;
  tokenBudget: number;
}

export interface RenderResult {
  markdown: string;
  truncated: boolean;
  omittedFiles: number;
}

const TYPE_KINDS = new Set<ExtractedSymbol["kind"]>(["interface", "type", "enum", "struct", "trait"]);

// Rough token estimate — 4 chars/token. Only used to decide truncation; the
// brief is plain text so an approximate budget is fine.
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderLayout(entries: readonly FileEntry[]): string {
  const byDir = new Map<string, number>();
  for (const e of entries) {
    const i = e.path.lastIndexOf("/");
    const dir = i === -1 ? "." : e.path.slice(0, i);
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const dirs = [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = dirs.map(([dir, n]) => `${dir === "." ? "(root)" : dir}  —  ${n} file${n === 1 ? "" : "s"}`);
  return lines.join("\n");
}

function renderStack(s: StackFacts): string {
  const lines: string[] = [];
  const langs = s.languages.map((l) => `${l.lang} (${l.files})`).join(", ");
  if (langs.length > 0) lines.push(`- Languages: ${langs}`);
  if (s.monorepo === true) lines.push(`- Layout: monorepo`);
  if (s.packageManager !== undefined) lines.push(`- Package manager: ${s.packageManager}`);
  for (const c of s.commands) lines.push(`- ${c.name}: \`${c.command}\``);
  if (s.frameworks.length > 0) lines.push(`- Frameworks/libraries: ${s.frameworks.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : "- (no stack markers detected)";
}

// Fraction of the token budget the ranked Public-API section may use before the
// (secondary) flat type index is allowed to fill the remainder. Keeps the
// per-file ranked map — the high-signal part — from being starved by a long
// type list on a large repo, while still leaving room for the lookup index.
const API_BUDGET_FRACTION = 0.85;

// One file's Public-API block: a heading carrying its dependent count, then its
// symbols (exported first) with file:line anchors and signatures.
function renderFileSection(e: FileEntry, dependents: number): string {
  const heading =
    dependents > 0
      ? `### ${e.path}  (${dependents} dependent${dependents === 1 ? "" : "s"})`
      : `### ${e.path}`;
  const lines = [heading];
  for (const s of e.symbols) {
    const sig = s.signature !== undefined ? ` — \`${s.signature}\`` : "";
    lines.push(`- \`${s.name}\` (${s.kind}):${s.line}${sig}`);
  }
  return `${lines.join("\n")}\n\n`;
}

// Render the brief, IMPORTANCE-RANKED and BUDGETED. Everything is ordered by
// module in-degree (how many other files import a file) so the most
// depended-upon contracts survive a tight budget instead of an arbitrary order.
// The budget is spent in priority order:
//   1. header + stack + layout (always — small and essential);
//   2. the per-file Public-API map (ranked) — the high-signal part, gets most
//      of the budget;
//   3. a flat key-types index (ranked, importance-first) — fills the remainder.
// Each section drops its overflow with an explicit omission note (never a silent
// truncation). Counting EVERY section against the budget is load-bearing: an
// un-budgeted section (an earlier bug) starves the ranked map on a large repo.
export function renderBrief(input: RenderInput): RenderResult {
  const { entries, stackFacts, fileCount, tokenBudget } = input;
  const inDeg = computeInDegree(entries);

  const headerBlock = [
    "# Repo structural brief",
    "",
    `> Deterministic structural map of ${fileCount} tracked file${fileCount === 1 ? "" : "s"}, maintained by loom across runs.`,
    "> Cite `file:line` from this brief instead of cold-reading the tree. Open ONLY the files listed in",
    "> `.loom/work/repo-brief.changed.txt` (changed since loom last indexed this repo); trust this brief for the rest.",
    "",
    "## Stack",
    renderStack(stackFacts),
    "",
    "## Layout",
    "```",
    renderLayout(entries),
    "```",
    "",
  ].join("\n");

  let used = approxTokens(headerBlock);

  // 2. Public API (by file), ranked by importance — gets budget priority.
  const ranked = [...entries]
    .map((e) => ({ e, dependents: inDeg.get(e.path) ?? 0, exported: e.symbols.filter((s) => s.exported).length }))
    .filter((r) => r.e.symbols.length > 0)
    .sort((a, b) => b.dependents - a.dependents || b.exported - a.exported || a.e.path.localeCompare(b.e.path));

  const apiHeading = "\n## Public API (by file, most depended-upon first)\n";
  used += approxTokens(apiHeading);
  const apiBudget = Math.floor(tokenBudget * API_BUDGET_FRACTION);
  let apiBody = "";
  let apiOmitted = 0;
  for (const { e, dependents } of ranked) {
    const section = renderFileSection(e, dependents);
    const cost = approxTokens(section);
    if (used + cost > apiBudget) {
      apiOmitted += 1;
      continue;
    }
    apiBody += section;
    used += cost;
  }

  // 3. Key-types index — interfaces/types/enums/structs/traits, ranked by the
  // importance of the file they live in, filling the remaining budget.
  const typeSymbols: Array<{ s: ExtractedSymbol; path: string; dep: number }> = [];
  for (const e of entries) {
    const dep = inDeg.get(e.path) ?? 0;
    for (const s of e.symbols) {
      if (TYPE_KINDS.has(s.kind) && s.exported) typeSymbols.push({ s, path: e.path, dep });
    }
  }
  typeSymbols.sort(
    (a, b) => b.dep - a.dep || a.s.name.localeCompare(b.s.name) || a.path.localeCompare(b.path),
  );
  const typesHeading = "\n## Key types & interfaces (index)\n";
  used += approxTokens(typesHeading);
  let typesBody = "";
  let typesOmitted = 0;
  for (const { s, path } of typeSymbols) {
    const line = `- \`${s.name}\` (${s.kind}) — ${path}:${s.line}\n`;
    const cost = approxTokens(line);
    if (used + cost > tokenBudget) {
      typesOmitted += 1;
      continue;
    }
    typesBody += line;
    used += cost;
  }

  const truncated = apiOmitted > 0 || typesOmitted > 0;
  let markdown =
    headerBlock +
    apiHeading +
    (apiBody.length > 0 ? apiBody : "- (no exported symbols detected)\n") +
    typesHeading +
    (typesBody.length > 0 ? typesBody : "- (omitted to fit the token budget — see Public API above)\n");
  if (truncated) {
    markdown += `\n_[brief trimmed to ~${tokenBudget} tokens — ${apiOmitted} lower-ranked file${apiOmitted === 1 ? "" : "s"} and ${typesOmitted} type${typesOmitted === 1 ? "" : "s"} omitted; open them directly if a span isn't covered here]_\n`;
  }
  return { markdown, truncated, omittedFiles: apiOmitted };
}
