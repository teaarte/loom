// Persistent, project-scoped, model-agnostic structural brief.
//
// The planner is the dominant cost of every run because it cold-reads the whole
// repo each time — same project, consecutive tasks — to satisfy its mandatory
// `file:line` citation rule. This builder makes that structural understanding
// PERSIST across runs and be reusable by any model/backend: a plain-markdown
// brief at `.loom/memory/<hash>/repo-brief.md`, delta-refreshed per file via a
// content-hash table, seeded into the sandbox as a warm-start asset.
//
// AMBIENT TRANSPORT, OUTSIDE THE KERNEL'S REPLAY GRAPH. No NowToken is minted to
// build or read it; replay never depends on it. Wall-clock / git / mtime are
// allowed here (this is transport, not the kernel). A stale brief can only cost
// the planner a few extra tokens, never corrupt a decision — so every failure
// path DEGRADES (returns "disabled") rather than throwing into the drive.
//
// The brief lives under loom's footprint at `.loom/memory/<hash>/`, a SIBLING of
// the archived `state.db`, so it survives task archival/rotation (the "persists
// across runs" property). It is built against the REAL project root — the
// baseline the planner plans against — not the per-task worktree copy.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { projectFootprintDir } from "@loomfsm/kernel";

import {
  extractFile,
  langOf,
  shouldExtract,
  type FileEntry,
  type StackFacts,
} from "./repo-brief-extract.js";
import { renderBrief } from "./repo-brief-extract.js";

// Bumped whenever the cached FileEntry shape changes (a mismatch forces a full
// re-extract). v3 added the per-file import graph used for importance ranking.
const SCHEMA_VERSION = 3;
const BRIEF_FILENAME = "repo-brief.md";
const META_FILENAME = "repo-brief.meta.json";
const CHANGED_FILENAME = "repo-brief.changed.txt";

// A file larger than this is recorded in the layout but not read for symbol
// extraction (a multi-MB generated/vendored file has no useful structure and
// would bloat the cache). Tuned well above any hand-written source file.
const MAX_FILE_BYTES = 512 * 1024;
// Past this many tracked files the brief is skipped wholesale (a giant monorepo
// where a markdown map is the wrong tool) — logged, never a silent cap.
const MAX_FILES = 6000;
const DEFAULT_TOKEN_BUDGET = 6000;

// ----- footprint resolution --------------------------------------------------

// A stable per-project hash, matching the sandbox-path convention
// (sha1 of the canonical root, 16 hex chars). The brief dir is already inside
// the project's own `.loom/`, so the hash is belt-and-suspenders today; it keeps
// the path identical to the shape the future on-disk index will share, so the
// two memory artifacts co-locate under one `.loom/memory/<hash>/`.
export function projectHash(projectDir: string): string {
  return createHash("sha1").update(resolve(projectDir)).digest("hex").slice(0, 16);
}

// `.loom/memory/<hash>/` — the project-scoped memory dir, outside the project
// SOURCE tree (gitignored) and outside the archived state.db.
export function projectMemoryDir(projectDir: string): string {
  return join(projectFootprintDir(projectDir), "memory", projectHash(projectDir));
}

export function repoBriefPath(projectDir: string): string {
  return join(projectMemoryDir(projectDir), BRIEF_FILENAME);
}

function metaPath(projectDir: string): string {
  return join(projectMemoryDir(projectDir), META_FILENAME);
}

function changedListPath(projectDir: string): string {
  return join(projectMemoryDir(projectDir), CHANGED_FILENAME);
}

// ----- flag ------------------------------------------------------------------

// repo-brief is behind a flag (default OFF for the first published build) so the
// release ships safely and the brief can be toggled on in real use.
export function repoBriefEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env["LOOM_REPO_BRIEF"] ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
}

// ----- meta (the content-hash cache) -----------------------------------------

interface MetaFileRecord {
  hash: string;
  entry: FileEntry;
}

interface BriefMeta {
  schema_version: number;
  baseline_ref: string | null;
  files: Record<string, MetaFileRecord>;
}

