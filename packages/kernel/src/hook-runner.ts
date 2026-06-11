// Post-commit subscriber dispatch.
//
// `HookRunner.fire(event, ctx)` resolves matching hooks against an
// index built at construction (topo-sort runs ONCE; a cycle throws
// `HOOK_CYCLE` synchronously so the bundle-loader surfaces the refusal
// at registry load, not on first event fire), then dispatches them
// with a two-transaction batching contract:
//
//   1. One read tx pre-scans `kernel_idempotency_ledger` for every
//      candidate `<hook_name>:<correlation>` pair in a single
//      `WHERE key IN (...)` query.
//   2. Hooks run OUTSIDE any tx — `run(ctx)` reaches the filesystem,
//      external services, etc.; locking SQLite while they fire would
//      starve every other writer for the slowest hook in the set.
//   3. One write tx batches every ok/failed ledger marker AND emits
//      an `audit.type='hook-failure'` row for each thrown hook.
//
// Cost is exactly 2 transactions per fire regardless of hook count.
// The naive per-hook implementation (3 txs × N hooks) would dominate
// tick latency for hook-heavy bundles.

import { ledgerExpiresAt } from "./lib/ledger.js";
import { withStateTransaction } from "./state/transaction.js";
import { assertVocabKnown } from "./vocabularies.js";
import {
  indexHooksByEvent,
  resolveHooks,
  topoSortHooks,
  eventMatches,
  filterMatches,
} from "./hooks.js";
import type { HookIndex } from "./hooks.js";
import type { HookContext } from "./types/context.js";
import type { Hook, HookEvent } from "./types/plugins.js";
import type { Registry } from "./types/registry.js";

// Re-export the matcher helpers so existing barrel consumers (and any
// direct importers from `./hook-runner.js`) keep working after the
// move into `./hooks.ts`.
export { eventMatches, filterMatches };

// Ledger surface. Two methods cover the batched-fire contract: one
// pre-scan, one write. The default implementation persists to the
// kernel's idempotency ledger; tests inject a stub to assert dispatch
// behavior in isolation.
export interface HookLedger {
  scanExisting(
    candidates: ReadonlyArray<HookCandidate>,
    ctx: HookContext,
  ): Promise<Set<string>>;
  writeMarkers(
    markers: ReadonlyArray<HookMarker>,
    ctx: HookContext,
  ): Promise<void>;
}

export interface HookCandidate {
  name: string;
  correlation: string;
}

export type HookMarker =
  | { kind: "ok"; name: string; correlation: string }
  | { kind: "failed"; name: string; correlation: string; error: unknown };

export class HookRunner {
  private readonly index: HookIndex;
  private ledger: HookLedger;

  constructor(private readonly registry: Registry) {
    const sorted = topoSortHooks(registry.hooks);
    this.index = indexHooksByEvent(sorted);
    this.ledger = new KernelHookLedger();
  }

  setLedger(ledger: HookLedger): void {
    this.ledger = ledger;
  }

  async fire(event: HookEvent, ctx: HookContext): Promise<void> {
    const resolved = resolveHooks(event, this.index);
    if (resolved.length === 0) return;

    const matching: Hook[] = [];
    for (const h of resolved) {
      if (!filterMatches(h.filter, ctx)) continue;
      matching.push(h);
    }
    if (matching.length === 0) return;

    const candidates: HookCandidate[] = matching.map((h) => ({
      name: h.name,
      correlation: ctx.idem_correlation,
    }));
    const seen = await this.ledger.scanExisting(candidates, ctx);

    const markers: HookMarker[] = [];
    for (const h of matching) {
      if (seen.has(pairKey(h.name, ctx.idem_correlation))) continue;
      const outcome = await runOne(h, ctx);
      markers.push(outcome);
    }

    if (markers.length > 0) {
      await this.ledger.writeMarkers(markers, ctx);
    }
  }
}

// Kernel-baseline audit type + error_class for a thrown hook. Shared by
// the audit row and the ledger's `hook_results_json` so a single
// vocabulary check covers both.
const HOOK_FAILURE = "hook-failure";

