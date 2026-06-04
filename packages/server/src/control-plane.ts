// `startControlPlane` — assemble and run the whole control plane: claim the
// server lock, build the supervisor registry, re-attach the durable
// project set (and any `--project` dirs), start the HTTP transport on
// loopback, and wire graceful shutdown.
//
// It is bundle/provider-agnostic, exactly like `drive()` and the daemon: the
// caller injects `resolveRegistry` (the bundle/provider choice) and
// `buildExecutor` (how a spawn runs). The CLI's `loom serve` is the thin
// wrapper that injects `assembleRegistry` + the `claude -p` factory, mirroring
// `loom run` / `loom daemon`.

import type { AddressInfo } from "node:net";

import {
  systemClock,
  type Clock,
  type DaemonLogger,
  type ExecutorBuildContext,
  type Notifier,
  type RetryPolicy,
  type WakeOptions,
} from "@loomfsm/daemon";
import type { Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";
import type { Server } from "node:http";

import { createControlServer } from "./http.js";
import { acquireServerLock, type ServerHandle } from "./process-control.js";
import { SupervisorRegistry, type FleetMergeBack, type ProjectListing } from "./registry.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;

export interface ControlPlaneOptions {
  stateDir: string;
  host?: string;
  port?: number;
  token?: string;
  // Initial projects to supervise (in addition to the durable set).
  projects?: string[];

  resolveRegistry: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor: (projectDir: string, ctx: ExecutorBuildContext) => Executor;
  // Worktree integration on `complete`, applied fleet-wide. Omitted → the
  // supervisor default (worktree commit-to-branch). The CLI injects the clone
  // variant when serving in container mode.
  mergeBack?: FleetMergeBack;
  makeLogger?: (projectDir: string) => DaemonLogger;
  // Build the per-project outbound notify sink (the CLI injects the env-resolved
  // channels). The registry stamps each project's id onto its events, so a
  // fleet-wide channel can tell projects apart. Omitted → notify off.
  makeNotifier?: (projectDir: string) => Notifier;
  max_concurrent_spawns?: number;
  retry_policy?: RetryPolicy;
  wake?: WakeOptions;
  clock?: Clock;
  // Idle-poll cadence each watcher uses between tasks (default 5s).
  watch_idle_ms?: number;
  // Wait this long on a recognised rate-limit before re-driving (default 1h).
  rate_limit_wait_ms?: number;
  // Abort a single drive that runs past this wall-time (a hung spawn).
  drive_deadline_ms?: number;

  // Shutdown trigger (the CLI wires SIGINT/SIGTERM; a test drives it directly).
  signal?: AbortSignal;
  // Test seam for the advisory lock's pid.
  pid?: number;
  // Operational logging for the server lifecycle (NOT per-project audit).
  serverLog?: (line: string) => void;

  // ----- control-layer (config / secrets / workspace) API -----
  // When set, the HTTP server exposes the config/workspace routes over the SAME
  // `@loomfsm/config` stores the CLI writes. The CLI injects the resolved global
  // home; omitted → the config API is off (the existing routes are unaffected).
  loomHome?: string;
  // A LIVE env cell (config overlay under the real env) the config routes read
  // for secret resolution + backend availability — re-resolved per call so an
  // edit is seen on the next read.
  configEnv?: () => NodeJS.ProcessEnv;
  // Bust the per-project registry-routing cache after a config write so a
  // changed model lands on the next spawn (the CLI wires the bootstrap resolver).
  invalidateRegistry?: (projectDir?: string) => void;
  // Whether the Claude Code CLI is available (surfaced by `GET /providers`).
  claudeAvailable?: () => boolean;
  // Override the dashboard's built-asset directory (default: resolved from the
  // `@loomfsm/dashboard` workspace dependency). A test injects a fixture dir.
  dashboardDir?: string;
}

export interface ControlPlaneHandle {
  host: string;
  port: number;
  registry: SupervisorRegistry;
  server: Server;
  attached: ProjectListing[];
  // Stop everything: drain the fleet, close the socket, release the lock.
  // Idempotent.
  stop(): Promise<void>;
  // Resolves once a `stop()` has fully completed (the await-to-exit handle).
  closed: Promise<void>;
}

export async function startControlPlane(opts: ControlPlaneOptions): Promise<ControlPlaneHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const desiredPort = opts.port ?? DEFAULT_PORT;
  const clock = opts.clock ?? systemClock;
  const log = opts.serverLog ?? ((): void => {});

  // Claim the control plane (refuses if a live one already owns this state dir).
  const lock: ServerHandle = acquireServerLock(opts.stateDir, host, desiredPort, {
    clock,
    ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
  });

  const registry = new SupervisorRegistry({
    resolveRegistry: opts.resolveRegistry,
    buildExecutor: opts.buildExecutor,
    stateDir: opts.stateDir,
    ...(opts.mergeBack !== undefined ? { mergeBack: opts.mergeBack } : {}),
    ...(opts.makeLogger !== undefined ? { makeLogger: opts.makeLogger } : {}),
    ...(opts.makeNotifier !== undefined ? { makeNotifier: opts.makeNotifier } : {}),
    ...(opts.max_concurrent_spawns !== undefined
      ? { max_concurrent_spawns: opts.max_concurrent_spawns }
      : {}),
    ...(opts.retry_policy !== undefined ? { retry_policy: opts.retry_policy } : {}),
    ...(opts.wake !== undefined ? { wake: opts.wake } : {}),
    ...(opts.watch_idle_ms !== undefined ? { watch_idle_ms: opts.watch_idle_ms } : {}),
    ...(opts.rate_limit_wait_ms !== undefined ? { rate_limit_wait_ms: opts.rate_limit_wait_ms } : {}),
    ...(opts.drive_deadline_ms !== undefined ? { drive_deadline_ms: opts.drive_deadline_ms } : {}),
    clock,
  });

  // Re-attach the durable set first (the fleet-wide recovery head), then add
  // any explicitly-requested projects (idempotent — a dir in both is one
  // watcher).
  const attached = await registry.recover();
  for (const dir of opts.projects ?? []) {
    try {
      attached.push(registry.register(dir));
    } catch (err) {
      log(`loom serve: could not supervise ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const server = createControlServer({
    registry,
    resolveRegistry: opts.resolveRegistry,
    ...(opts.token !== undefined && opts.token.length > 0 ? { token: opts.token } : {}),
    ...(opts.loomHome !== undefined ? { loomHome: opts.loomHome } : {}),
    ...(opts.configEnv !== undefined ? { configEnv: opts.configEnv } : {}),
    ...(opts.invalidateRegistry !== undefined ? { invalidateRegistry: opts.invalidateRegistry } : {}),
    ...(opts.claudeAvailable !== undefined ? { claudeAvailable: opts.claudeAvailable } : {}),
    ...(opts.dashboardDir !== undefined ? { dashboardDir: opts.dashboardDir } : {}),
    onError: (err) => log(`loom serve: internal error: ${err instanceof Error ? err.message : String(err)}`),
  });

  const port = await listen(server, desiredPort, host);
  lock.update("serving", registry.size());

  // ----- graceful shutdown -----
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      lock.update("stopping", registry.size());
      await registry.shutdown();
      await closeServer(server);
      lock.release();
      log("loom serve: stopped");
      resolveClosed();
    })();
    return stopping;
  };

  if (opts.signal !== undefined) {
    if (opts.signal.aborted) void stop();
    else opts.signal.addEventListener("abort", () => void stop(), { once: true });
  }

  return { host, port, registry, server, attached, stop, closed };
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const addr = server.address() as AddressInfo | null;
      resolve(addr !== null && typeof addr === "object" ? addr.port : port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    // `close` waits for open connections (an SSE stream) to end; the registry
    // shutdown already aborted the watchers, and the dashboard's EventSource
    // closes on the next failed tick. Nudge any idle keep-alives shut.
    server.closeAllConnections?.();
  });
}
