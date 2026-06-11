// The advisory process-control surface — PID/status file, liveness, lock
// acquisition, and stop signalling. Real temp dirs, no mocks. The file is
// ADVISORY: a stale/dead entry is reclaimed, never a block.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  acquireLock,
  clearStatus,
  DaemonError,
  isAlive,
  parseProcStartToken,
  readStatus,
  signalStop,
  writeStatus,
} from "../src/index.js";

// A pid that is almost certainly not a live process — used to simulate a
// crashed daemon's stale file.
const DEAD_PID = 2_147_483_646;

function freshProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-daemon-pc-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

describe("process-control — liveness probe", () => {
  it("reports the current process alive and a bogus pid dead", () => {
    assert.equal(isAlive(process.pid), true);
    assert.equal(isAlive(DEAD_PID), false);
    assert.equal(isAlive(0), false);
    assert.equal(isAlive(-1), false);
  });
});

describe("process-control — lock acquisition", () => {
  it("writes a status file and updates the phase", () => {
    const dir = freshProjectDir();
    try {
      const handle = acquireLock(dir, { pid: process.pid });
      const started = readStatus(dir);
      assert.equal(started?.pid, process.pid);
      assert.equal(started?.phase, "starting");

      handle.update("driving", { task_id: "task-xyz" });
      const driving = readStatus(dir);
      assert.equal(driving?.phase, "driving");
      assert.equal(driving?.task_id, "task-xyz");

      handle.release();
      assert.equal(readStatus(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when a LIVE daemon already owns the project", () => {
    const dir = freshProjectDir();
    try {
      // The current process holds the lock and is alive.
      acquireLock(dir, { pid: process.pid });
      // A different pid trying to claim it is refused.
      assert.throws(
        () => acquireLock(dir, { pid: DEAD_PID }),
        (err: unknown) => err instanceof DaemonError && err.code === "DAEMON_ALREADY_RUNNING",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock from a crashed (dead-pid) daemon", () => {
    const dir = freshProjectDir();
    try {
      // Simulate a crashed daemon's leftover file (its pid is gone).
      writeStatus(dir, {
        pid: DEAD_PID,
        project_dir: dir,
        started_at: "2026-06-02T00:00:00.000Z",
        updated_at: "2026-06-02T00:00:00.000Z",
        phase: "driving",
      });
      // A fresh daemon reclaims it without throwing.
      const handle = acquireLock(dir, { pid: process.pid });
      assert.equal(readStatus(dir)?.pid, process.pid);
      handle.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("process-control — stop signalling", () => {
  it("reports not-running for a dead pid and clears the stale file", () => {
    const dir = freshProjectDir();
    try {
      writeStatus(dir, {
        pid: DEAD_PID,
        project_dir: dir,
        started_at: "2026-06-02T00:00:00.000Z",
        updated_at: "2026-06-02T00:00:00.000Z",
        phase: "driving",
      });
      assert.equal(signalStop(dir), "not-running");
      assert.equal(readStatus(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports not-running when there is no status file", () => {
    const dir = freshProjectDir();
    try {
      clearStatus(dir);
      assert.equal(signalStop(dir), "not-running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("process-control — pid-reuse-safe stop (start-token guard)", () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("does NOT signal a reused pid (start-token mismatch) and clears the stale file", async () => {
    const dir = freshProjectDir();
    // A genuinely-alive process whose pid stands in for a reused one: the file
    // recorded an OLD owner's token, but the pid now belongs to THIS process
    // (a different token) — signalling it would kill an unrelated process.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      await sleep(50);
      assert.ok(child.pid);
      writeStatus(dir, {
        pid: child.pid,
        project_dir: dir,
        started_at: "2026-06-02T00:00:00.000Z",
        updated_at: "2026-06-02T00:00:00.000Z",
        phase: "driving",
        start_token: "old-owner-token",
      });
      // The CURRENT token for that pid differs from the recorded one → reused.
      const readStartToken = (pid: number): string | null =>
        pid === child.pid ? "new-different-token" : null;
      assert.equal(signalStop(dir, { readStartToken }), "not-running");
      // The stale file is cleared, and the live stranger was NOT signalled.
      assert.equal(readStatus(dir), null);
      assert.equal(isAlive(child.pid), true);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signals a live owner whose start token still matches", async () => {
    const dir = freshProjectDir();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      await sleep(50);
      assert.ok(child.pid);
      writeStatus(dir, {
        pid: child.pid,
        project_dir: dir,
        started_at: "2026-06-02T00:00:00.000Z",
        updated_at: "2026-06-02T00:00:00.000Z",
        phase: "driving",
        start_token: "match-token",
      });
      const readStartToken = (pid: number): string | null =>
        pid === child.pid ? "match-token" : null;
      // Token matches → the owner is the real one → it is signalled.
      assert.equal(signalStop(dir, { readStartToken }), "signalled");
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseProcStartToken — Linux /proc/<pid>/stat field 22", () => {
  it("extracts the start-time token, even when comm contains spaces / parens", () => {
    // The line is: pid (comm) state ppid ... — `comm` may itself contain spaces
    // AND parens, so the parser splits AFTER the last ')'. The post-')' tokens
    // are state(field3) ... starttime(field22), so starttime sits at index 19.
    const after = Array.from({ length: 24 }, (_, i) => `t${i}`);
    after[19] = "987654"; // field 22 = starttime
    const stat = `4242 (weird (name) proc) ${after.join(" ")}`;
    assert.equal(parseProcStartToken(stat), "987654");
  });

  it("returns null on an unparseable line", () => {
    assert.equal(parseProcStartToken("garbage with no paren"), null);
    assert.equal(parseProcStartToken(""), null);
  });
});
