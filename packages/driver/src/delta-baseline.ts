// Durable storage for the task-start delta baseline.
//
// The baseline (the ref the runtime diffs the working tree against to
// compute the honest file delta) must outlive a process drop so a resumed
// task still measures changes from the same starting point. It rides the
// driver's generic `scratch` JSON bag on `driver_state` — a kernel-owned
// column that is already part of the backup/restore set, so the value
// survives backup → restore and resume for free. The kernel never reads or
// interprets this key (it is the transport's, not the engine's), so the
// engine stays domain-blind: nothing here teaches the kernel about VCS.
//
// `scratch` is also where the kernel parks its own generic counters (e.g.
// fanout iteration). Those writes read-modify-write the whole object, so a
// transport key set here is preserved across kernel ticks; conversely we
// read-modify-write here to leave any kernel keys untouched.

import { captureNow, openDb, TransactionImpl, type Transaction } from "@loomfsm/kernel";

// Namespaced so it cannot collide with a bundle stage name (the kernel's
// own scratch keys are `fanout_iter_<stage>`).
const SCRATCH_KEY = "transport_delta_baseline";

interface BaselineRecord {
  vcs: "git";
  ref: string;
}

function parseScratch(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

// Merge the baseline ref into driver_state.scratch inside the caller's tx
// (the task-create tx), preserving any keys the kernel already stored.
export async function persistDeltaBaseline(tx: Transaction, ref: string): Promise<void> {
  const row = await tx.queryRow<{ scratch: unknown }>(
    "SELECT scratch FROM driver_state WHERE id = 1",
  );
  const scratch = parseScratch(row?.scratch);
  scratch[SCRATCH_KEY] = { vcs: "git", ref } satisfies BaselineRecord;
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [JSON.stringify(scratch)]);
}

// Read the stored baseline ref through the dedicated maintenance
// connection (no transaction held across the await). Returns null when no
// baseline was ever stored (e.g. the project was not a git work tree at
// task start) — the caller then computes no server-side delta.
export async function readDeltaBaseline(projectDir: string): Promise<string | null> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  const row = await tx.queryRow<{ scratch: unknown }>(
    "SELECT scratch FROM driver_state WHERE id = 1",
  );
  const scratch = parseScratch(row?.scratch);
  const record = scratch[SCRATCH_KEY];
  if (record !== null && typeof record === "object" && !Array.isArray(record)) {
    const ref = (record as Partial<BaselineRecord>).ref;
    if (typeof ref === "string" && ref.length > 0) return ref;
  }
  return null;
}
