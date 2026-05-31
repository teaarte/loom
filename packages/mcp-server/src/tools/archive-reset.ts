// pipeline_archive_and_reset — rotate this project's finished task into
// history and free the single-task slot, so the next task starts clean.
//
// Composition: project-dir allowlist → archiveAndReset (the kernel guard:
// a terminal task archives cleanly; an in-progress task is refused unless
// force:true so a live run is never discarded; no live store is a no-op).
//
// This is the manual instrument for the jammed case — a terminal task that
// was never rotated keeps blocking new tasks, and this tool clears it even
// when the normal create path refuses. It does NOT need a registry and
// runs no FSM tick, so it works regardless of the project's flow wiring.
//
// `ts` is the threaded NowToken (the archival stamp), not a fresh clock
// read, so the reported timestamp matches the archive boundary.

import {
  archiveAndReset,
  assertProjectDirAllowed,
  captureNow,
  KernelError,
} from "@loomfsm/kernel";

import type { ArchiveResetInput, ArchiveResetResponse, ToolHandler } from "../types.js";

export interface ArchiveResetDeps {
  allowlistPath?: string;
}

export function createArchiveResetTool(
  deps: ArchiveResetDeps = {},
): ToolHandler<ArchiveResetInput, ArchiveResetResponse> {
  return async (input) => {
    const now = captureNow();

    // 1. Project-dir allowlist.
    try {
      await assertProjectDirAllowed(
        input.project_dir,
        deps.allowlistPath !== undefined ? { allowlistPath: deps.allowlistPath } : undefined,
      );
    } catch (err) {
      return refusal(err, now);
    }

    // 2. Guarded archival. In-progress without force → PROJECT_TASK_ACTIVE.
    try {
      const result = await archiveAndReset(
        input.project_dir,
        now,
        input.force === true ? { force: true } : undefined,
      );
      return {
        archived: result.archived,
        task_id: result.task_id,
        history_path: result.history_path,
        ts: now,
      };
    } catch (err) {
      return refusal(err, now);
    }
  };
}

function refusal(err: unknown, ts: string): ArchiveResetResponse {
  if (err instanceof KernelError) {
    return {
      archived: false,
      task_id: null,
      history_path: null,
      ts,
      error: { code: err.code, message: err.message },
    };
  }
  throw err;
}
