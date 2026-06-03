// Build the per-spawn dispatching executor every command drives through — the
// place loom's STORED config (backend mode + per-agent model map + secrets)
// becomes REAL per-agent execution.
//
// One resolution per spawn: read the agent's model family from the (layered)
// config, resolve the backend for it (`auto` = CC-first, or a validated pin),
// resolve that backend's credential, and build/cache the matching executor —
// a `claude -p` worktree run for Claude Code, a plain raw model call otherwise.
// `createDispatchExecutor` (in @loomfsm/driver) is the backend-blind shell that
// routes each spawn to the executor this resolver returns; the loop and the
// kernel learn nothing new.
//
// Transport-neutral: the CLI builds this resolver; the driver only calls it.

import {
  AUTO_BACKEND,
  bundleAgentMap,
  parseModelRef,
  resolveBackend,
  resolveBackendCredential,
  resolveConfig,
} from "@loomfsm/config";
// `@loomfsm/driver` (and thus `@loomfsm/kernel` → `node:sqlite`) is imported
// LAZILY in `execute` so loading this module does not pull SQLite into the
// flag-free commands (`loom --version` / `setup`); types are erased.
import type { Executor, ResolveExecutor, SpawnUsage } from "@loomfsm/driver";

import { buildClaudeCodeBackend, buildRawBackend, type BackendSinks } from "./backends.js";
import type { ContainerPlan } from "./container.js";
import type { SpawnTimeouts } from "./resilience.js";

const CLAUDE_CODE_BACKEND = "claude-code";

export interface DispatchExecutorArgs {
  projectDir: string;
  // Lazily yields the active bundle's name (to index the per-(bundle,agent)
  // model map). `run`/`daemon` already hold the registry; `serve` resolves it
  // per project, so this is a thunk rather than a value.
  resolveBundleName: () => string | Promise<string>;
  // The effective env (config overlay under the real environment) — read for
  // config layers, the CC bin name, the permission mode, and secret fallback.
  env: NodeJS.ProcessEnv;
  // OS home for `~` expansion when locating the global config store.
  home: string;
  // The container toggle's resolved plan (shapes only the Claude Code backend;
  // raw backends never run in a container — they touch no files).
  plan: ContainerPlan;
  timeouts: SpawnTimeouts;
  // Whether the Claude Code CLI is available (a PATH probe, bound to the bin).
  claudeAvailable: () => boolean;
  onNotice: (message: string) => void;
  onUsage: (usage: SpawnUsage) => void;
  signal?: AbortSignal;
  // Test seam: replace backend executor construction with a stub keyed by
  // backend name, so a suite exercises the resolution/routing without real SDKs
  // or the Claude Code CLI.
  buildBackendExecutor?: (backend: string, sinks: BackendSinks) => Executor | Promise<Executor>;
}

export interface PreflightArgs {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  bundleName: string;
  agents: string[];
  claudeAvailable: () => boolean;
}

// Upfront check: would the dispatch serve ANY of these agents under the current
// config? Returns a hard error only when EVERY agent's backend is unresolvable
// — e.g. the default `auto` routing needs Claude Code, the CLI is absent, and no
// provider is configured — so a hopeless drive refuses cleanly before it starts
// (the same fast "install Claude Code / configure a provider" message the
// single-backend build gave). When at least one agent resolves, the drive
// proceeds and an un-runnable spawn surfaces its own error only if reached.
// Pure (config + the injected CC probe) — no SQLite, no driver import.
export function preflightDispatch(args: PreflightArgs): { ok: true } | { ok: false; error: string } {
  const resolved = resolveConfig({ projectDir: args.projectDir, env: args.env, home: args.home });
  const configBackend = resolved.merged.backend ?? AUTO_BACKEND;
  const ccAvailable = args.claudeAvailable();
  const refs = bundleAgentMap(resolved.merged, args.bundleName);

  const errors: string[] = [];
  let anyOk = false;
  for (const agent of args.agents) {
    const ref = refs[agent];
    const family = ref !== undefined ? parseModelRef(ref).family : undefined;
    const res = resolveBackend({ configBackend, family, ccAvailable });
    if (res.ok) anyOk = true;
    else if (!errors.includes(res.error)) errors.push(res.error);
  }
  if (!anyOk && errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true };
}

export function buildDispatchExecutor(args: DispatchExecutorArgs): Executor {
  const resolved = resolveConfig({ projectDir: args.projectDir, env: args.env, home: args.home });
  const configBackend = resolved.merged.backend ?? AUTO_BACKEND;
  const ccAvailable = args.claudeAvailable();
  const permissionMode = args.env["LOOM_CLAUDE_PERMISSION_MODE"];

  const sinks: BackendSinks = {
    onNotice: args.onNotice,
    onUsage: args.onUsage,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  };

  // The per-(bundle,agent) refs, resolved once on first spawn (the bundle name
  // may itself be async for `serve`).
  let agentRefsP: Promise<Record<string, string>> | undefined;
  const agentRefs = (): Promise<Record<string, string>> => {
    if (agentRefsP === undefined) {
      agentRefsP = Promise.resolve(args.resolveBundleName()).then((name) =>
        bundleAgentMap(resolved.merged, name),
      );
    }
    return agentRefsP;
  };

  // One executor per backend for the whole drive (the deterministic worktree is
  // shared across CC spawns; a raw client is reused).
  const cache = new Map<string, Promise<Executor>>();
  const noticed = new Set<string>();

  const make = (backend: string): Promise<Executor> => {
    if (args.buildBackendExecutor !== undefined) {
      return Promise.resolve(args.buildBackendExecutor(backend, sinks));
    }
    if (backend === CLAUDE_CODE_BACKEND) {
      return buildClaudeCodeBackend(
        {
          project_dir: args.projectDir,
          plan: args.plan,
          ...(permissionMode !== undefined && permissionMode !== ""
            ? { permission_mode: permissionMode }
            : {}),
          timeouts: args.timeouts,
        },
        sinks,
      );
    }
    const override = resolved.merged.credentials?.[backend];
    const creds = resolveBackendCredential(backend, {
      loomHome: resolved.home,
      env: args.env,
      ...(override !== undefined ? { override } : {}),
    });
    return buildRawBackend(backend, creds, sinks);
  };

  const resolveExecutor: ResolveExecutor = async (intent) => {
    const refs = await agentRefs();
    const ref = refs[intent.agent];
    const family = ref !== undefined ? parseModelRef(ref).family : undefined;
    const res = resolveBackend({ configBackend, family, ccAvailable });
    if (!res.ok) throw new Error(res.error);
    if (res.notice !== undefined && !noticed.has(res.backend)) {
      noticed.add(res.backend);
      args.onNotice(res.notice);
    }
    let exec = cache.get(res.backend);
    if (exec === undefined) {
      exec = make(res.backend);
      cache.set(res.backend, exec);
    }
    return exec;
  };

  // Build via the driver's canonical dispatch shell (single source of the
  // dispatch semantics, incl. the idempotent default), imported lazily on the
  // first spawn so this module stays SQLite-free at load. `idempotent: true`
  // matches the shell's default — the resume restart-head behaves exactly as the
  // single-executor model did.
  let inner: Executor | undefined;
  return {
    idempotent: true,
    async execute(intent) {
      if (inner === undefined) {
        const { createDispatchExecutor } = await import("@loomfsm/driver");
        inner = createDispatchExecutor({ resolveExecutor });
      }
      return inner.execute(intent);
    },
  };
}
