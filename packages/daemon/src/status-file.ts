// Generic atomic status-file surface, shared by the local daemon and the
// control plane.
//
// Both keep an ADVISORY <pid, phase, …> file: a tolerant read (an absent /
// half-written / corrupt file reads as null), an atomic temp+rename write
// (`<path>.<pid>.tmp`, so a concurrent reader never sees a partial file), a
// best-effort clear, an ATOMIC liveness-guarded acquire (O_EXCL create, so two
// racers can never both win — only a stale/own/stopped file is reclaimed), and
// a pid-reuse-safe SIGTERM stop. The status SHAPE, the file path, and the
// conflict error are the per-caller divergences, threaded in.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Parse the kernel boot-relative start time (field 22) out of a Linux
// `/proc/<pid>/stat` line. The `comm` field (2nd) is wrapped in parens and may
// itself contain spaces / parens, so split AFTER the last ')': the first token
// of the tail is field 3 (state), making starttime the 20th token (index 19).
// Returns null on a shape it cannot parse. Pure → unit-tested directly.
export function parseProcStartToken(statContent: string): string | null {
  const rparen = statContent.lastIndexOf(")");
  if (rparen < 0) return null;
  const tail = statContent
    .slice(rparen + 1)
    .trim()
    .split(/\s+/);
  const starttime = tail[19];
  return starttime !== undefined && starttime.length > 0 ? starttime : null;
}

// A best-effort, portable-ish process-IDENTITY token: on Linux the boot-relative
// start time from `/proc/<pid>/stat`, which is STABLE for a live process and
// DIFFERENT for any later process that reuses the pid after the owner dies.
// Returns null where it cannot be read (macOS has no `/proc`, or the process is
// gone / unreadable) — callers then fall back to a plain liveness probe, so the
// guard only ever STRENGTHENS the stop decision, never weakens it.
export function processStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStartToken(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export interface StatusFileOptions {
  // Process-identity token reader; default = `processStartToken` (Linux /proc).
  // Injected by tests to drive the pid-reuse guard deterministically on any OS.
  readStartToken?: (pid: number) => string | null;
}

export interface StatusFile<T extends { pid: number; phase: string; start_token?: string }> {
  // Read the current status, or null when the file is absent / corrupt.
  read(): T | null;
  // Atomically write (temp + rename) so a concurrent read never sees a partial.
  write(status: T): void;
  // Best-effort remove; a lingering file is harmless (the next start overwrites).
  clear(): void;
  // ATOMICALLY claim the lock: create the file with O_EXCL so two concurrent
  // racers can never both win. An existing file is reclaimed ONLY when its owner
  // is dead, ourselves, or "stopped"; a DIFFERENT, still-alive, non-"stopped"
  // owner triggers `onConflict` (which must throw). The owner's process-start
  // token is stamped in so a later `signalStop` can tell a live owner from a
  // process that merely reused its pid.
  acquire(status: T, onConflict: (existing: T) => never): void;
  // SIGTERM a live owner → "signalled". A stale/absent/dead file clears and
  // reports "not-running" — as does a file whose pid is alive but now carries a
  // DIFFERENT start token (the owner died and an unrelated process inherited the
  // pid; signalling the stranger would be wrong).
  signalStop(): StopResult;
  // The identity token for `pid` from the configured reader (null where the
  // platform can't supply one). Exposed so a caller can stamp a status with the
  // SAME function this file's own guards compare against.
  startTokenFor(pid: number): string | null;
}

export function createStatusFile<T extends { pid: number; phase: string; start_token?: string }>(
  path: string,
  opts: StatusFileOptions = {},
): StatusFile<T> {
  const readStartToken = opts.readStartToken ?? processStartToken;

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

  // Stamp the live owner's start token onto a status before it is persisted, so
  // every write (claim + each update) carries it and a later stop can verify the
  // pid was not reused. A null token (non-Linux / unreadable) leaves the field
  // absent and the guard degrades to a plain liveness probe. Never overwrites a
  // token the caller already set (so a test can simulate a reused pid).
  const stamped = (status: T): T => {
    if (status.start_token !== undefined) return status;
    const token = readStartToken(status.pid);
    return token !== null ? { ...status, start_token: token } : status;
  };

  const writeAtomic = (status: T): void => {
    mkdirSync(dirname(path), { recursive: true });
    const s = stamped(status);
    const tmp = `${path}.${s.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    renameSync(tmp, path);
  };

  // A file is reclaimable when WE own it, its owner is dead, it is "stopped", or
  // it is torn/unreadable (read() === null but the path exists).
  const reclaimable = (existing: T | null, pid: number): boolean =>
    existing === null ||
    existing.pid === pid ||
    !isAlive(existing.pid) ||
    existing.phase === "stopped";

  return {
    read,
    write: writeAtomic,
    clear,
    startTokenFor: readStartToken,
    acquire(status, onConflict) {
      mkdirSync(dirname(path), { recursive: true });
      const s = stamped(status);
      const payload = JSON.stringify(s, null, 2);
      // Bounded retry: each loss to a concurrent racer either reveals a live
      // foreign owner (→ conflict) or a reclaimable file we remove and re-create.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let fd: number;
        try {
          // "wx" = O_CREAT | O_EXCL | O_WRONLY — the create is the atomic gate.
          fd = openSync(path, "wx");
        } catch (err) {
          if ((err as { code?: string }).code !== "EEXIST") throw err;
          const existing = read();
          if (!reclaimable(existing, s.pid)) {
            onConflict(existing as T); // a DIFFERENT, live, non-stopped owner holds it
          }
          // Stale / own / stopped / torn — drop it and retry the exclusive
          // create. A racing reclaimer may beat us; the next iteration re-reads
          // and re-decides, so two racers never both end up holding it.
          try {
            rmSync(path, { force: true });
          } catch {
            /* a racer removed it first */
          }
          continue;
        }
        try {
          writeFileSync(fd, payload, "utf8");
        } finally {
          closeSync(fd);
        }
        return; // won the lock
      }
      // Exhausted the reclaim race. Re-read: a live foreign owner is a conflict,
      // otherwise fall back to a best-effort atomic write so a wedged reclaim
      // loop never deadlocks a legitimate claim.
      const existing = read();
      if (!reclaimable(existing, s.pid)) onConflict(existing as T);
      writeAtomic(s);
    },
    signalStop() {
      const status = read();
      if (status === null || !isAlive(status.pid)) {
        clear();
        return "not-running";
      }
      // Pid-reuse guard: a recorded owner that carried a start token, whose pid
      // is alive but now reports a DIFFERENT token, is gone — an unrelated
      // process inherited its pid. Clear the stale file and report not-running
      // rather than SIGTERM the stranger.
      if (status.start_token !== undefined) {
        const current = readStartToken(status.pid);
        if (current !== null && current !== status.start_token) {
          clear();
          return "not-running";
        }
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
