// The advisory process-control surface — PID/status file, liveness, lock
// acquisition, and stop signalling. Real temp dirs, no mocks. The file is
// ADVISORY: a stale/dead entry is reclaimed, never a block.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  acquireLock,
  clearStatus,
  DaemonError,
  isAlive,
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
