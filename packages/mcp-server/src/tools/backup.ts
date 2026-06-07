// pipeline_backup — consistent textual SQL snapshot of the kernel-owned
// tables.
//
// Composition: project-dir allowlist → path-traversal guard (a relative
// `to` resolves against project_dir; an escaping path is refused) →
// dump inside one withStateTransaction (BEGIN holds a consistent view) →
// write the file → return { bytes_written, ts, backup_path }.
//
// `ts` is the threaded NowToken passed to the transaction, NOT a fresh
// clock read, so the reported timestamp matches the snapshot boundary.

import { writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  assertProjectDirAllowed,
  captureNow,
  dumpStateSql,
  KernelError,
  withStateTransaction,
} from "@loomfsm/kernel";

import { kernelErrorOrThrow } from "../lib/refusal.js";
import type { BackupInput, BackupResponse, ToolHandler } from "../types.js";

export interface BackupDeps {
  allowlistPath?: string;
}

export function createBackupTool(
  deps: BackupDeps = {},
): ToolHandler<BackupInput, BackupResponse> {
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

    // 2. Path-traversal guard — the destination must stay within the
    //    project directory so a backup cannot be written to an arbitrary
    //    host location through a `..`-laden or absolute escape.
    let backupPath: string;
    try {
      backupPath = await resolveBackupPath(input.project_dir, input.to);
    } catch (err) {
      return refusal(err, now);
    }

    // 3. Consistent dump inside one transaction view.
    const sql = await withStateTransaction(input.project_dir, now, (tx) =>
      dumpStateSql(tx),
    );

    // 4. Write + report.
    writeFileSync(backupPath, sql, "utf8");
    return {
      bytes_written: Buffer.byteLength(sql, "utf8"),
      ts: now,
      backup_path: backupPath,
    };
  };
}

async function resolveBackupPath(projectDir: string, to: string): Promise<string> {
  const canonicalDir = await realpath(resolve(projectDir));
  const resolved = resolve(canonicalDir, to);
  if (resolved !== canonicalDir && !resolved.startsWith(canonicalDir + sep)) {
    throw new KernelError({
      code: "BACKUP_PATH_REJECTED",
      message: `backup destination '${to}' escapes the project directory`,
      detail: { to, project_dir: projectDir },
    });
  }
  return resolved;
}

function refusal(err: unknown, ts: string): BackupResponse {
  const ke = kernelErrorOrThrow(err);
  return {
    bytes_written: null,
    ts,
    backup_path: null,
    error: { code: ke.code, message: ke.message },
  };
}
