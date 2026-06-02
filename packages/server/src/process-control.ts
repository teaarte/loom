// Control surface for `loom serve start|stop|status` — the ADVISORY
// bookkeeping for the one control-plane process, plus the DURABLE set of
// registered project dirs that recovery re-attaches.
//
// Two files under a server state dir (default `~/.claude/loom-server/`):
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
// `isAlive` is reused from `@loomfsm/daemon` so liveness probing is identical
// across the local daemon and the control plane.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isAlive, isoFrom, systemClock, type Clock } from "@loomfsm/daemon";

export type ServerPhase = "starting" | "serving" | "stopping" | "stopped";

export interface ServerStatus {
  pid: number;
  host: string;
  port: number;
  started_at: string;
  updated_at: string;
  phase: ServerPhase;
  project_count: number;
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
// test points it at a temp dir without touching the real `~/.claude`.
export function defaultServerStateDir(home: string): string {
  return join(home, ".claude", "loom-server");
}

export function serverStatusPath(stateDir: string): string {
  return join(stateDir, "server.json");
}

export function registeredProjectsPath(stateDir: string): string {
  return join(stateDir, "projects.json");
}

export function readServerStatus(stateDir: string): ServerStatus | null {
  const path = serverStatusPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ServerStatus;
  } catch {
    return null;
  }
}

// Atomic status write (temp + rename) so a concurrent `status` read never sees
// a half-written file.
function writeServerStatusFile(stateDir: string, status: ServerStatus): void {
  mkdirSync(stateDir, { recursive: true });
  const path = serverStatusPath(stateDir);
  const tmp = `${path}.${status.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
  renameSync(tmp, path);
}

export function clearServerStatus(stateDir: string): void {
  try {
    rmSync(serverStatusPath(stateDir), { force: true });
  } catch {
    /* a lingering status file is harmless — the next start overwrites it */
  }
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
}

// Claim the control plane. Refuses (SERVER_ALREADY_RUNNING) when a LIVE server
// already owns this state dir; a stale file from a crashed server (pid no
// longer alive) is reclaimed.
export function acquireServerLock(
  stateDir: string,
  host: string,
  port: number,
  opts: AcquireServerOptions = {},
): ServerHandle {
  const pid = opts.pid ?? process.pid;
  const clock = opts.clock ?? systemClock;

  const existing = readServerStatus(stateDir);
  if (existing !== null && existing.pid !== pid && isAlive(existing.pid) && existing.phase !== "stopped") {
    throw new ServerControlError(
      "SERVER_ALREADY_RUNNING",
      `a loom control plane (pid ${existing.pid}) is already serving on ${existing.host}:${existing.port}`,
    );
  }

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
  writeServerStatusFile(stateDir, base("starting", 0));

  return {
    update(phase, projectCount) {
      writeServerStatusFile(stateDir, base(phase, projectCount));
    },
    release() {
      clearServerStatus(stateDir);
    },
  };
}

export type StopResult = "signalled" | "not-running";

// Signal a running control plane to stop (SIGTERM → graceful shutdown). A
// stale/absent status file or a dead pid reports "not-running".
export function signalServerStop(stateDir: string): StopResult {
  const status = readServerStatus(stateDir);
  if (status === null || !isAlive(status.pid)) {
    clearServerStatus(stateDir);
    return "not-running";
  }
  try {
    process.kill(status.pid, "SIGTERM");
    return "signalled";
  } catch {
    return "not-running";
  }
}
