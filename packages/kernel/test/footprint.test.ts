// Footprint resolution + the one-shot `.claude/` → `.loom/` migration.
//
// A real temp tree (no mocks): seed a 0.3-shaped `<project>/.claude/` (store +
// side-files, daemon trail, history, the 0.3.4 host sidecars under `loom/`,
// config) ALONGSIDE Claude Code's own files, then assert the resolver relocates
// only loom's subtree into `.loom/` (flattening the sidecars) and leaves Claude
// Code's files in `.claude/`. The user-global variant covers the operator files.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  _resetFootprintCacheForTest,
  projectFootprintDir,
  userFootprintDir,
} from "../src/lib/footprint.js";

const tmps: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

beforeEach(() => _resetFootprintCacheForTest());
afterEach(() => {
  _resetFootprintCacheForTest();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function file(path: string, body = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

describe("projectFootprintDir — one-shot .claude/ → .loom/ migration", () => {
  it("relocates loom's subtree (flattening the 0.3.4 sidecars) and leaves Claude Code's files", () => {
    const dir = tmp("loom-fp-proj-");
    const claude = join(dir, ".claude");
    // loom-owned: durable state + config + the 0.3.4 host sidecars under loom/.
    file(join(claude, "state.db"), "DB");
    file(join(claude, "state.db-wal"), "WAL");
    file(join(claude, "daemon", "log.jsonl"), "{}\n");
    file(join(claude, "history", "t1.db"), "OLD");
    file(join(claude, "history", "index.jsonl"), "{}\n");
    file(join(claude, "loom", "transcripts", "ar-1.json"), "{}");
    file(join(claude, "loom", "task-exec.json"), "{}");
    file(join(claude, "loom.json"), "{}");
    file(join(claude, "providers.json"), "{}");
    // Claude Code's own — must NOT move.
    file(join(claude, "settings.json"), "cc");
    file(join(claude, "commands", "task.md"), "cmd");

    const resolved = projectFootprintDir(dir);
    assert.equal(resolved, join(dir, ".loom"));

    // loom's durable state + config landed under .loom/.
    for (const rel of ["state.db", "state.db-wal", "daemon/log.jsonl", "history/t1.db", "history/index.jsonl", "loom.json", "providers.json"]) {
      assert.ok(existsSync(join(dir, ".loom", rel)), `.loom/${rel} should exist`);
      assert.ok(!existsSync(join(claude, rel)), `.claude/${rel} should be gone`);
    }
    // The 0.3.4 sidecars flattened up one level (no redundant inner loom/).
    assert.ok(existsSync(join(dir, ".loom", "transcripts", "ar-1.json")));
    assert.ok(existsSync(join(dir, ".loom", "task-exec.json")));
    assert.equal(readFileSync(join(dir, ".loom", "state.db"), "utf8"), "DB");

    // Claude Code's files stayed in .claude/.
    assert.ok(existsSync(join(claude, "settings.json")), "CC settings.json must stay");
    assert.ok(existsSync(join(claude, "commands", "task.md")), "CC commands/ must stay");
  });

  it("prefers an existing .loom/ and runs no move when both are present", () => {
    const dir = tmp("loom-fp-both-");
    file(join(dir, ".claude", "state.db"), "LEGACY");
    file(join(dir, ".loom", "state.db"), "CURRENT");

    projectFootprintDir(dir);

    // The new location wins untouched; the legacy file is left as-is.
    assert.equal(readFileSync(join(dir, ".loom", "state.db"), "utf8"), "CURRENT");
    assert.equal(readFileSync(join(dir, ".claude", "state.db"), "utf8"), "LEGACY");
  });

  it("is a no-op on a fresh project with no legacy footprint", () => {
    const dir = tmp("loom-fp-fresh-");
    const resolved = projectFootprintDir(dir);
    assert.equal(resolved, join(dir, ".loom"));
    // Nothing to migrate → the dir is not created by resolution alone.
    assert.ok(!existsSync(join(dir, ".loom")));
  });
});

describe("userFootprintDir — one-shot ~/.claude/ → ~/.loom/ migration", () => {
  it("relocates the operator files (loom-server → server) and leaves Claude Code's", () => {
    const home = tmp("loom-fp-home-");
    file(join(home, ".claude", "projects.allow"), "/p/a\n");
    file(join(home, ".claude", "bypass-hmac.key"), "KEY");
    file(join(home, ".claude", "loom-server", "projects.json"), "[]");
    // Claude Code's own — must NOT move.
    file(join(home, ".claude.json"), "cc");
    file(join(home, ".claude", "commands", "task.md"), "cmd");
    file(join(home, ".claude", ".credentials.json"), "creds");

    const resolved = userFootprintDir(home);
    assert.equal(resolved, join(home, ".loom"));

    assert.equal(readFileSync(join(home, ".loom", "projects.allow"), "utf8"), "/p/a\n");
    assert.ok(existsSync(join(home, ".loom", "bypass-hmac.key")));
    assert.ok(existsSync(join(home, ".loom", "server", "projects.json")), "loom-server → server");

    // Claude Code's user files stayed put.
    assert.ok(existsSync(join(home, ".claude.json")));
    assert.ok(existsSync(join(home, ".claude", "commands", "task.md")));
    assert.ok(existsSync(join(home, ".claude", ".credentials.json")));
  });
});
