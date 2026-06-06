// Project-dir allowlist gate — every transport routes a `project_dir`
// through here BEFORE any state access.
//
// The allowlist is operator-authored (`~/.loom/projects.allow`, one
// absolute path per line; `#` comments, blank lines ignored). The
// kernel NEVER auto-populates it — a missing or non-matching file
// refuses every path (default-deny), so a client cannot self-enroll a
// project by calling the tool. Both the input and each allowlist entry
// are canonicalized through `realpath` so symlinked or `..`-laden paths
// compare on their resolved identity, closing the path-traversal hole.

import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { KernelError } from "../state/db.js";
import { userFootprintDir } from "./footprint.js";

export interface AssertProjectDirAllowedOptions {
  // Override the allowlist file location. Production callers omit it and
  // get `~/.loom/projects.allow`; tests point at a tmpfile so they
  // never read user-machine state.
  allowlistPath?: string;
}

// Resolve + authorize a project_dir. Returns the canonical (realpath'd)
// directory on success; throws `KernelError({code:
// "PROJECT_DIR_NOT_ALLOWED"})` on any miss.
export async function assertProjectDirAllowed(
  projectDir: string,
  opts?: AssertProjectDirAllowedOptions,
): Promise<string> {
  const allowlistPath = opts?.allowlistPath ?? defaultAllowlistPath();

  let canonicalInput: string;
  try {
    canonicalInput = await realpath(resolve(projectDir));
  } catch {
    // An input path that does not resolve on disk is refused rather than
    // trusted — there is nothing to authorize.
    throw refusal(projectDir, allowlistPath, "input-path-unresolved");
  }

  let raw: string;
  try {
    raw = await readFile(allowlistPath, "utf8");
  } catch {
    // Missing allowlist → nothing is permitted. The file is operator-
    // authored; its absence is a hard "no", not a permissive default.
    throw refusal(projectDir, allowlistPath, "allowlist-missing");
  }

  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  for (const entry of entries) {
    let canonicalEntry: string;
    try {
      canonicalEntry = await realpath(resolve(entry));
    } catch {
      // A stale allowlist line that no longer resolves is skipped, never
      // fatal — it must not block the other (valid) entries.
      continue;
    }
    if (canonicalEntry === canonicalInput) return canonicalInput;
  }

  throw refusal(projectDir, allowlistPath, "not-in-allowlist");
}

function defaultAllowlistPath(): string {
  return join(userFootprintDir(), "projects.allow");
}

function refusal(
  projectDir: string,
  allowlistPath: string,
  reason: string,
): KernelError {
  return new KernelError({
    code: "PROJECT_DIR_NOT_ALLOWED",
    message: `project_dir '${projectDir}' is not in the allowlist`,
    detail: { project_dir: projectDir, allowlist_path: allowlistPath, reason },
  });
}