function readMeta(projectDir: string): BriefMeta | null {
  const p = metaPath(projectDir);
  if (!existsSync(p)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as BriefMeta).schema_version === "number" &&
      typeof (parsed as BriefMeta).files === "object"
    ) {
      return parsed as BriefMeta;
    }
  } catch {
    /* a corrupt cache → full rebuild */
  }
  return null;
}

// ----- git helpers (transport-local; the kernel never shells out) ------------

function runGit(projectDir: string, args: string[], input?: string): string | null {
  const res = spawnSync("git", ["-C", projectDir, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  if (res.error !== undefined || res.status !== 0) return null;
  return typeof res.stdout === "string" ? res.stdout : null;
}

function isGitWorkTree(projectDir: string): boolean {
  return runGit(projectDir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

// The current HEAD sha — a "did the committed baseline move?" stamp. A move
// forces a full re-extract (a branch switch / new commit can shift a lot);
// per-file content-hash still handles the common same-baseline case minimally.
// null for a repo with no commit yet (then the first build stands until a file
// changes), matching the degrade-don't-throw posture everywhere here.
function baselineRef(projectDir: string): string | null {
  const head = runGit(projectDir, ["rev-parse", "HEAD"]);
  return head !== null && head.trim().length > 0 ? head.trim() : null;
}

// Tracked files, `.loom/` excluded, that still exist on disk (a tracked file
// deleted from the working tree is left out → it falls into the deleted set and
// its brief section drops). Posix paths from git, stably sorted.
function listTrackedFiles(projectDir: string): string[] {
  const out = runGit(projectDir, ["-c", "core.quotePath=false", "ls-files", "--", ".", ":(exclude).loom"]);
  if (out === null) return [];
  const paths = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && existsSync(join(projectDir, l)));
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

// Working-tree content hash per path, in one git invocation. `git hash-object`
// hashes the file ON DISK (uncommitted edits included), which is what the
// worktree copy the agent reads reflects — not the committed blob.
function hashFiles(projectDir: string, files: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (files.length === 0) return map;
  const out = runGit(projectDir, ["hash-object", "--stdin-paths"], `${files.join("\n")}\n`);
  if (out === null) return map;
  const shas = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = 0; i < files.length && i < shas.length; i++) {
    const path = files[i];
    const sha = shas[i];
    if (path !== undefined && sha !== undefined) map.set(path, sha);
  }
  return map;
}

// ----- stack facts -----------------------------------------------------------

function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const FRAMEWORK_MARKERS: ReadonlyArray<{ dep: string; label: string }> = [
  { dep: "next", label: "Next.js" },
  { dep: "react", label: "React" },
  { dep: "vue", label: "Vue" },
  { dep: "svelte", label: "Svelte" },
  { dep: "@angular/core", label: "Angular" },
  { dep: "@nestjs/core", label: "NestJS" },
  { dep: "express", label: "Express" },
  { dep: "fastify", label: "Fastify" },
  { dep: "@remix-run/react", label: "Remix" },
  { dep: "astro", label: "Astro" },
  { dep: "vite", label: "Vite" },
  { dep: "jest", label: "Jest" },
  { dep: "vitest", label: "Vitest" },
  { dep: "prisma", label: "Prisma" },
  { dep: "@prisma/client", label: "Prisma" },
];

// Derive stack facts from root markers + per-language file counts. I/O is
// confined here (reading a handful of root files); the renderer is pure.
function deriveStackFacts(projectDir: string, files: string[]): StackFacts {
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = langOf(f);
    if (lang === "other") continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const languages = [...counts.entries()]
    .map(([lang, n]) => ({ lang, files: n }))
    .sort((a, b) => b.files - a.files || a.lang.localeCompare(b.lang));

  const commands: Array<{ name: string; command: string }> = [];
  const frameworks = new Set<string>();
  let packageManager: string | undefined;
  let monorepo: boolean | undefined;

  const has = (rel: string): boolean => existsSync(join(projectDir, rel));

  if (has("package.json")) {
    const pkg = safeReadJson(join(projectDir, "package.json"));
    const deps: Record<string, unknown> = {
      ...((pkg?.["dependencies"] as Record<string, unknown>) ?? {}),
      ...((pkg?.["devDependencies"] as Record<string, unknown>) ?? {}),
    };
    for (const { dep, label } of FRAMEWORK_MARKERS) if (dep in deps) frameworks.add(label);
    const scripts = (pkg?.["scripts"] as Record<string, unknown>) ?? {};
    // The package manager: a lockfile wins, else package.json#packageManager.
    if (has("pnpm-lock.yaml")) packageManager = "pnpm";
    else if (has("yarn.lock")) packageManager = "yarn";
    else if (has("package-lock.json")) packageManager = "npm";
    else if (has("bun.lockb")) packageManager = "bun";
    else if (typeof pkg?.["packageManager"] === "string") {
      packageManager = (pkg["packageManager"] as string).split("@")[0];
    }
    monorepo = has("pnpm-workspace.yaml") || has("turbo.json") || Array.isArray(pkg?.["workspaces"]);
    const pm = packageManager ?? "npm";
    const runner = pm === "npm" ? "npm run" : pm;
    const recurse = monorepo === true && pm === "pnpm" ? "-r " : "";
    for (const name of ["build", "test", "typecheck", "lint"]) {
      if (typeof scripts[name] === "string") {
        commands.push({ name, command: `${runner} ${recurse}${name}`.replace("npm run -r", "npm run") });
      }
    }
  } else if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    if (has("poetry.lock")) packageManager = "poetry";
    if (has("pytest.ini") || has("tox.ini")) commands.push({ name: "test", command: "pytest" });
  } else if (has("go.mod")) {
    packageManager = "go modules";
    commands.push({ name: "build", command: "go build ./..." });
    commands.push({ name: "test", command: "go test ./..." });
  } else if (has("Cargo.toml")) {
    packageManager = "cargo";
    commands.push({ name: "build", command: "cargo build" });
    commands.push({ name: "test", command: "cargo test" });
  }
  if (has("tsconfig.json") && commands.find((c) => c.name === "typecheck") === undefined) {
    commands.push({ name: "typecheck", command: "tsc --noEmit" });
  }

  return {
    languages,
    ...(packageManager !== undefined ? { packageManager } : {}),
    commands,
    frameworks: [...frameworks].sort((a, b) => a.localeCompare(b)),
    ...(monorepo !== undefined ? { monorepo } : {}),
  };
}

// ----- ensureBrief -----------------------------------------------------------

export interface EnsureBriefOptions {
  onNotice?: (message: string) => void;
  tokenBudget?: number;
}

export interface BriefStats {
  // false → degraded (not a git work tree, over the file cap, or an error). The
  // caller seeds nothing and the run behaves exactly as with the flag off.
  enabled: boolean;
  // true → the brief was (re)written this call; false → reused as-is / disabled.
  built: boolean;
  // true → first build, schema bump, or a baseline-ref change (full re-extract).
  fullRebuild: boolean;
  filesIndexed: number;
  // The files re-extracted this call — the delta the planner is told to open.
  changedFiles: string[];
  deletedFiles: string[];
  skippedFiles: number;
  truncated: boolean;
  briefPath: string | null;
  // The transient changed-file list (one path per line) — seeded alongside the
  // brief so the planner opens only the changed spans. null when disabled.
  changedListPath: string | null;
  reason?: string;
}

function disabled(reason: string, onNotice?: (m: string) => void): BriefStats {
  onNotice?.(`repo-brief: skipped (${reason})`);
  return {
    enabled: false,
    built: false,
    fullRebuild: false,
    filesIndexed: 0,
    changedFiles: [],
    deletedFiles: [],
    skippedFiles: 0,
    truncated: false,
    briefPath: null,
    changedListPath: null,
    reason,
  };
}

// Build or delta-refresh the brief against the REAL project root, returning
// stats. Idempotent and cheap on an unchanged tree (a reuse short-circuit does
// near-zero work). NEVER throws — any failure degrades to a disabled result so
// a brief problem can never fail a drive.
export function ensureBrief(projectDir: string, opts: EnsureBriefOptions = {}): BriefStats {
  const onNotice = opts.onNotice;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  try {
    if (!isGitWorkTree(projectDir)) return disabled("not a git work tree", onNotice);

    const files = listTrackedFiles(projectDir);
    if (files.length > MAX_FILES) {
      return disabled(`repo too large (${files.length} tracked files > ${MAX_FILES} cap)`, onNotice);
    }

    const baseline = baselineRef(projectDir);
    const hashes = hashFiles(projectDir, files);
    const meta = readMeta(projectDir);
    const fullRebuild =
      meta === null || meta.schema_version !== SCHEMA_VERSION || meta.baseline_ref !== baseline;
    const prev = meta?.files ?? {};

    const entries: Record<string, FileEntry> = {};
    const changed: string[] = [];
    for (const path of files) {
      const hash = hashes.get(path);
      const cached = prev[path];
      if (
        !fullRebuild &&
        hash !== undefined &&
        cached !== undefined &&
        cached.hash === hash &&
        cached.entry !== undefined
      ) {
        entries[path] = cached.entry; // unchanged → reuse the cached extraction
      } else {
        changed.push(path);
      }
    }
    const deleted = Object.keys(prev).filter((p) => !hashes.has(p));

    const memDir = projectMemoryDir(projectDir);
    const briefAbs = repoBriefPath(projectDir);

    // Reuse short-circuit: nothing changed, nothing deleted, same baseline, and
    // the brief is already on disk → do near-zero work and leave the brief
    // byte-identical. Still refresh the (tiny) changed list to "none".
    if (changed.length === 0 && deleted.length === 0 && !fullRebuild && existsSync(briefAbs)) {
      mkdirSync(memDir, { recursive: true });
      writeFileSync(changedListPath(projectDir), "", "utf8");
      return {
        enabled: true,
        built: false,
        fullRebuild: false,
        filesIndexed: files.length,
        changedFiles: [],
        deletedFiles: [],
        skippedFiles: 0,
        truncated: false,
        briefPath: briefAbs,
        changedListPath: changedListPath(projectDir),
      };
    }

    // Extract only the changed files (the cache carries the rest verbatim).
    let skippedFiles = 0;
    for (const path of changed) {
      const abs = join(projectDir, path);
      let entry: FileEntry;
      try {
        if (!shouldExtract(path) || statSync(abs).size > MAX_FILE_BYTES) {
          entry = { path, lang: langOf(path), symbols: [], loc: 0, skipped: true };
          skippedFiles += 1;
        } else {
          entry = extractFile(path, readFileSync(abs, "utf8"));
        }
      } catch {
        entry = { path, lang: langOf(path), symbols: [], loc: 0, skipped: true };
        skippedFiles += 1;
      }
      entries[path] = entry;
    }

    const sorted = Object.values(entries).sort((a, b) => a.path.localeCompare(b.path));
    const stackFacts = deriveStackFacts(projectDir, files);
    const rendered = renderBrief({ entries: sorted, stackFacts, fileCount: files.length, tokenBudget });

    // Persist: brief, meta (the new hash table + baseline), changed list.
    mkdirSync(memDir, { recursive: true });
    writeFileSync(briefAbs, rendered.markdown, "utf8");
    const nextFiles: Record<string, MetaFileRecord> = {};
    for (const path of files) {
      const hash = hashes.get(path);
      const entry = entries[path];
      if (hash !== undefined && entry !== undefined) nextFiles[path] = { hash, entry };
    }
    const nextMeta: BriefMeta = { schema_version: SCHEMA_VERSION, baseline_ref: baseline, files: nextFiles };
    writeFileSync(metaPath(projectDir), JSON.stringify(nextMeta), "utf8");
    writeFileSync(changedListPath(projectDir), changed.join("\n"), "utf8");

    return {
      enabled: true,
      built: true,
      fullRebuild,
      filesIndexed: files.length,
      changedFiles: changed,
      deletedFiles: deleted,
      skippedFiles,
      truncated: rendered.truncated,
      briefPath: briefAbs,
      changedListPath: changedListPath(projectDir),
    };
  } catch (err) {
    return disabled(err instanceof Error ? err.message : String(err), onNotice);
  }
}
