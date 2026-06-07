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
  bundleAgentFallbacks,
  bundleAgentMap,
  parseModelRef,
  resolveBackend,
  resolveBackendCredential,
  resolveConfig,
} from "@loomfsm/config";
// `@loomfsm/driver` (and thus `@loomfsm/kernel` → `node:sqlite`) is imported
// LAZILY in `execute` so loading this module does not pull SQLite into the
// flag-free commands (`loom --version` / `setup`); types are erased.
import type { ChainEntry, Executor, ResolveExecutor, SandboxSeed, SpawnUsage } from "@loomfsm/driver";
import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import {
  aiderModelString,
  buildAiderBackend,
  buildClaudeCodeBackend,
  buildOpencodeBackend,
  buildRawBackend,
  familyCredBackend,
  harnessChildEnv,
  opencodeModelString,
  type BackendSinks,
} from "./backends.js";
import type { ContainerPlan } from "./container.js";
import { resolveHarnessSpawnTimeouts, type SpawnTimeouts } from "./resilience.js";

const CLAUDE_CODE_BACKEND = "claude-code";
const AIDER_BACKEND = "aider";
const OPENCODE_BACKEND = "opencode";
// Default agentic harness for a work-agent on a non-Claude family backend.
// opencode runs a real multi-step tool loop (read → reason → edit → iterate) in
// one headless invocation, so a work-agent can follow a "read the plan, then
// implement" prompt and actually land edits. The alternative (aider) drives a
// SINGLE non-interactive `--message` turn: a model that opens with "let me read
// the plan first" gets no second turn and produces ZERO edits, which a weaker
// model does reliably. opencode is the safer default for headless work-agents;
// aider stays available via LOOM_HARNESS / config.harness.
const DEFAULT_HARNESS = OPENCODE_BACKEND;

// The agentic-CLI harness backends. A spawn whose resolved backend is one of
// these runs through that CLI harness (worktree + tool loop); it is also the set
// a raw family backend's work-agent falls back to via the configured default.
const HARNESS_BACKENDS = new Set<string>([AIDER_BACKEND, OPENCODE_BACKEND]);

// Generic, bundle-DECLARED per-agent execution shape — "agentic" means the spawn
// edits files and needs a tool harness; "single-shot" is one model call. The
// dispatcher reads it by agent NAME (via an injected hook) and hardcodes none.
export type AgentExecution = "single-shot" | "agentic";

