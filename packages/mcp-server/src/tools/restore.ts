// pipeline_restore — restore project state from a backup.
//
// Two formats:
//   sql    — the dump is UNTRUSTED input. It is parsed through the DDL
//            allowlist (parseRestoreSql), which classifies each statement
//            and refuses anything outside the allowed set; the parsed,
//            allowlisted statements are then applied inside one
//            withStateTransaction. A backup file never reaches
//            `db.exec(rawSql)` — an out-of-allowlist statement surfaces
//            RESTORE_REJECTED naming the offender.
//   binary — operator-explicit ("trust the source file"): close the
//            project connection and copy the .db over the project's
//            state.db with no kernel validation. The next kernel start
//            re-applies migrations and refuses on schema mismatch.
//
// Both formats refuse without confirm:true (RESTORE_CONFIRM_REQUIRED) and
// thread the NowToken for `ts`.

import { copyFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  applyRestoreStatements,
  assertProjectDirAllowed,
  captureNow,
  closeDb,
  KernelError,
  parseRestoreSql,
  withStateTransaction,
} from "@loomfsm/kernel";

import type { RestoreInput, RestoreResponse, ToolHandler } from "../types.js";

export interface RestoreDeps {
  allowlistPath?: string;
}

export function createRestoreTool(
  deps: RestoreDeps = {},
): ToolHandler<RestoreInput, RestoreResponse> {
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

    // 2. A restore overwrites canonical state — require explicit confirm.
    if (input.confirm !== true) {
      return {
        restored: false,
        ts: now,
        error: {
          code: "RESTORE_CONFIRM_REQUIRED",
          message: "pipeline_restore overwrites state and requires confirm:true",
        },
      };
    }

    const from = resolve(input.project_dir, input.from);

    if (input.format === "binary") {
      // Operator-explicit file swap — no kernel validation.
      try {
        closeDb(input.project_dir);
        const dest = join(input.project_dir, ".claude", "state.db");
        copyFileSync(from, dest);
      } catch (err) {
        return refusal(err, now);
      }
      return { restored: true, ts: now };
    }

    // SQL path — parse the untrusted dump, then apply the allowlisted set.
    let statements: string[];
    try {
      const sql = readFileSync(from, "utf8");
      statements = parseRestoreSql(sql);
    } catch (err) {
      return refusal(err, now);
    }

    try {
      await withStateTransaction(input.project_dir, now, (tx) =>
        applyRestoreStatements(tx, statements),
      );
    } catch (err) {
      return refusal(err, now);
    }

    return { restored: true, ts: now };
  };
}

function refusal(err: unknown, ts: string): RestoreResponse {
  if (err instanceof KernelError) {
    return { restored: false, ts, error: { code: err.code, message: err.message } };
  }
  if (err instanceof Error) {
    return { restored: false, ts, error: { code: "RESTORE_FAILED", message: err.message } };
  }
  throw err;
}
