// `createSandboxedExecutor` — the reusable executor SHELL: worktree
// provisioning/reuse + an injected backend runner + the worktree self-diff
// that feeds the file carrier honestly.
//
// This is a CONCRETE C2 `Executor` (the "how to run a spawn" seam), not a
// kernel API and not a domain branch. The shell knows nothing about how a
// spawn is actually run — that is the injected `runSpawn`, which the chosen
// backend (`claude -p`, or a future provider runner) supplies. The shell
// owns only the two things every headless backend needs identically:
//
//   1. an isolated git worktree per task (reused across re-resume), so the
//      agent's edits never touch the main tree;
//   2. a self-diff of that worktree (`gitDelta` against the provision-time
//      baseline) → `files_modified`/`files_created`, so the change-conditional
//      reviewers fire without trusting the backend to report its own delta.
//
// The loop set-unions these with the server-computed delta, so reporting them
// here is idempotent and a backend that reports nothing is still accounted
// for. The `agent_run_id` rides verbatim in the intent the loop hands us.
//
// Ambient runtime: this is transport OUTSIDE the kernel's replay graph.

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, ExecutorResult, SpawnUsage } from "./drive.js";
import { emptyDiffError } from "./executor-errors.js";
import { gitDelta, gitDiffText } from "./git-delta.js";
import { provisionWorktree, type WorktreeProvision } from "./worktree.js";

// One static directory/file to copy into the sandbox before the first spawn.
// `src` is an absolute path OUTSIDE the project (e.g. a bundle's bundled
// knowledge dir, resolved by the transport that knows the bundle); `rel` is the
// destination relative to the sandbox root (conventionally under `.loom/work/`).
// Generic by construction — the shell copies a path the transport hands it and
// names nothing about what the files are for.
export interface SandboxSeed {
  src: string;
  rel: string;
}

