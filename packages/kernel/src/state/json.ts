// Shared parse-or-corrupt helper for kernel state JSON columns.
//
// Every JSON column on disk carries a `json_valid(...)` CHECK, so an
// unparseable blob can only arrive by external tampering or a backend
// skew. When one does, the read MUST fail loud: throwing the typed
// STATE_CORRUPT rolls the enclosing transaction back, rather than letting
// a reader silently substitute a default and overwrite whatever was
// actually on disk with it. The snapshot materializer and the
// result-persist (classifier-decisions) path both route through this one
// definition, so "bad blob → STATE_CORRUPT → rollback" is a single rule
// instead of a behavior that drifts between readers.
//
// A null / empty column is NOT corruption — it is the absence of a value,
// and callers get their typed `fallback`. Only an unparseable non-empty
// string trips STATE_CORRUPT.

import { KernelError } from "./db.js";

export function parseStateJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  const s = typeof raw === "string" ? raw : String(raw);
  if (s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    throw new KernelError({
      code: "STATE_CORRUPT",
      message: `JSON parse failed in state row (len=${s.length})`,
    });
  }
}
