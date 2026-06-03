// Per-spawn executor dispatch — a generic, backend-BLIND `Executor` that defers
// "which backend runs THIS spawn" to an injected resolver, one resolution per
// spawn.
//
// The headless loop has a single `Executor` seam. Until now a whole drive ran
// on ONE injected backend; this lifts that to per-spawn without the loop or the
// kernel learning anything new: the loop still calls `execute(intent)` and
// reads `idempotent` exactly as before — this executor simply routes each spawn
// to the executor the resolver returns for it. The resolver (built by the
// transport, e.g. the CLI) owns the only knowledge of HOW a backend is chosen
// (a model's provider family → a configured backend → a credentialed executor);
// this shell knows none of it, so it adds no vendor/domain coupling and the
// loop stays transport-neutral.
//
// Worktree vs plain is the SUB-executor's concern, not this shell's: a
// `claude -p` sub-executor provisions an isolated worktree + self-diffs it; a
// raw-API sub-executor (`createProviderExecutor`) is plain (one model call, no
// files). The resolver returns whichever fits the chosen backend.
//
// Idempotency: this shell reports `idempotent: true` by default so the resume
// restart-head re-shuttles a pending spawn exactly as the single-executor model
// did. That is sound across the mixed backends a drive can use: a `claude -p`
// sub-executor re-runs safely in its deterministic worktree; an API backend
// that wires the kernel's reused `agent_run_id` as its idempotency key does not
// re-bill on a re-shuttle; a local backend re-run is free. A deployment whose
// raw backend has un-deduped external side effects sets `idempotent: false` to
// keep the provider gate (then a pending spawn on it surfaces
// PROVIDER_NOT_IDEMPOTENT on resume rather than re-running).

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, ExecutorResult } from "./drive.js";

// Resolve the executor for one spawn. Returns the chosen backend's `Executor`;
// may be async (a backend probe / credential read). The implementation owns any
// memoization — a resolver that rebuilds a sub-executor per spawn still works
// (a sandboxed sub-executor's worktree path is deterministic), but caching by
// backend avoids redundant provisioning.
export type ResolveExecutor = (
  spawn: ProviderShuttleIntent,
) => Executor | Promise<Executor>;

export interface DispatchExecutorOptions {
  resolveExecutor: ResolveExecutor;
  // Whether re-running a spawn (same agent_run_id) is safe across the backends
  // this dispatch can route to. Default true (see the idempotency note above).
  idempotent?: boolean;
}

export function createDispatchExecutor(opts: DispatchExecutorOptions): Executor {
  return {
    idempotent: opts.idempotent ?? true,
    async execute(spawn: ProviderShuttleIntent): Promise<ExecutorResult> {
      const executor = await opts.resolveExecutor(spawn);
      return executor.execute(spawn);
    },
  };
}
