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

import { KernelError, type ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, ExecutorResult } from "./drive.js";
import { PERMANENT_PROVIDER_ERROR_CODES } from "./provider-error.js";

// Resolve the executor for one spawn. Returns the chosen backend's `Executor`;
// may be async (a backend probe / credential read). The implementation owns any
// memoization — a resolver that rebuilds a sub-executor per spawn still works
// (a sandboxed sub-executor's worktree path is deterministic), but caching by
// backend avoids redundant provisioning.
export type ResolveExecutor = (
  spawn: ProviderShuttleIntent,
) => Executor | Promise<Executor>;

// One link in a per-spawn fallback chain: the backend's executor plus the model
// it must run (the kernel-resolved `intent.model` belongs to the PRIMARY ref, so
// a fallback entry overrides it with its own ref's model). `model` omitted → run
// the intent unchanged (the primary entry).
export interface ChainEntry {
  executor: Executor;
  model?: string;
  // A human label for the recorded notice when the dispatch advances to this
  // entry (e.g. `openrouter:qwen`). Optional.
  label?: string;
}

// Resolve the ORDERED fallback chain for one spawn — the primary first, then the
// configured fallbacks. The dispatch tries each in order, advancing only on a
// wall the same backend cannot clear (a rate-limit or a permanent provider
// error). Async (it resolves refs → backends → credentials).
export type ResolveExecutorChain = (
  spawn: ProviderShuttleIntent,
) => ChainEntry[] | Promise<ChainEntry[]>;

export interface DispatchExecutorOptions {
  // Single-backend resolution (the pre-fallback contract). Required unless a
  // chain resolver is supplied; ignored when one is.
  resolveExecutor?: ResolveExecutor;
  // Per-spawn fallback chain. When supplied it takes precedence over
  // `resolveExecutor`: the dispatch tries each entry in order and advances on a
  // rate-limit / permanent error to the next.
  resolveExecutorChain?: ResolveExecutorChain;
  // Optional non-model routing checked BEFORE the backend chain. When it
  // returns an executor for THIS spawn, the spawn runs on that executor and the
  // backend chain is skipped entirely — the generic seam by which a transport
  // routes a spawn whose bundle-declared capability marks it as something other
  // than a model call (e.g. a deterministic checks runner). Returns null to
  // fall through to the normal backend resolution. The shell stays
  // capability-blind: it never learns WHAT the executor does, only that the
  // resolver claimed this spawn.
  resolveDirectExecutor?: (
    spawn: ProviderShuttleIntent,
  ) => Executor | null | Promise<Executor | null>;
  // Notice sink for a fallback advance (which backend failed, which is next).
  // Generic by CODE + label — names no domain. Omitted → advances silently.
  onNotice?: (message: string) => void;
  // Whether re-running a spawn (same agent_run_id) is safe across the backends
  // this dispatch can route to. Default true (see the idempotency note above).
  idempotent?: boolean;
}

// The executor codes a fallback advances on — the EXACT set the supervisor parks
// on (permanent-provider-error-park): a sustained rate-limit, a bad model id, an
// auth/billing rejection. Every OTHER throw (a generic failure, a timeout) is
// re-thrown unchanged so the loop's same-backend retry still applies — the
// fallback is for "this backend can't serve it", not "retry this backend".
const FALLBACK_ADVANCE_CODES = new Set<string>(["EXECUTOR_RATE_LIMITED", ...PERMANENT_PROVIDER_ERROR_CODES]);

function isAdvanceError(err: unknown): boolean {
  return err instanceof KernelError && FALLBACK_ADVANCE_CODES.has(err.code);
}

export function createDispatchExecutor(opts: DispatchExecutorOptions): Executor {
  const runChain = async (
    spawn: ProviderShuttleIntent,
    signal: AbortSignal | undefined,
  ): Promise<ExecutorResult> => {
    const chain = await opts.resolveExecutorChain!(spawn);
    if (chain.length === 0) {
      throw new KernelError({
        code: "NO_BACKEND_RESOLVED",
        message: `no backend could be resolved for agent '${spawn.agent}'`,
        detail: { agent: spawn.agent },
      });
    }
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i += 1) {
      const entry = chain[i];
      if (entry === undefined) continue;
      const intent = entry.model !== undefined ? { ...spawn, model: entry.model } : spawn;
      try {
        return await entry.executor.execute(intent, signal);
      } catch (err) {
        lastErr = err;
        const next = chain[i + 1];
        // Advance ONLY on a wall the same backend cannot clear, and ONLY when a
        // next entry exists; otherwise re-throw so the loop's policy applies.
        if (next !== undefined && isAdvanceError(err)) {
          opts.onNotice?.(
            `backend for '${spawn.agent}' failed (${(err as KernelError).code})` +
              `${entry.label !== undefined ? ` [${entry.label}]` : ""} — falling back` +
              `${next.label !== undefined ? ` to ${next.label}` : ""}`,
          );
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  return {
    idempotent: opts.idempotent ?? true,
    async execute(spawn: ProviderShuttleIntent, signal?: AbortSignal): Promise<ExecutorResult> {
      // A non-model capability (e.g. a deterministic checks runner) claims the
      // spawn before any backend is resolved — so it needs no credential and
      // runs even with no provider configured.
      if (opts.resolveDirectExecutor !== undefined) {
        const direct = await opts.resolveDirectExecutor(spawn);
        if (direct !== null) return direct.execute(spawn, signal);
      }
      if (opts.resolveExecutorChain !== undefined) return runChain(spawn, signal);
      if (opts.resolveExecutor === undefined) {
        throw new KernelError({
          code: "DISPATCH_MISCONFIGURED",
          message: "createDispatchExecutor needs resolveExecutor or resolveExecutorChain",
          detail: {},
        });
      }
      const executor = await opts.resolveExecutor(spawn);
      return executor.execute(spawn, signal);
    },
  };
}