async function runOne(hook: Hook, ctx: HookContext): Promise<HookMarker> {
  try {
    await hook.run(ctx);
    return { kind: "ok", name: hook.name, correlation: ctx.idem_correlation };
  } catch (error) {
    return {
      kind: "failed",
      name: hook.name,
      correlation: ctx.idem_correlation,
      error,
    };
  }
}

function pairKey(name: string, correlation: string): string {
  return `${name}:${correlation}`;
}

function ledgerKey(name: string, correlation: string): string {
  return `side-effect-hook:${name}:${correlation}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Default ledger implementation. Pre-scan reaches the ledger in a
// single `WHERE key IN (...)` SELECT; the write phase folds every
// ok/failed marker AND audit emission into one transaction.
export class KernelHookLedger implements HookLedger {
  async scanExisting(
    candidates: ReadonlyArray<HookCandidate>,
    ctx: HookContext,
  ): Promise<Set<string>> {
    if (candidates.length === 0) return new Set();
    const keys = candidates.map((c) => ledgerKey(c.name, c.correlation));
    const placeholders = keys.map(() => "?").join(", ");
    return withStateTransaction(ctx.state.project_dir, ctx.now, async (tx) => {
      const rows = await tx.queryAll<{ key: string }>(
        `SELECT key FROM kernel_idempotency_ledger WHERE key IN (${placeholders})`,
        keys,
      );
      const out = new Set<string>();
      const prefix = "side-effect-hook:";
      for (const r of rows) {
        if (typeof r.key === "string" && r.key.startsWith(prefix)) {
          out.add(r.key.slice(prefix.length));
        }
      }
      return out;
    });
  }

  async writeMarkers(
    markers: ReadonlyArray<HookMarker>,
    ctx: HookContext,
  ): Promise<void> {
    if (markers.length === 0) return;
    // The kernel emits a fixed audit type + error_class for a thrown
    // hook; validate both against the merged vocabulary in scope before
    // any row lands, so a future emit-site that drifts from the
    // baseline is refused rather than silently inserted.
    const vocab = ctx.registry.vocabularies;
    assertVocabKnown(vocab.audit_types, HOOK_FAILURE, "audit_types");
    assertVocabKnown(vocab.error_classes, HOOK_FAILURE, "error_class");
    await withStateTransaction(ctx.state.project_dir, ctx.now, async (tx) => {
      for (const m of markers) {
        const key = ledgerKey(m.name, m.correlation);
        const hookResults =
          m.kind === "failed"
            ? JSON.stringify({
                error: errorMessage(m.error),
                error_class: HOOK_FAILURE,
              })
            : null;
        // INSERT OR IGNORE: a parallel writer (e.g. another HookRunner
        // instance racing the same correlation) may have landed the
        // row between scanExisting and now. Replay determinism is
        // preserved — the row that wins still records "we ran this".
        await tx.exec(
          "INSERT OR IGNORE INTO kernel_idempotency_ledger " +
            "(key, first_seen_ts, last_seen_ts, response_blob, hook_results_json, " +
            "driver_state_id, task_id, now_token, expires_at) " +
            "VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)",
          [
            key,
            ctx.now,
            ctx.now,
            hookResults,
            ctx.state.driver_state_id,
            ctx.state.task_id,
            ctx.now,
            // Same 24h dedup window as every other ledger row, so lazy
            // eviction never drops a hook marker still inside its window.
            ledgerExpiresAt(ctx.now),
          ],
        );

        if (m.kind === "failed") {
          const payload = JSON.stringify({
            hook: m.name,
            correlation: m.correlation,
            error: errorMessage(m.error),
          });
          await tx.exec(
            "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, " +
              "verdict, error_class) " +
              "VALUES (?, ?, ?, ?, ?, 'error', ?)",
            [
              ctx.now,
              HOOK_FAILURE,
              ctx.state.task_id,
              ctx.state.driver_state_id,
              payload,
              HOOK_FAILURE,
            ],
          );
          // Mirror onto tx.audit_buffer so any downstream subsystem
          // observing buffered audit entries (debug introspection,
          // future fan-out) sees the same emission shape.
          tx.audit_buffer.push({
            type: "hook-failure",
            hook: m.name,
            correlation: m.correlation,
            error: errorMessage(m.error),
          });
        }
      }
    });
  }
}
