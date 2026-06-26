// The persistent structural brief, built against a REAL temp git work tree.
//
// The whole point of the brief is to PERSIST structural understanding across
// runs and delta-refresh cheaply: a first build extracts everything, a second
// run on an unchanged tree reuses the brief byte-for-byte, a changed file
// re-derives ONLY its section, a deleted file's section drops, and a baseline
// move forces a full re-check. These tests drive a real repo through each of
// those transitions — no mocks, because the content-hash table and git plumbing
// are exactly what we're testing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { ensureBrief, projectMemoryDir, repoBriefEnabled, repoBriefPath } from "../src/repo-brief.js";
import { computeInDegree, extractFile, langOf, renderBrief, stripCodeExt } from "../src/repo-brief-extract.js";

function git(dir: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.test");
  git(dir, "config", "user.name", "loom test");
  git(dir, "checkout", "-q", "-b", "main");
  // The brief excludes `.loom/`; the project should ignore it too (mirrors a
  // real loom project) so the memory dir never appears as a tracked file.
  writeFileSync(join(dir, ".gitignore"), ".loom/\n", "utf8");
}

function write(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function commit(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "loom-repobrief-"));
}

function withRepo(fn: (dir: string) => void): void {
  const dir = freshDir();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("repo-brief — flag", () => {
  it("is off by default and on for the documented truthy values", () => {
    assert.equal(repoBriefEnabled({}), false);
    assert.equal(repoBriefEnabled({ LOOM_REPO_BRIEF: "" }), false);
    assert.equal(repoBriefEnabled({ LOOM_REPO_BRIEF: "off" }), false);
    for (const v of ["on", "1", "true", "yes", "ON", "True"]) {
      assert.equal(repoBriefEnabled({ LOOM_REPO_BRIEF: v }), true, v);
    }
  });
});

describe("repo-brief — extraction (pure)", () => {
  it("captures exported TS declarations with line anchors", () => {
    const src = [
      "import { x } from './x.js';",
      "export interface Widget { id: string }",
      "const internal = 1;",
      "export const VERSION = '1';",
      "export function build(w: Widget): void {}",
      "export class Engine {",
      "  run() {}",
      "}",
    ].join("\n");
    const e = extractFile("src/widget.ts", src);
    assert.equal(e.lang, "ts");
    const names = e.symbols.map((s) => `${s.name}:${s.kind}:${s.line}:${s.exported}`);
    assert.ok(names.includes("Widget:interface:2:true"));
    assert.ok(names.includes("VERSION:const:4:true"));
    assert.ok(names.includes("build:function:5:true"));
    assert.ok(names.includes("Engine:class:6:true"));
    // An internal (non-exported) const is dropped as noise.
    assert.ok(!e.symbols.some((s) => s.name === "internal"));
  });

  it("detects language by extension and skips unknown ones", () => {
    assert.equal(langOf("a/b/c.tsx"), "tsx");
    assert.equal(langOf("main.go"), "go");
    assert.equal(langOf("README.md"), "other");
    assert.equal(extractFile("README.md", "# title").symbols.length, 0);
  });

  it("extracts Go exported (uppercase) symbols", () => {
    const src = ["package main", "type Server struct{}", "func Start() {}", "func helper() {}"].join("\n");
    const e = extractFile("server.go", src);
    assert.ok(e.symbols.some((s) => s.name === "Server" && s.kind === "struct" && s.exported));
    assert.ok(e.symbols.some((s) => s.name === "Start" && s.exported));
    assert.ok(e.symbols.some((s) => s.name === "helper" && !s.exported));
  });

  it("renders a token-budgeted brief and notes truncation", () => {
    const entries = Array.from({ length: 50 }, (_, i) => extractFile(`src/f${i}.ts`, `export function fn${i}() {}`));
    const tight = renderBrief({ entries, stackFacts: { languages: [{ lang: "ts", files: 50 }], commands: [], frameworks: [] }, fileCount: 50, tokenBudget: 80 });
    assert.equal(tight.truncated, true);
    assert.ok(tight.omittedFiles > 0);
    assert.match(tight.markdown, /brief trimmed/);
    const loose = renderBrief({ entries, stackFacts: { languages: [{ lang: "ts", files: 50 }], commands: [], frameworks: [] }, fileCount: 50, tokenBudget: 100000 });
    assert.equal(loose.truncated, false);
  });
});

describe("repo-brief — importance ranking (module graph)", () => {
  it("captures only intra-repo relative imports, normalized + ext-stripped", () => {
    const src = [
      "import { kernel } from '@loomfsm/kernel';", // external → dropped
      "import { a } from './a.js';", // → src/a
      "import { b } from '../lib/b.js';", // → lib/b
      "const c = require('./c');", // → src/c
      "const d = await import('./sub/d.js');", // → src/sub/d
    ].join("\n");
    const e = extractFile("src/widget.ts", src);
    const imps = [...(e.imports ?? [])].sort();
    assert.deepEqual(imps, ["lib/b", "src/a", "src/c", "src/sub/d"]);
    assert.ok(!imps.some((i) => i.includes("@loomfsm")));
  });

  it("matches an `import './dir'` to the dir's index file", () => {
    const consumer = extractFile("src/main.ts", "import { x } from './feature';");
    const index = extractFile("src/feature/index.ts", "export const x = 1;");
    const inDeg = computeInDegree([consumer, index]);
    assert.equal(inDeg.get("src/feature/index.ts"), 1);
  });

  it("counts in-degree (dependents) and ignores self-imports", () => {
    const hub = extractFile("src/hub.ts", "export const H = 1;");
    const a = extractFile("src/a.ts", "import { H } from './hub.js';\nexport const A = 1;");
    const b = extractFile("src/b.ts", "import { H } from './hub.js';\nexport const B = 1;");
    const inDeg = computeInDegree([hub, a, b]);
    assert.equal(inDeg.get("src/hub.ts"), 2);
    assert.equal(inDeg.get("src/a.ts") ?? 0, 0);
    assert.equal(stripCodeExt("src/hub.ts"), "src/hub");
  });

  it("ranks the most depended-upon file first, even with fewer exported symbols", () => {
    // hub.ts has ONE export but is imported by two files; fat.ts has many
    // exports but no dependents. Importance ranking must put hub.ts first.
    const hub = extractFile("src/hub.ts", "export const H = 1;");
    const fat = extractFile(
      "src/fat.ts",
      Array.from({ length: 8 }, (_, i) => `export function f${i}() {}`).join("\n"),
    );
    const a = extractFile("src/a.ts", "import { H } from './hub.js';");
    const b = extractFile("src/b.ts", "import { H } from './hub.js';");
    const out = renderBrief({
      entries: [a, b, fat, hub].sort((x, y) => x.path.localeCompare(y.path)),
      stackFacts: { languages: [{ lang: "ts", files: 4 }], commands: [], frameworks: [] },
      fileCount: 4,
      tokenBudget: 100000,
    });
    const hubAt = out.markdown.indexOf("### src/hub.ts");
    const fatAt = out.markdown.indexOf("### src/fat.ts");
    assert.ok(hubAt !== -1 && fatAt !== -1);
    assert.ok(hubAt < fatAt, "hub (2 dependents) must rank above fat (0 dependents)");
    assert.match(out.markdown, /### src\/hub\.ts {2}\(2 dependents\)/);
  });

  it("a long type list does NOT starve the ranked Public-API section (budget regression)", () => {
    // Many type-only files (a big flat type index) + one depended-upon API file.
    // The flat index must not consume the whole budget and drop the ranked map —
    // the bug a real-repo smoke test caught. Public API gets budget priority.
    const types = Array.from({ length: 200 }, (_, i) =>
      extractFile(`src/types/t${i}.ts`, `export interface T${i} { a: number; b: string }`),
    );
    const api = extractFile("src/core.ts", "export function core() {}\nexport class Core {}");
    const importer = extractFile("src/use.ts", "import { core } from './core.js';");
    const out = renderBrief({
      entries: [...types, api, importer].sort((x, y) => x.path.localeCompare(y.path)),
      stackFacts: { languages: [{ lang: "ts", files: 202 }], commands: [], frameworks: [] },
      fileCount: 202,
      tokenBudget: 1500,
    });
    // The ranked Public-API map for the depended-upon file survives the budget…
    assert.match(out.markdown, /### src\/core\.ts {2}\(1 dependent\)/);
    assert.match(out.markdown, /## Public API \(by file/);
    // …and the brief stays within a sane multiple of the budget (the type index
    // is bounded by the remainder, not emitted wholesale).
    assert.ok(out.markdown.length < 1500 * 4 * 1.5, `brief overshot budget: ${out.markdown.length} chars`);
  });
});

describe("repo-brief — ensureBrief lifecycle", () => {
  it("degrades (disabled, never throws) on a non-git directory", () => {
    withRepo((dir) => {
      const stats = ensureBrief(dir);
      assert.equal(stats.enabled, false);
      assert.equal(stats.built, false);
      assert.equal(stats.briefPath, null);
      assert.match(stats.reason ?? "", /not a git work tree/);
    });
  });

  it("first build extracts every file and writes the brief + meta + changed list", () => {
    withRepo((dir) => {
      initRepo(dir);
      write(dir, "package.json", JSON.stringify({ name: "demo", scripts: { build: "tsc", test: "node --test" }, devDependencies: { react: "^18" } }));
      write(dir, "src/a.ts", "export interface A { n: number }\nexport function makeA(): A { return { n: 1 }; }");
      write(dir, "src/b.ts", "export class B {}");
      commit(dir, "init");

      const stats = ensureBrief(dir);
      assert.equal(stats.enabled, true);
      assert.equal(stats.built, true);
      assert.equal(stats.fullRebuild, true);
      // package.json + 2 ts + .gitignore are tracked; all are "changed" first build.
      assert.ok(stats.changedFiles.includes("src/a.ts"));
      assert.ok(stats.changedFiles.includes("src/b.ts"));
      assert.equal(stats.briefPath, repoBriefPath(dir));

      const brief = readFileSync(repoBriefPath(dir), "utf8");
      assert.match(brief, /# Repo structural brief/);
      assert.match(brief, /`A` \(interface\) — src\/a\.ts:1/);
      assert.match(brief, /src\/b\.ts/);
      // Stack facts derived from package.json.
      assert.match(brief, /React/);
      assert.match(brief, /build:/);
      // The memory dir is under the project's footprint, not the source tree.
      assert.ok(repoBriefPath(dir).startsWith(projectMemoryDir(dir)));
    });
  });

  it("an unchanged tree reuses the brief byte-for-byte (near-zero work)", () => {
    withRepo((dir) => {
      initRepo(dir);
      write(dir, "src/a.ts", "export const A = 1;");
      commit(dir, "init");

      const first = ensureBrief(dir);
      assert.equal(first.built, true);
      const briefAfterFirst = readFileSync(repoBriefPath(dir), "utf8");

      const second = ensureBrief(dir);
      assert.equal(second.built, false); // reuse short-circuit
      assert.equal(second.enabled, true);
      assert.deepEqual(second.changedFiles, []);
      const briefAfterSecond = readFileSync(repoBriefPath(dir), "utf8");
      assert.equal(briefAfterSecond, briefAfterFirst);
    });
  });

  it("a single changed file re-derives ONLY its section", () => {
    withRepo((dir) => {
      initRepo(dir);
      write(dir, "src/a.ts", "export const A = 1;");
      write(dir, "src/b.ts", "export const B = 1;");
      commit(dir, "init");
      ensureBrief(dir); // prime the cache

      // Edit only a.ts (uncommitted — the working-tree hash changes).
      write(dir, "src/a.ts", "export const A = 1;\nexport const A2 = 2;");
      const stats = ensureBrief(dir);
      assert.equal(stats.built, true);
      assert.equal(stats.fullRebuild, false);
      assert.deepEqual(stats.changedFiles, ["src/a.ts"]); // ONLY a.ts re-extracted
      const brief = readFileSync(repoBriefPath(dir), "utf8");
      assert.match(brief, /`A2` \(const\)/); // the new symbol landed
    });
  });

  it("a deleted file's section drops on the next refresh", () => {
    withRepo((dir) => {
      initRepo(dir);
      write(dir, "src/keep.ts", "export const Keep = 1;");
      write(dir, "src/gone.ts", "export class Gone {}");
      commit(dir, "init");
      ensureBrief(dir);

      rmSync(join(dir, "src/gone.ts"));
      git(dir, "rm", "-q", "src/gone.ts");
      const stats = ensureBrief(dir);
      assert.ok(stats.deletedFiles.includes("src/gone.ts"));
      const brief = readFileSync(repoBriefPath(dir), "utf8");
      assert.ok(!brief.includes("Gone"));
      assert.match(brief, /Keep/);
    });
  });

  it("a baseline-ref move forces a full re-extract", () => {
    withRepo((dir) => {
      initRepo(dir);
      write(dir, "src/a.ts", "export const A = 1;");
      commit(dir, "init");
      ensureBrief(dir);

      // A new commit moves HEAD (the stored baseline_ref) with no working-tree
      // hash change → fullRebuild, every file re-extracted.
      git(dir, "commit", "-q", "--allow-empty", "-m", "move-head");
      const stats = ensureBrief(dir);
      assert.equal(stats.fullRebuild, true);
      assert.ok(stats.changedFiles.includes("src/a.ts"));
    });
  });

  it("respects .gitignore and never indexes the .loom memory dir itself", () => {
    withRepo((dir) => {
      initRepo(dir);
      write(dir, "src/a.ts", "export const A = 1;");
      write(dir, "secret.env", "TOKEN=xyz");
      writeFileSync(join(dir, ".gitignore"), ".loom/\nsecret.env\n", "utf8");
      commit(dir, "init");

      const stats = ensureBrief(dir);
      assert.ok(!stats.changedFiles.includes("secret.env")); // gitignored → untracked → absent
      const brief = readFileSync(repoBriefPath(dir), "utf8");
      assert.ok(!brief.includes("secret.env"));
      assert.ok(!brief.includes(".loom/memory"));
    });
  });
});
