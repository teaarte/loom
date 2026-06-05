// The multi-project supervisor registry — the control plane's core.
//
// It supervises a FLEET of projects from one process by composing E1's
// single-project `superviseWatch` N times: one detached watcher loop per
// project, each driving that project's single task to terminal, parking on a
// gate, retrying, recovering — exactly as `loom daemon start --watch` does for
// one project. The registry adds only what spans projects:
//
//   * a SHARED concurrency ceiling — one semaphore injected into every
//     project's executor, so the total in-flight backend spawns across the
//     whole fleet stay bounded (the subscription rate-limit guard);
//   * a per-project lock (`acquireLock`) so a stray `loom daemon start` and
//     the control plane never double-drive the same project;
//   * a DURABLE registered-dir set, so a restart re-attaches the whole fleet
//     (the E1 recovery head, now fleet-wide).
//
// It holds no task state — each project's STORE is its single authority; the
// registry only remembers WHICH projects it supervises, and that lives in
// `projects.json`, not in memory.
//
// Bundle- and domain-blind: it injects a `resolveRegistry` + a `buildExecutor`
// (the deployment's bundle/provider choice) exactly as `loom run`/`loom daemon`
// do, and never reads what a flow means.

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  acquireLock,
  nullLogger,
  superviseWatch,
  systemClock,
  withProjectId,
  type Clock,
  type DaemonHandle,
  type DaemonLogger,
  type ExecutorBuildContext,
  type MergeBackResult,
  type Notifier,
  type RetryPolicy,
  type WakeOptions,
} from "@loomfsm/daemon";
import type { DriveOutcome, Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

// The worktree integration the supervisor runs on `complete` — forwarded
// fleet-wide so the deployment's chosen backend (worktree vs container clone)
// brings its matching merge-back. Mirrors the daemon's `SuperviseOptions`.
type CompleteOutcome = Extract<DriveOutcome, { kind: "complete" }>;
export type FleetMergeBack = (
  projectDir: string,
  outcome: CompleteOutcome,
) => MergeBackResult | Promise<MergeBackResult>;

import { ServerError } from "./errors.js";
import { gatedExecutor } from "./executor-gate.js";
import { readRegisteredProjects, writeRegisteredProjects } from "./process-control.js";
import { Semaphore } from "./semaphore.js";

export interface RegistryDeps {
  // Resolve the FSM registry for a project — the deployment's bundle/provider
  // choice (the CLI injects `assembleRegistry`).
  resolveRegistry: (projectDir: string) => Promise<Registry> | Registry;
  // Build the per-project BASE executor for one drive attempt; the registry
  // wraps it with the shared concurrency gate. The CLI injects the `claude -p`
  // factory.
  buildExecutor: (projectDir: string, ctx: ExecutorBuildContext) => Executor;
  // Worktree integration on `complete`, applied to every watcher. Omitted →
  // the supervisor's default (commit-to-branch from the worktree). The CLI
  // injects the clone variant when serving in container mode.
  mergeBack?: FleetMergeBack;
  // Where the durable registered-dir set is persisted.
  stateDir: string;
  // Total concurrent backend spawns across the WHOLE fleet. Default 4.
  max_concurrent_spawns?: number;
  // Per-project audit logger. Default a no-op.
  makeLogger?: (projectDir: string) => DaemonLogger;
  // Per-project outbound notify sink. The registry stamps the project's id onto
  // every event so a shared channel can tell the fleet apart. Default = none.
  makeNotifier?: (projectDir: string) => Notifier;
  // Generic supervision knobs, passed through to every watcher.
  retry_policy?: RetryPolicy;
  wake?: WakeOptions;
  clock?: Clock;
  // Idle-poll cadence each watcher uses between tasks. Default = the daemon's 5s.
  watch_idle_ms?: number;
  // Wait this long on a recognised rate-limit before re-driving. Default 1h.
  rate_limit_wait_ms?: number;
  // Abort a single drive that runs past this wall-time (a hung spawn) → treated
  // transient and re-driven. Omitted → no per-drive deadline.
  drive_deadline_ms?: number;
}

interface Entry {
  id: string;
  dir: string;
  controller: AbortController;
  handle: DaemonHandle;
  loop: Promise<void>;
}

export interface ProjectListing {
  id: string;
  dir: string;
}

// URL-safe, stable id for a project dir — a short hash of its resolved path.
export function projectId(dir: string): string {
  return createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 12);
}

