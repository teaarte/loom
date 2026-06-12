import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { KernelError } from "../src/state.js";
import { assertProjectDirAllowed, enrollProjectDir } from "../src/lib/project-dir.js";

describe("assertProjectDirAllowed", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loom-allowlist-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeDir(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeAllowlist(lines: string[]): string {
    const path = join(root, "projects.allow");
    writeFileSync(path, lines.join("\n"), "utf8");
    return path;
  }

  it("returns the canonical path when the dir is an exact allowlist entry", async () => {
    const project = makeDir("project-a");
    const allowlistPath = makeAllowlist([realpathSync(project)]);
    const resolved = await assertProjectDirAllowed(project, { allowlistPath });
    assert.equal(resolved, realpathSync(project));
  });

  it("canonicalizes symlinks before the membership check", async () => {
    const real = makeDir("real-project");
    const link = join(root, "linked-project");
    symlinkSync(real, link);
    // Allowlist carries the REAL path; the caller passes the symlink.
    const allowlistPath = makeAllowlist([realpathSync(real)]);
    const resolved = await assertProjectDirAllowed(link, { allowlistPath });
    assert.equal(resolved, realpathSync(real));
  });

  it("ignores comment and blank lines", async () => {
    const project = makeDir("project-b");
    const allowlistPath = makeAllowlist([
      "# operator-authored allowlist",
      "",
      "   ",
      realpathSync(project),
      "# trailing comment",
    ]);
    const resolved = await assertProjectDirAllowed(project, { allowlistPath });
    assert.equal(resolved, realpathSync(project));
  });

  it("refuses a path not present in the allowlist", async () => {
    const project = makeDir("project-c");
    const other = makeDir("other-project");
    const allowlistPath = makeAllowlist([realpathSync(other)]);
    await assert.rejects(
      assertProjectDirAllowed(project, { allowlistPath }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "PROJECT_DIR_NOT_ALLOWED",
    );
  });

  it("default-denies when the allowlist file is missing", async () => {
    const project = makeDir("project-d");
    const allowlistPath = join(root, "does-not-exist.allow");
    await assert.rejects(
      assertProjectDirAllowed(project, { allowlistPath }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "PROJECT_DIR_NOT_ALLOWED",
    );
  });
});

describe("enrollProjectDir", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loom-enroll-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeDir(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("creates the file with a header and authorizes the dir the gate then allows", async () => {
    const project = makeDir("project-a");
    const allowlistPath = join(root, "nested", "projects.allow");

    const result = await enrollProjectDir(project, { allowlistPath });
    assert.equal(result.added, true);
    assert.equal(result.dir, realpathSync(project));

    assert.ok(existsSync(allowlistPath), "the allowlist file is created on first enroll");
    const body = readFileSync(allowlistPath, "utf8");
    assert.match(body, /^#/m, "a header comment seeds the new file");
    assert.ok(body.includes(realpathSync(project)), "the canonical dir is appended");

    // The gate it feeds now passes for that dir.
    const resolved = await assertProjectDirAllowed(project, { allowlistPath });
    assert.equal(resolved, realpathSync(project));
  });

  it("is idempotent — a second enroll adds no duplicate line", async () => {
    const project = makeDir("project-b");
    const allowlistPath = join(root, "projects.allow");

    const first = await enrollProjectDir(project, { allowlistPath });
    assert.equal(first.added, true);
    const second = await enrollProjectDir(project, { allowlistPath });
    assert.equal(second.added, false);

    const lines = readFileSync(allowlistPath, "utf8")
      .split("\n")
      .filter((l) => l.includes(realpathSync(project)));
    assert.equal(lines.length, 1, "the dir appears exactly once");
  });

  it("stores the canonical (realpath'd) path when given a symlink", async () => {
    const real = makeDir("real-project");
    const link = join(root, "linked-project");
    symlinkSync(real, link);
    const allowlistPath = join(root, "projects.allow");

    const result = await enrollProjectDir(link, { allowlistPath });
    assert.equal(result.added, true);
    assert.equal(result.dir, realpathSync(real));
    assert.ok(readFileSync(allowlistPath, "utf8").includes(realpathSync(real)));
    // Enrolling the real path next is a no-op — same canonical identity.
    const again = await enrollProjectDir(real, { allowlistPath });
    assert.equal(again.added, false);
  });

  it("preserves existing content (operator comments + ordering) when appending", async () => {
    const existing = makeDir("existing");
    const fresh = makeDir("fresh");
    const allowlistPath = join(root, "projects.allow");
    writeFileSync(allowlistPath, `# operator notes\n${realpathSync(existing)}\n`, "utf8");

    await enrollProjectDir(fresh, { allowlistPath });
    const body = readFileSync(allowlistPath, "utf8");
    assert.ok(body.includes("# operator notes"), "the comment survives");
    assert.ok(body.includes(realpathSync(existing)), "the prior entry survives");
    assert.ok(body.includes(realpathSync(fresh)), "the new entry is appended");
  });

  it("appends a separating newline when the file lacks a trailing one", async () => {
    const existing = makeDir("existing");
    const fresh = makeDir("fresh");
    const allowlistPath = join(root, "projects.allow");
    // No trailing newline — the new entry must not concatenate onto the last line.
    writeFileSync(allowlistPath, `${realpathSync(existing)}`, "utf8");

    await enrollProjectDir(fresh, { allowlistPath });
    const lines = readFileSync(allowlistPath, "utf8").split("\n").filter((l) => l.length > 0);
    assert.deepEqual(lines.sort(), [realpathSync(existing), realpathSync(fresh)].sort());
  });

  it("throws when the input dir does not resolve on disk", async () => {
    const allowlistPath = join(root, "projects.allow");
    await assert.rejects(enrollProjectDir(join(root, "no-such-dir"), { allowlistPath }));
    assert.ok(!existsSync(allowlistPath), "a failed enroll writes nothing");
  });
});
