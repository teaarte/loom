import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createPathRestrictedSandbox } from "../src/sandbox/index.js";
import {
  DEFAULT_TOOL_CATALOG,
  fileGlobTool,
  fileReadTool,
  fileWriteTool,
  grepTool,
} from "../src/tools/index.js";
import type { ToolContext } from "../src/types/tool.js";

function makeCtx(projectDir: string): {
  ctx: ToolContext;
  audited: Record<string, unknown>[];
} {
  const audited: Record<string, unknown>[] = [];
  const ctx: ToolContext = {
    project_dir: projectDir,
    sandbox: createPathRestrictedSandbox(projectDir),
    audit_emit: (p) => audited.push(p),
  };
  return { ctx, audited };
}

describe("file_read tool", () => {
  let project: string;
  let outside: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "loom-tool-read-"));
    outside = mkdtempSync(join(tmpdir(), "loom-tool-read-out-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("reads an in-project file and audits once", async () => {
    writeFileSync(join(project, "hello.txt"), "world", "utf8");
    const { ctx, audited } = makeCtx(project);
    const r = await fileReadTool.handler({ path: "hello.txt" }, ctx);
    assert.deepEqual(r, { content: "world" });
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.verdict, "ok");
    assert.equal(audited[0]?.type, "tool-call");
  });

  it("refuses an escaping symlink with sandbox-violation", async () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "nope", "utf8");
    symlinkSync(secret, join(project, "link-out"));
    const { ctx, audited } = makeCtx(project);
    const r = await fileReadTool.handler({ path: "link-out" }, ctx);
    assert.ok("error" in r);
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.error_class, "sandbox-violation");
    assert.equal(audited[0]?.reason, "path-escapes-project");
    assert.equal(audited[0]?.verdict, "refused");
  });

  it("refuses a sensitive file", async () => {
    writeFileSync(join(project, ".env"), "SECRET=1", "utf8");
    const { ctx, audited } = makeCtx(project);
    const r = await fileReadTool.handler({ path: ".env" }, ctx);
    assert.ok("error" in r);
    assert.equal(audited[0]?.error_class, "sandbox-violation");
    assert.match(String(audited[0]?.reason), /^sensitive-file:/);
  });

  it("reports an IO error (path allowed, read fails) without sandbox-violation", async () => {
    // A directory clears path discipline but is not readable as a file.
    mkdirSync(join(project, "adir"), { recursive: true });
    const { ctx, audited } = makeCtx(project);
    const r = await fileReadTool.handler({ path: "adir" }, ctx);
    assert.ok("error" in r);
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.verdict, "error");
    // Not a path-discipline refusal — no sandbox-violation class.
    assert.equal(audited[0]?.error_class, undefined);
  });
});

describe("file_write tool", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "loom-tool-write-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("writes an in-project file and audits once", async () => {
    const { ctx, audited } = makeCtx(project);
    const r = await fileWriteTool.handler(
      { path: "out.txt", content: "data" },
      ctx,
    );
    assert.ok("content" in r);
    assert.equal(readFileSync(join(project, "out.txt"), "utf8"), "data");
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.bytes_written, 4);
  });

  it("refuses writing the state database before touching disk", async () => {
    mkdirSync(join(project, ".loom"), { recursive: true });
    const dbPath = join(project, ".loom", "state.db");
    writeFileSync(dbPath, "ORIGINAL", "utf8");
    const { ctx, audited } = makeCtx(project);
    const r = await fileWriteTool.handler(
      { path: ".loom/state.db", content: "HACKED" },
      ctx,
    );
    assert.ok("error" in r);
    // The on-disk DB is untouched.
    assert.equal(readFileSync(dbPath, "utf8"), "ORIGINAL");
    assert.equal(audited[0]?.error_class, "sandbox-violation");
    assert.equal(audited[0]?.reason, "state-db-protected");
  });

  it("refuses writing the state DB WAL sidecar", async () => {
    mkdirSync(join(project, ".loom"), { recursive: true });
    const { ctx } = makeCtx(project);
    const r = await fileWriteTool.handler(
      { path: ".loom/state.db-wal", content: "x" },
      ctx,
    );
    assert.ok("error" in r);
  });

  it("reports an IO error (path allowed, write fails) without sandbox-violation", async () => {
    // A missing parent directory clears path discipline but ENOENTs on write.
    const { ctx, audited } = makeCtx(project);
    const r = await fileWriteTool.handler(
      { path: "missing-dir/file.txt", content: "x" },
      ctx,
    );
    assert.ok("error" in r);
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.verdict, "error");
    assert.equal(audited[0]?.error_class, undefined);
  });
});

describe("file_glob tool", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "loom-tool-glob-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("lists matching files sorted, excluding sensitive and vendored paths", async () => {
    writeFileSync(join(project, "b.ts"), "", "utf8");
    writeFileSync(join(project, "a.ts"), "", "utf8");
    mkdirSync(join(project, "sub"), { recursive: true });
    writeFileSync(join(project, "sub", "c.ts"), "", "utf8");
    writeFileSync(join(project, "readme.md"), "", "utf8");
    writeFileSync(join(project, ".env"), "", "utf8");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    writeFileSync(join(project, "node_modules", "dep.ts"), "", "utf8");

    const { ctx, audited } = makeCtx(project);
    const r = await fileGlobTool.handler({ pattern: "**/*.ts" }, ctx);
    assert.ok("content" in r);
    if ("content" in r) {
      assert.equal(r.content, ["a.ts", "b.ts", "sub/c.ts"].join("\n"));
    }
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.match_count, 3);
  });

  it("matches a top-level single-star pattern", async () => {
    writeFileSync(join(project, "x.json"), "", "utf8");
    mkdirSync(join(project, "deep"), { recursive: true });
    writeFileSync(join(project, "deep", "y.json"), "", "utf8");
    const { ctx } = makeCtx(project);
    const r = await fileGlobTool.handler({ pattern: "*.json" }, ctx);
    if ("content" in r) assert.equal(r.content, "x.json");
  });
});

describe("grep tool", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "loom-tool-grep-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("declares a deterministic truncate-head compression policy", () => {
    assert.equal(grepTool.output_compression?.strategy, "truncate-head");
  });

  it("finds matches and never searches sensitive files", async () => {
    writeFileSync(
      join(project, "code.ts"),
      "const x = 1;\nfind_me here\nother",
      "utf8",
    );
    writeFileSync(join(project, ".env"), "find_me=secret", "utf8");
    const { ctx, audited } = makeCtx(project);
    const r = await grepTool.handler({ pattern: "find_me" }, ctx);
    assert.ok("content" in r);
    if ("content" in r) {
      assert.equal(r.content, "code.ts:2:find_me here");
      // The secret in .env never surfaces.
      assert.ok(!r.content.includes("secret"));
    }
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.match_count, 1);
  });

  it("returns an error on an invalid pattern and audits once", async () => {
    const { ctx, audited } = makeCtx(project);
    const r = await grepTool.handler({ pattern: "(" }, ctx);
    assert.ok("error" in r);
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.verdict, "error");
  });
});

describe("DEFAULT_TOOL_CATALOG", () => {
  it("ships exactly the four path-disciplined tools, no bash", () => {
    const names = DEFAULT_TOOL_CATALOG.map((t) => t.name).sort();
    assert.deepEqual(names, ["file_glob", "file_read", "file_write", "grep"]);
  });
});