export class SupervisorRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly gate: Semaphore;
  private readonly clock: Clock;
  private shuttingDown = false;

  constructor(private readonly deps: RegistryDeps) {
    this.gate = new Semaphore(deps.max_concurrent_spawns ?? 4);
    this.clock = deps.clock ?? systemClock;
  }

  // Re-attach every durably-registered project. Called once on start: each
  // watcher's own startup recovery (peek the slot, re-drive an in-flight task)
  // then finishes whatever was interrupted by the last shutdown/crash.
  async recover(): Promise<ProjectListing[]> {
    const dirs = readRegisteredProjects(this.deps.stateDir);
    const listed: ProjectListing[] = [];
    for (const dir of dirs) {
      try {
        listed.push(this.register(dir));
      } catch (err) {
        // A project that can no longer be claimed (a live `loom daemon` owns
        // it, or its dir is gone) is skipped, not fatal — the rest of the
        // fleet still comes up.
        this.loggerFor(dir).warn("recover-skip", {
          dir,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return listed;
  }

  // Register a project and start supervising it. Idempotent: an
  // already-registered dir returns its existing listing without starting a
  // second watcher. Refuses (PROJECT_LOCKED) when a live `loom daemon` already
  // owns the project.
  register(dir: string): ProjectListing {
    const projectDir = resolve(dir);
    const id = projectId(projectDir);
    const existing = this.entries.get(id);
    if (existing !== undefined) return { id, dir: projectDir };

    let handle: DaemonHandle;
    try {
      handle = acquireLock(projectDir);
    } catch (err) {
      throw new ServerError(
        "PROJECT_LOCKED",
        409,
        err instanceof Error ? err.message : `cannot supervise ${projectDir}`,
      );
    }

    const controller = new AbortController();
    const logger = this.loggerFor(projectDir);
    const opts = {
      buildExecutor: (ctx: ExecutorBuildContext): Executor =>
        gatedExecutor(this.deps.buildExecutor(projectDir, ctx), this.gate),
      resolveRegistry: this.deps.resolveRegistry,
      logger,
      handle,
      clock: this.clock,
      signal: controller.signal,
      ...(this.deps.makeNotifier !== undefined
        ? { notifier: withProjectId(this.deps.makeNotifier(projectDir), id) }
        : {}),
      ...(this.deps.mergeBack !== undefined ? { mergeBack: this.deps.mergeBack } : {}),
      ...(this.deps.retry_policy !== undefined ? { retry_policy: this.deps.retry_policy } : {}),
      ...(this.deps.wake !== undefined ? { wake: this.deps.wake } : {}),
      ...(this.deps.watch_idle_ms !== undefined ? { watch_idle_ms: this.deps.watch_idle_ms } : {}),
      ...(this.deps.rate_limit_wait_ms !== undefined
        ? { rate_limit_wait_ms: this.deps.rate_limit_wait_ms }
        : {}),
      ...(this.deps.drive_deadline_ms !== undefined
        ? { drive_deadline_ms: this.deps.drive_deadline_ms }
        : {}),
    };

    // Detached watcher loop. It runs until `controller` aborts (unregister or
    // shutdown). The supervisor now normalizes a thrown drive into an error
    // outcome it parks on, so this catch is a true last resort (a throw from the
    // watch scaffolding itself). It must NOT die silently: it marks the handle
    // `stopped` so the advisory status reflects a dead watcher, never leaving a
    // stale `driving`/`parked` phase that reads as "still working".
    const loop = Promise.resolve()
      .then(() => superviseWatch(projectDir, opts))
      .catch((err: unknown) => {
        logger.error("watch-crash", {
          dir: projectDir,
          message: err instanceof Error ? err.message : String(err),
        });
        handle.update("stopped", { detail: "watch-crash" });
      });

    this.entries.set(id, { id, dir: projectDir, controller, handle, loop });
    this.persist();
    return { id, dir: projectDir };
  }

  // Stop supervising a project and forget it. Aborts its watcher, releases the
  // lock, and drops it from the durable set.
  async unregister(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    entry.controller.abort();
    await entry.loop;
    entry.handle.release();
    this.entries.delete(id);
    this.persist();
    return true;
  }

  list(): ProjectListing[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, dir: e.dir }));
  }

  get(id: string): ProjectListing | null {
    const e = this.entries.get(id);
    return e === undefined ? null : { id: e.id, dir: e.dir };
  }

  // Resolve a `project` field (an id OR a dir path) to a registered listing.
  resolve(projectOrId: string): ProjectListing | null {
    if (this.entries.has(projectOrId)) {
      const e = this.entries.get(projectOrId);
      return e !== undefined ? { id: e.id, dir: e.dir } : null;
    }
    return this.get(projectId(projectOrId));
  }

  size(): number {
    return this.entries.size;
  }

  // Graceful shutdown: abort every watcher, await them, release every lock.
  // Idempotent. Does NOT clear the durable set — a restart re-attaches.
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const all = [...this.entries.values()];
    for (const e of all) e.controller.abort();
    await Promise.all(all.map((e) => e.loop));
    for (const e of all) e.handle.release();
    this.entries.clear();
  }

  private loggerFor(dir: string): DaemonLogger {
    return this.deps.makeLogger !== undefined ? this.deps.makeLogger(dir) : nullLogger;
  }

  private persist(): void {
    writeRegisteredProjects(
      this.deps.stateDir,
      [...this.entries.values()].map((e) => e.dir),
    );
  }
}
