// `loom allowlist add` / `loom init` against a real temp $HOME + project dir.
// Dedup is on the resolved (symlink-followed) identity, matching how the gate
// reads the file; comments and blank lines are preserved.

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
import { describe, it } from "node:test";

import { allowlistAdd, allowlistFilePath, readAllowlistEntries } from "../src/commands/allowlist.js";
import { init } from "../src/commands/init.js";
import type { CliEnv } from "../src/lib/env.js";

interface Captured {
  env: CliEnv;
  out: string[];
  err: string[];
}
function makeEnv(home: string, cwd: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = { home, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { env, out, err };
}

interface Harness {
  home: string;
  cwd: string;
  root: string;
  dispose: () => void;
}
function freshHarness(label: string): Harness {
  const root = mkdtempSync(join(tmpdir(), `loom-allow-${label}-`));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd, root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("loom allowlist add", () => {
  it("appends the realpath of the current directory and creates the file", () => {
    const h = freshHarness("create");
    try {
      const { env } = makeEnv(h.home, h.cwd);
      assert.equal(allowlistAdd([], env), 0);
      const entries = readAllowlistEntries(allowlistFilePath(h.home));
      assert.deepEqual(entries, [realpathSync(h.cwd)]);
    } finally {
      h.dispose();
    }
  });

  it("dedups a second add of the same directory", () => {
    const h = freshHarness("dedup");
    try {
      assert.equal(allowlistAdd([], makeEnv(h.home, h.cwd).env), 0);
      const second = makeEnv(h.home, h.cwd);
      assert.equal(allowlistAdd([], second.env), 0);
      assert.deepEqual(readAllowlistEntries(allowlistFilePath(h.home)), [realpathSync(h.cwd)]);
      assert.ok(second.out.some((l) => /already allowlisted/.test(l)));
    } finally {
      h.dispose();
    }
  });

  it("dedups across a symlinked spelling of the same directory", () => {
    const h = freshHarness("symlink");
    try {
      const link = join(h.root, "link-to-project");
      symlinkSync(h.cwd, link);
      assert.equal(allowlistAdd([], makeEnv(h.home, h.cwd).env), 0);
      // Add again via the symlinked path: resolves to the same real dir.
      const viaLink = makeEnv(h.home, h.root);
      assert.equal(allowlistAdd(["link-to-project"], viaLink.env), 0);
      assert.deepEqual(readAllowlistEntries(allowlistFilePath(h.home)), [realpathSync(h.cwd)]);
    } finally {
      h.dispose();
    }
  });

  it("--dry-run writes nothing", () => {
    const h = freshHarness("dryrun");
    try {
      const { env, out } = makeEnv(h.home, h.cwd);
      assert.equal(allowlistAdd(["--dry-run"], env), 0);
      assert.ok(!existsSync(allowlistFilePath(h.home)));
      assert.ok(out.some((l) => l.startsWith("[dry-run]")));
    } finally {
      h.dispose();
    }
  });

  it("preserves comments and blank lines, appending after them", () => {
    const h = freshHarness("comments");
    try {
      const filePath = allowlistFilePath(h.home);
      mkdirSync(join(h.home, ".claude"), { recursive: true });
      writeFileSync(filePath, "# my projects\n\n/some/other/path\n", "utf8");
      assert.equal(allowlistAdd([], makeEnv(h.home, h.cwd).env), 0);
      const raw = readFileSync(filePath, "utf8");
      assert.ok(raw.includes("# my projects"), "comment preserved");
      assert.ok(raw.includes("/some/other/path"), "existing entry preserved");
      assert.ok(raw.includes(realpathSync(h.cwd)), "new entry appended");
    } finally {
      h.dispose();
    }
  });

  it("appends a separating newline when the file lacks a trailing one", () => {
    const h = freshHarness("nonewline");
    try {
      const filePath = allowlistFilePath(h.home);
      mkdirSync(join(h.home, ".claude"), { recursive: true });
      writeFileSync(filePath, "/some/other/path", "utf8"); // no trailing newline
      assert.equal(allowlistAdd([], makeEnv(h.home, h.cwd).env), 0);
      const entries = readAllowlistEntries(filePath);
      assert.deepEqual(entries, ["/some/other/path", realpathSync(h.cwd)]);
    } finally {
      h.dispose();
    }
  });

  it("rejects a nonexistent path", () => {
    const h = freshHarness("missing");
    try {
      const { env, err } = makeEnv(h.home, h.cwd);
      assert.equal(allowlistAdd(["does-not-exist"], env), 1);
      assert.ok(err.some((l) => /does not exist/.test(l)));
    } finally {
      h.dispose();
    }
  });
});

describe("loom init", () => {
  it("creates .claude/ and allowlists the current directory", () => {
    const h = freshHarness("init");
    try {
      const { env } = makeEnv(h.home, h.cwd);
      assert.equal(init([], env), 0);
      assert.ok(existsSync(join(h.cwd, ".claude")), ".claude created");
      assert.deepEqual(readAllowlistEntries(allowlistFilePath(h.home)), [realpathSync(h.cwd)]);
    } finally {
      h.dispose();
    }
  });

  it("--dry-run writes nothing", () => {
    const h = freshHarness("init-dry");
    try {
      const { env } = makeEnv(h.home, h.cwd);
      assert.equal(init(["--dry-run"], env), 0);
      assert.ok(!existsSync(join(h.cwd, ".claude")));
      assert.ok(!existsSync(allowlistFilePath(h.home)));
    } finally {
      h.dispose();
    }
  });
});
