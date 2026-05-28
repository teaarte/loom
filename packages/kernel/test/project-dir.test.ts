import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { KernelError } from "../src/state.js";
import { assertProjectDirAllowed } from "../src/lib/project-dir.js";

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
