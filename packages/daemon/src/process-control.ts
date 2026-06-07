// Local-process control surface for `loom daemon start|stop|status`.
//
// This is ADVISORY operational bookkeeping — a PID + a phase the operator can
// read, and a target `stop` can signal. It is explicitly NOT task state: the
// STORE remains the single authority for what a task is and where it sits, so
// a missing, stale, or corrupt status file never blocks recovery (a restarted
// supervisor recovers from the store, not from this file). The principle the
// daemon holds — "no state the store does not" — is preserved: this file
// records only which OS process currently owns the supervision, never
// anything the kernel persists.

import { join } from "node:path";

import { projectFootprintDir } from "@loomfsm/kernel";

import { type Clock, isoFrom, systemClock } from "./clock.js";
import { createStatusFile, isAlive, type StatusFile, type StopResult } from "./status-file.js";

// Liveness probing and the stop-result type are shared with the control plane.
export { isAlive };
export type { StopResult };

export type DaemonPhase =
  | "starting"
  | "driving"
  | "parked"
  | "backing-off"
  | "idle"
  | "stopping"
  | "stopped";

export interface DaemonStatus {
  pid: number;
  project_dir: string;
  started_at: string;
  updated_at: string;
  phase: DaemonPhase;
  task_id?: string | null;
  // Free-form context for the phase: the gate name when parked, the error
  // code when backing off, etc. Never branched on.
  detail?: string;
}

export class DaemonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export function daemonDir(projectDir: string): string {
  return join(projectFootprintDir(projectDir), "daemon");
}

export function statusFilePath(projectDir: string): string {
  return join(daemonDir(projectDir), "daemon.json");
}

function statusFile(projectDir: string): StatusFile<DaemonStatus> {
  return createStatusFile<DaemonStatus>(statusFilePath(projectDir));
}

export function readStatus(projectDir: string): DaemonStatus | null {
  return statusFile(projectDir).read();
}

// Atomic status write (temp + rename) so a concurrent `status` read never
// sees a half-written file.
export function writeStatus(projectDir: string, status: DaemonStatus): void {
  statusFile(projectDir).write(status);
}

export function clearStatus(projectDir: string): void {
  statusFile(projectDir).clear();
}

export interface AcquireOptions {
  pid?: number;
  clock?: Clock;
}

export interface DaemonHandle {
  // Update the live phase/detail (atomic).
  update(phase: DaemonPhase, fields?: { task_id?: string | null; detail?: string }): void;
  // Clear the status file — call on graceful shutdown.
  release(): void;
}

// Claim supervision of a project. Refuses (DAEMON_ALREADY_RUNNING) when a
// LIVE daemon already owns it — a stale file from a crashed daemon (pid no
// longer alive) is reclaimed. Returns a handle whose `update` mutates the
// advisory phase and whose `release` clears the file.
export function acquireLock(projectDir: string, opts: AcquireOptions = {}): DaemonHandle {
  const pid = opts.pid ?? process.pid;
  const clock = opts.clock ?? systemClock;
  const sf = statusFile(projectDir);

  sf.guardAcquire(pid, (existing) => {
    throw new DaemonError(
      "DAEMON_ALREADY_RUNNING",
      `a loom daemon (pid ${existing.pid}) already supervises ${projectDir}`,
    );
  });

  const startedAt = isoFrom(clock);
  const base = (): DaemonStatus => ({
    pid,
    project_dir: projectDir,
    started_at: startedAt,
    updated_at: isoFrom(clock),
    phase: "starting",
  });
  sf.write(base());

  return {
    update(phase, fields) {
      sf.write({
        ...base(),
        updated_at: isoFrom(clock),
        phase,
        ...(fields?.task_id !== undefined ? { task_id: fields.task_id } : {}),
        ...(fields?.detail !== undefined ? { detail: fields.detail } : {}),
      });
    },
    release() {
      sf.clear();
    },
  };
}

// Signal a running daemon to stop (SIGTERM, the graceful-shutdown trigger).
// A stale/absent status file or a dead pid reports "not-running".
export function signalStop(projectDir: string): StopResult {
  return statusFile(projectDir).signalStop();
}
