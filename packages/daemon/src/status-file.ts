// Generic atomic status-file surface, shared by the local daemon and the
// control plane.
//
// Both keep an ADVISORY <pid, phase, …> file: a tolerant read (an absent /
// half-written / corrupt file reads as null), an atomic temp+rename write
// (`<path>.<pid>.tmp`, so a concurrent reader never sees a partial file), a
// best-effort clear, a liveness-guarded acquire (refuse only when a DIFFERENT,
// still-alive, non-"stopped" owner holds it — a stale/own/stopped file is
// reclaimed), and a SIGTERM-based stop. The status SHAPE, the file path, and
// the conflict error are the per-caller divergences, threaded in.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// True when a process with this pid exists (ours or another user's).
// `kill(pid, 0)` sends no signal — it only probes existence/permission.
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → the process exists but is owned by another user; ESRCH → gone.
    return (err as { code?: string }).code === "EPERM";
  }
}

export type StopResult = "signalled" | "not-running";

export interface StatusFile<T extends { pid: number; phase: string }> {
  // Read the current status, or null when the file is absent / corrupt.
  read(): T | null;
  // Atomically write (temp + rename) so a concurrent read never sees a partial.
  write(status: T): void;
  // Best-effort remove; a lingering file is harmless (the next start overwrites).
  clear(): void;
  // Refuse (by invoking `onConflict`, which must throw) only when a DIFFERENT,
  // still-alive, non-"stopped" owner holds the file; a stale (dead-pid),
  // own-pid, or "stopped" file is reclaimable and returns cleanly.
  guardAcquire(pid: number, onConflict: (existing: T) => never): void;
  // SIGTERM a live owner → "signalled". A stale/absent/dead file clears and
  // reports "not-running".
  signalStop(): StopResult;
}

export function createStatusFile<T extends { pid: number; phase: string }>(
  path: string,
): StatusFile<T> {
  const read = (): T | null => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const clear = (): void => {
    try {
      rmSync(path, { force: true });
    } catch {
      /* a lingering status file is harmless — the next start overwrites it */
    }
  };
  return {
    read,
    write(status) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${status.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
      renameSync(tmp, path);
    },
    clear,
    guardAcquire(pid, onConflict) {
      const existing = read();
      if (
        existing !== null &&
        existing.pid !== pid &&
        isAlive(existing.pid) &&
        existing.phase !== "stopped"
      ) {
        onConflict(existing);
      }
    },
    signalStop() {
      const status = read();
      if (status === null || !isAlive(status.pid)) {
        clear();
        return "not-running";
      }
      try {
        process.kill(status.pid, "SIGTERM");
        return "signalled";
      } catch {
        return "not-running";
      }
    },
  };
}