// Copy each seed into the freshly-provisioned sandbox. Idempotent (overwrites),
// so a re-resume that reuses the worktree simply refreshes them. Best-effort: a
// missing/absent source is skipped with a notice, never a fatal — a spawn whose
// seed didn't land still runs (it just can't read those files).
function seedSandbox(
  dir: string,
  seeds: readonly SandboxSeed[],
  onNotice?: (message: string) => void,
): void {
  for (const { src, rel } of seeds) {
    try {
      if (!existsSync(src)) continue;
      const dest = join(dir, rel);
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
    } catch (e) {
      onNotice?.(`could not seed '${rel}' into the sandbox: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Render the full textual self-diff into the sandbox so a later reviewer spawn —
// which runs in this SAME worktree — can read exactly what the implementer
// changed via its `.loom/work/diff.txt` input. Written after every spawn that
// has a baseline, so it always reflects the latest tree (a reviewer reads the
// copy the prior implementer spawn left). Best-effort: a reviewer without
// diff.txt still has the tree itself, so a write failure never fails the spawn.
function writeSandboxDiff(dir: string, baseline: string): void {
  try {
    const text = gitDiffText(dir, baseline);
    if (text === null) return;
    const workDir = join(dir, ".loom", "work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "diff.txt"), text, "utf8");
  } catch {
    /* best-effort — the worktree itself is always readable */
  }
}

// What a backend run returns: the agent's text output, optionally paired with
// per-spawn usage when the backend's envelope reports it. A plain string is
// still accepted (a backend that surfaces no usage just returns text), so
// existing runners need no change.
export interface RunSpawnResult {
  output: string;
  usage?: SpawnUsage;
}

// Predicate over a spawn intent: does THIS agent edit project files? It rides
// from the transport (which knows each agent's bundle-declared execution shape)
// into the shell so the empty-diff guard knows whom to hold to a non-empty diff.
export type ExpectsEdits = (intent: ProviderShuttleIntent) => boolean;

// The injected backend: run one spawn in `worktreeDir` and return the agent's
// output (text, or text + usage). Throws on failure — the loop's
// executor-retry / error-surfacing handles it (a thrown executor re-resumes
// the same agent_run_id, no double spawn).
export type RunSpawn = (
  intent: ProviderShuttleIntent,
  worktreeDir: string,
  signal?: AbortSignal,
) => Promise<string | RunSpawnResult>;

export interface SandboxedExecutorOptions {
  // The project root. The sandbox dir is derived deterministically from it.
  project_dir: string;
  // How a spawn is actually executed in the provisioned sandbox dir.
  runSpawn: RunSpawn;
  // How the per-task isolated working copy is provisioned (and reused across
  // re-resume). Default = a detached git worktree (`provisionWorktree`). The
  // container backend injects a dedicated-clone provisioner so the same
  // self-diff + reuse logic runs over a clone instead. The result's `dir` is
  // where the spawn runs and the tree the self-diff measures; `isolated:false`
  // surfaces the degraded notice. A provisioner that cannot isolate may throw
  // (the container's clone refuses a non-git project) rather than degrade.
  provision?: () => WorktreeProvision;
  // Aborts an in-flight backend run when the drive is cancelled.
  signal?: AbortSignal;
  // Sink for non-fatal notices (e.g. the degraded "no isolation" warning, or
  // a container backend's fallback notice). Omitted → notices are dropped.
  onNotice?: (message: string) => void;
  // Sink for per-spawn usage (tokens / cost) when the backend reports it.
  // Surfaced for audit/observability — the loop does not persist it. Omitted →
  // usage is dropped.
  onUsage?: (usage: SpawnUsage) => void;
  // Whether re-running a spawn (same agent_run_id) is safe. Default true: the
  // worktree is deterministic, a re-run just redoes the work in the isolated
  // tree, and the resume restart-head de-dups delivery through the ledger. A
  // deployment whose `runSpawn` has EXTERNAL side effects (a spawn that posts
  // to a real API) sets this false to keep the provider idempotency gate.
  idempotent?: boolean;
  // Static files to copy into the sandbox before the first spawn (e.g. a
  // bundle's bundled knowledge the agents are told to read). Copied once per
  // executor instance, only when the sandbox is isolated. The shell names
  // nothing about what they are — the transport hands it (src, rel) pairs.
  sandbox_seed?: readonly SandboxSeed[];
  // Predicate: does THIS spawn's agent edit project files? When it returns true
  // and the spawn's self-diff comes back empty (on an isolated tree), the spawn
  // FAILS with EXECUTOR_EMPTY_DIFF rather than returning a no-op result — so a
  // file-editing agent that touched nothing is caught here (fast, with a retry)
  // instead of riding an empty diff through the reviewers to the final gate.
  // Decision agents — reviewers, planners, classifiers, anything that writes no
  // project files — are EXEMPT: the predicate returns false for them, or is
  // omitted entirely (the default: no empty-diff check at all). The shell stays
  // domain-blind; the transport that knows which agents edit files supplies it.
  expects_edits?: ExpectsEdits;
}

// Merge two optional abort signals into one that fires when EITHER does. Used
// to fold the executor's construction-time signal together with the per-spawn
// signal the loop passes, so a child is torn down on whichever fires first.
function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}

export function createSandboxedExecutor(opts: SandboxedExecutorOptions): Executor {
  // Provision once per executor instance (one drive == one task), then reuse
  // for every spawn of that task. The deterministic worktree path makes a
  // SEPARATE executor instance (a re-resume) reuse the same worktree too.
  let provisioned: WorktreeProvision | null = null;
  const doProvision = opts.provision ?? ((): WorktreeProvision => provisionWorktree(opts.project_dir));
  const provision = (): WorktreeProvision => {
    if (provisioned === null) {
      provisioned = doProvision();
      // A provisioning notice (e.g. the heavy plain-copy fallback when
      // copy-on-write is unavailable) — surfaced once, never fatal.
      if (provisioned.notice !== undefined) opts.onNotice?.(provisioned.notice);
      if (!provisioned.isolated) {
        opts.onNotice?.(
          `sandbox isolation unavailable (not a git work tree); ` +
            `running in ${opts.project_dir} without isolation`,
        );
      }
      // Seed the isolated sandbox with any static files the transport supplied
      // (e.g. the bundle's knowledge refs) so a spawn can read them at a stable
      // path. Skipped when running un-isolated in the real tree — we never write
      // seed files into the operator's project.
      if (provisioned.isolated && opts.sandbox_seed !== undefined && opts.sandbox_seed.length > 0) {
        seedSandbox(provisioned.dir, opts.sandbox_seed, opts.onNotice);
      }
    }
    return provisioned;
  };

  return {
    // Re-running a spawn just redoes the work in the SAME deterministic
    // worktree (effects stay confined to the isolated tree), and the resume
    // restart-head reuses the agent_run_id with ledger-de-duped delivery — so
    // re-shuttle is safe even when the provider is declared non-idempotent.
    // This is what lets a daemon / control-plane attach to a pending spawn
    // (the create→drive gap) and recover one after a crash.
    idempotent: opts.idempotent ?? true,
    async execute(intent: ProviderShuttleIntent, signal?: AbortSignal): Promise<ExecutorResult> {
      const wt = provision();
      // Abort the backend run if EITHER signal fires: the construction-time one
      // (a host's graceful-shutdown / per-drive deadline) or the per-spawn one
      // the loop passes (a wall-time budget breach / cancel). Both reach the
      // child via `runSpawn` → `spawnCapture`.
      const ran = await opts.runSpawn(intent, wt.dir, combineSignals(opts.signal, signal));
      const agent_output = typeof ran === "string" ? ran : ran.output;
      const usage = typeof ran === "string" ? undefined : ran.usage;

      const result: ExecutorResult = { agent_output };
      if (usage !== undefined) {
        // Stamp the spawn's identity (agent + resolved model) onto the usage so
        // the observability sink can show WHICH agent + model it was for — the
        // sink fires here, decoupled from the intent, so the identity must ride
        // along. The kernel delivery path reads only `tokens`.
        const enriched: SpawnUsage = { ...usage, agent: intent.agent, model: intent.model };
        result.usage = enriched;
        opts.onUsage?.(enriched);
      }
      // Self-diff the isolated tree against the provision-time baseline so the
      // carrier is fed natively — no dependence on the backend to report it.
      const delta = gitDelta(wt.dir, wt.baseline);
      // Fail fast on an edit-expecting agent that changed nothing. An empty
      // self-diff from an agent whose job is to edit the project is a no-op —
      // the class of failure where a backend reads the plan, edits nothing, and
      // reports success; riding it downstream burns the whole review panel
      // before the final gate catches it. Gated on an isolated tree (the
      // un-isolated fallback writes nowhere, so its delta cannot be judged) and
      // on the transport's edit-expecting predicate. The throw rides the loop's
      // generic executor-retry, so the agent gets a re-run and a SECOND empty
      // diff parks the task.
      if (
        wt.isolated &&
        opts.expects_edits?.(intent) === true &&
        delta !== null &&
        delta.modified.length === 0 &&
        delta.created.length === 0
      ) {
        throw emptyDiffError(intent);
      }
      if (delta !== null) {
        if (delta.modified.length > 0) result.files_modified = delta.modified;
        if (delta.created.length > 0) result.files_created = delta.created;
      }
      // Leave the full textual diff beside the work area for the reviewers that
      // run next in this same worktree (best-effort, isolated trees only).
      if (wt.isolated && wt.baseline !== null) {
        writeSandboxDiff(wt.dir, wt.baseline);
      }
      return result;
    },
  };
}