// Which concrete harness a spawn runs under, after backend + execution-shape are
// resolved. CC carries its own loop; aider/opencode are the non-CC work-agent
// harnesses; plain is a single raw model call.
export type Harness = "claude-code" | "aider" | "opencode" | "plain";

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
  // Static files to seed into each Claude Code sandbox before its first spawn
  // (e.g. the active bundle's bundled knowledge, resolved by the transport that
  // knows the bundle). A thunk, resolved lazily on the first Claude Code spawn,
  // so a transport whose bundle name is async (serve, per project) can await it.
  // Only the Claude Code backend — worktree or container — is sandboxed; raw
  // model calls touch no files, so the seed never reaches them.
  sandbox_seed?: () => readonly SandboxSeed[] | Promise<readonly SandboxSeed[]>;
  // Per-agent execution shape (generic, bundle-DECLARED, surfaced by the
  // transport from the bundle's sidecar). "agentic" → on a non-Claude backend
  // the spawn runs through the Aider worktree harness; "single-shot" → a plain
  // raw model call. Omitted → every agent single-shot, so B-era decision-agent
  // routing is unchanged. Read by agent NAME; the dispatcher hardcodes none.
  resolveAgentExecution?: (agent: string) => AgentExecution | Promise<AgentExecution>;
  // Test seam: replace backend executor construction with a stub keyed by
  // backend name + the resolved harness, so a suite exercises the
  // resolution/routing (incl. single-shot vs agentic harness selection) without
  // real SDKs, the Aider CLI, or the Claude Code CLI.
  buildBackendExecutor?: (
    backend: string,
    sinks: BackendSinks,
    harness: Harness,
  ) => Executor | Promise<Executor>;
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
  // Default agentic harness for a work-agent on a raw family backend: env wins,
  // then config, then the first shipped adapter. Validated lazily (only when an
  // agentic spawn actually needs it) so an unused bad value never breaks a drive.
  const defaultHarness = args.env["LOOM_HARNESS"] ?? resolved.merged.harness ?? DEFAULT_HARNESS;

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

  // The per-(bundle,agent) ORDERED fallback chains, resolved once on first spawn.
  let fallbacksP: Promise<Record<string, string[]>> | undefined;
  const agentFallbacks = (): Promise<Record<string, string[]>> => {
    if (fallbacksP === undefined) {
      fallbacksP = Promise.resolve(args.resolveBundleName()).then((name) =>
        bundleAgentFallbacks(resolved.merged, name),
      );
    }
    return fallbacksP;
  };

  // One executor per (backend, harness[, family]) for the whole drive (the
  // deterministic worktree is shared across CC/aider spawns; a raw client is
  // reused). A backend that serves BOTH a work-agent and a decision-agent builds
  // the two harness shapes separately.
  const cache = new Map<string, Promise<Executor>>();
  const noticed = new Set<string>();

  // Map a spawn → the harness CLI's `--model` string from the agent's configured
  // ref (so a mixed-model backend works); a bare/absent ref falls back to the
  // resolved model verbatim. `modelFn` is the per-CLI family→prefix mapper.
  const harnessResolveModel =
    (refs: Record<string, string>, modelFn: (family: string | undefined, model: string) => string) =>
    (intent: ProviderShuttleIntent): string => {
      const r = refs[intent.agent];
      if (r === undefined) return intent.model;
      const p = parseModelRef(r);
      return modelFn(p.family, p.model);
    };

  // A fallback entry pins ONE concrete model (a specific fallback ref), so its
  // harness `resolveModel` is constant rather than reading the per-agent map.
  // Absent → the primary path (the harness reads the agent's ref dynamically).
  interface ModelPin {
    family: string | undefined;
    model: string;
  }

  const make = (
    backend: string,
    harness: Harness,
    family: string | undefined,
    refs: Record<string, string>,
    modelPin?: ModelPin,
  ): Promise<Executor> => {
    if (args.buildBackendExecutor !== undefined) {
      return Promise.resolve(args.buildBackendExecutor(backend, sinks, harness));
    }
    if (backend === CLAUDE_CODE_BACKEND) {
      return Promise.resolve(args.sandbox_seed?.() ?? []).then((seed) =>
        buildClaudeCodeBackend(
          {
            project_dir: args.projectDir,
            plan: args.plan,
            ...(permissionMode !== undefined && permissionMode !== ""
              ? { permission_mode: permissionMode }
              : {}),
            timeouts: args.timeouts,
            ...(seed.length > 0 ? { sandbox_seed: seed } : {}),
          },
          sinks,
        ),
      );
    }
    // A raw / non-CC backend. For an explicit harness pin (`aider`/`opencode`)
    // the credential family comes from the agent's model ref; otherwise the
    // backend IS the family's raw backend.
    const credBackend = HARNESS_BACKENDS.has(backend) ? familyCredBackend(family) : backend;
    const override = resolved.merged.credentials?.[credBackend];
    const creds = resolveBackendCredential(credBackend, {
      loomHome: resolved.home,
      env: args.env,
      ...(override !== undefined ? { override } : {}),
    });
    // The non-CC harnesses get the SHORTER harness session cap: they retry
    // internally on a flaky/rate-limited model, so a wedged run is opaque to
    // loom until the cap fires — a generous cap burns tokens with no result.
    const harnessTimeouts = resolveHarnessSpawnTimeouts(args.env);
    if (harness === "aider") {
      return buildAiderBackend(
        {
          project_dir: args.projectDir,
          resolveModel:
            modelPin !== undefined
              ? () => aiderModelString(modelPin.family, modelPin.model)
              : harnessResolveModel(refs, aiderModelString),
          env: harnessChildEnv(args.env, family, creds),
          timeouts: harnessTimeouts,
        },
        sinks,
      );
    }
    if (harness === "opencode") {
      return buildOpencodeBackend(
        {
          project_dir: args.projectDir,
          resolveModel:
            modelPin !== undefined
              ? () => opencodeModelString(modelPin.family, modelPin.model)
              : harnessResolveModel(refs, opencodeModelString),
          env: harnessChildEnv(args.env, family, creds),
          timeouts: harnessTimeouts,
        },
        sinks,
      );
    }
    return buildRawBackend(backend, creds, sinks);
  };

  // Select the harness for a (backend, agent-execution) pair — the same logic the
  // primary resolver applies, factored out so the fallback resolver reuses it.
  const selectHarness = (backend: string, execution: AgentExecution): Harness => {
    if (backend === CLAUDE_CODE_BACKEND) return "claude-code";
    if (HARNESS_BACKENDS.has(backend)) return backend as Harness;
    if (execution === "agentic") {
      if (!HARNESS_BACKENDS.has(defaultHarness)) {
        throw new Error(
          `unknown harness '${defaultHarness}' — set LOOM_HARNESS or config.harness to one of: ` +
            [...HARNESS_BACKENDS].join(", "),
        );
      }
      return defaultHarness as Harness;
    }
    return "plain";
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
    // Harness shape: Claude Code carries its own loop. A backend that IS a
    // harness CLI (an explicit `aider`/`opencode` pin) uses that harness for all
    // its spawns. Otherwise, on a raw family backend, a work-agent (agentic) gets
    // the configured default harness and a decision-agent a single model call.
    const execution = await Promise.resolve(
      (args.resolveAgentExecution ?? (() => "single-shot" as const))(intent.agent),
    );
    const harness = selectHarness(res.backend, execution);
    // Key by (harness, backend, family) for a CLI harness so a backend serving
    // both a work-agent and a decision-agent — or a mixed-family pin — builds the
    // distinct shapes separately; plain/CC key by (backend, harness).
    const isHarnessCli = harness === "aider" || harness === "opencode";
    const key = isHarnessCli ? `${harness}:${res.backend}:${family ?? ""}` : `${res.backend}:${harness}`;
    let exec = cache.get(key);
    if (exec === undefined) {
      exec = make(res.backend, harness, family, refs);
      cache.set(key, exec);
    }
    return exec;
  };

  // Resolve ONE fallback ref → a chain entry, or null when its backend cannot be
  // served (no credential / CC absent / no wired executor) — a misconfigured
  // fallback is skipped, never fatal. The entry pins the fallback ref's model so
  // the overridden intent (and the harness, via `modelPin`) run THAT model.
  const resolveFallbackEntry = async (
    intent: ProviderShuttleIntent,
    ref: string,
    refs: Record<string, string>,
  ): Promise<ChainEntry | null> => {
    try {
      const parsed = parseModelRef(ref);
      const family = parsed.family;
      const res = resolveBackend({ configBackend, family, ccAvailable });
      if (!res.ok) return null;
      const execution = await Promise.resolve(
        (args.resolveAgentExecution ?? (() => "single-shot" as const))(intent.agent),
      );
      const harness = selectHarness(res.backend, execution);
      const modelPin: ModelPin = { family, model: parsed.model };
      const isHarnessCli = harness === "aider" || harness === "opencode";
      // Harness entries bake the model in (constant resolveModel), so key by the
      // ref; CC/raw entries are model-agnostic (model rides on the intent), so
      // they share the primary cache key.
      const key = isHarnessCli
        ? `fb:${harness}:${res.backend}:${family ?? ""}:${parsed.model}`
        : `${res.backend}:${harness}`;
      let exec = cache.get(key);
      if (exec === undefined) {
        exec = make(res.backend, harness, family, refs, isHarnessCli ? modelPin : undefined);
        cache.set(key, exec);
      }
      // Surface a credential / build failure as "skip" rather than propagate.
      const executor = await exec;
      return { executor, model: parsed.model, label: ref };
    } catch {
      // A fallback that cannot be built (missing key, uninstalled provider) is
      // simply not offered — the chain advances past it.
      return null;
    }
  };

  // The ORDERED chain for one spawn: the primary first (model unchanged — the
  // kernel already resolved it), then each configured fallback that resolves.
  const resolveChain = async (intent: ProviderShuttleIntent): Promise<ChainEntry[]> => {
    const primary: ChainEntry = { executor: await resolveExecutor(intent) };
    const chains = await agentFallbacks();
    const refs = await agentRefs();
    const fallbackRefs = chains[intent.agent] ?? [];
    const entries: ChainEntry[] = [primary];
    for (const ref of fallbackRefs) {
      const entry = await resolveFallbackEntry(intent, ref, refs);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  };

  // Build via the driver's canonical dispatch shell (single source of the
  // dispatch semantics, incl. the idempotent default), imported lazily on the
  // first spawn so this module stays SQLite-free at load. `idempotent: true`
  // matches the shell's default — the resume restart-head behaves exactly as the
  // single-executor model did. The chain resolver advances to a configured
  // fallback on a rate-limit / permanent provider error.
  let inner: Executor | undefined;
  return {
    idempotent: true,
    async execute(intent) {
      if (inner === undefined) {
        const { createDispatchExecutor } = await import("@loomfsm/driver");
        inner = createDispatchExecutor({ resolveExecutorChain: resolveChain, onNotice: args.onNotice });
      }
      return inner.execute(intent);
    },
  };
}
