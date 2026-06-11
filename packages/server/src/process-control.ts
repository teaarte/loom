// Control surface for `loom serve start|stop|status` — the ADVISORY
// bookkeeping for the one control-plane process, plus the DURABLE set of
// registered project dirs that recovery re-attaches.
//
// Two files under a server state dir (default `~/.loom/server/`):
//
//   server.json   — ADVISORY: pid, bind host/port, phase, project count.
//                   A `stop` reads it to signal; a `status` reads it to
//                   report. It is NOT authority — a stale/absent file never
//                   blocks recovery.
//   projects.json — DURABLE: the registered project dirs. This is what a
//                   restart re-reads to rebuild the fleet (the E1 recovery
//                   head, now fleet-wide). The per-project STORE remains the
//                   single authority for each task; this file only records
//                   which projects the control plane is responsible for.
//
// The advisory status file's mechanics (atomic write, liveness-guarded lock,
// SIGTERM stop) are the daemon's `createStatusFile`, so liveness probing and
// the lock/stop semantics are identical across the local daemon and the
// control plane. The durable registered-projects file stays local — it has a
// different shape (no pid/phase) and its own non-pid temp-name.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createStatusFile, isoFrom, systemClock, type Clock, type StatusFile } from "@loomfsm/daemon";
import { userFootprintDir } from "@loomfsm/kernel";

export type ServerPhase = "starting" | "serving" | "stopping" | "stopped";

export interface ServerStatus {
  pid: number;
  host: string;
  port: number;
  started_at: string;
  updated_at: string;
  phase: ServerPhase;
  project_count: number;
  // Process-identity token (Linux start-time) stamped at acquire so `stop` can
  // tell a live owner from a process that reused the pid. Absent off Linux.
  start_token?: string;
}

export class ServerControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServerControlError";
  }
}

// Default state dir under the user's home. `home` is passed explicitly so a
// test points it at a temp dir without touching the real `~/.loom`.
export function defaultServerStateDir(home: string): string {
  return join(userFootprintDir(home), "server");
}

export function serverStatusPath(stateDir: string): string {
  return join(stateDir, "server.json");
}

export function registeredProjectsPath(stateDir: string): string {
  return join(stateDir, "projects.json");
}

// The advisory server-status file shares its mechanics (tolerant read, atomic
// temp+rename write, best-effort clear, liveness-guarded acquire, SIGTERM stop)
// with the local daemon; only the status shape and the conflict error differ.
function statusFile(
  stateDir: string,
  readStartToken?: (pid: number) => string | null,
): StatusFile<ServerStatus> {
  return createStatusFile<ServerStatus>(
    serverStatusPath(stateDir),
    readStartToken !== undefined ? { readStartToken } : {},
  );
}

export function readServerStatus(stateDir: string): ServerStatus | null {
  return statusFile(stateDir).read();
}

export function clearServerStatus(stateDir: string): void {
  statusFile(stateDir).clear();
}

// ----- durable registered-project set ------------------------------------

interface RegisteredProjectsFile {
  dirs: string[];
}

export function readRegisteredProjects(stateDir: string): string[] {
  const path = registeredProjectsPath(stateDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RegisteredProjectsFile;
    return Array.isArray(parsed.dirs) ? parsed.dirs.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function writeRegisteredProjects(stateDir: string, dirs: string[]): void {
  mkdirSync(stateDir, { recursive: true });
  const path = registeredProjectsPath(stateDir);
  const tmp = `${path}.tmp`;
  const payload: RegisteredProjectsFile = { dirs };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, path);
}

// ----- liveness lock ------------------------------------------------------

export interface ServerHandle {
  update(phase: ServerPhase, projectCount: number): void;
  release(): void;
}

export interface AcquireServerOptions {
  pid?: number;
  clock?: Clock;
  // Injectable process-identity token reader (default = Linux `/proc` start
  // time). A test passes a fake so the pid-reuse stop guard is deterministic on
  // any OS; production leaves it unset.
  readStartToken?: (pid: number) => string | null;
}

// Claim the control plane. Refuses (SERVER_ALREADY_RUNNING) when a LIVE server
// already owns this state dir; a stale file from a crashed server (pid no
// longer alive) is reclaimed. The claim is atomic (O_EXCL): two concurrent
// starts can never both win.
export function acquireServerLock(
  stateDir: string,
  host: string,
  port: number,
  opts: AcquireServerOptions = {},
): ServerHandle {
  const pid = opts.pid ?? process.pid;
  const clock = opts.clock ?? systemClock;
  const sf = statusFile(stateDir, opts.readStartToken);

  const startedAt = isoFrom(clock);
  const base = (phase: ServerPhase, projectCount: number): ServerStatus => ({
    pid,
    host,
    port,
    started_at: startedAt,
    updated_at: isoFrom(clock),
    phase,
    project_count: projectCount,
  });
  sf.acquire(base("starting", 0), (existing) => {
    throw new ServerControlError(
      "SERVER_ALREADY_RUNNING",
      `a loom control plane (pid ${existing.pid}) is already serving on ${existing.host}:${existing.port}`,
    );
  });

  return {
    update(phase, projectCount) {
      sf.write(base(phase, projectCount));
    },
    release() {
      sf.clear();
    },
  };
}

export type StopResult = "signalled" | "not-running";

// Signal a running control plane to stop (SIGTERM → graceful shutdown). A
// stale/absent status file, a dead pid, or a pid reused by an unrelated process
// (start-token mismatch) reports "not-running".
export function signalServerStop(
  stateDir: string,
  opts: { readStartToken?: (pid: number) => string | null } = {},
): StopResult {
  return statusFile(stateDir, opts.readStartToken).signalStop();
}
