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

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, ExecutorResult, SpawnUsage } from "./drive.js";
import { gitDelta } from "./git-delta.js";
import { provisionWorktree, type WorktreeProvision } from "./worktree.js";

// What a backend run returns: the agent's text output, optionally paired with
// per-spawn usage when the backend's envelope reports it. A plain string is
// still accepted (a backend that surfaces no usage just returns text), so
// existing runners need no change.
export interface RunSpawnResult {
  output: string;
  usage?: SpawnUsage;
}

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
      if (!provisioned.isolated) {
        opts.onNotice?.(
          `sandbox isolation unavailable (not a git work tree); ` +
            `running in ${opts.project_dir} without isolation`,
        );
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
    async execute(intent: ProviderShuttleIntent): Promise<ExecutorResult> {
      const wt = provision();
      const ran = await opts.runSpawn(intent, wt.dir, opts.signal);
      const agent_output = typeof ran === "string" ? ran : ran.output;
      const usage = typeof ran === "string" ? undefined : ran.usage;

      const result: ExecutorResult = { agent_output };
      if (usage !== undefined) {
        result.usage = usage;
        opts.onUsage?.(usage);
      }
      // Self-diff the isolated tree against the provision-time baseline so the
      // carrier is fed natively — no dependence on the backend to report it.
      const delta = gitDelta(wt.dir, wt.baseline);
      if (delta !== null) {
        if (delta.modified.length > 0) result.files_modified = delta.modified;
        if (delta.created.length > 0) result.files_created = delta.created;
      }
      return result;
    },
  };
}
