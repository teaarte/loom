// Project-dir allowlist gate — every transport routes a `project_dir`
// through here BEFORE any state access.
//
// The allowlist is operator-authored (`~/.loom/projects.allow`, one
// absolute path per line; `#` comments, blank lines ignored). The GATE
// (`assertProjectDirAllowed`) NEVER self-populates — a missing or
// non-matching file refuses every path (default-deny), so an agent / tool
// call (e.g. an MCP `project_dir` arg) can never enroll itself just by
// being driven. Enrollment is a SEPARATE, EXPLICIT operator action:
// `enrollProjectDir` appends a dir, invoked only by a deliberate human
// gesture (the dashboard "add project" folder-pick) — never by the gate
// or any drive path. Both the input and each allowlist entry are
// canonicalized through `realpath` so symlinked or `..`-laden paths compare
// on their resolved identity, closing the path-traversal hole.

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

  const allowed = await canonicalAllowlist(raw);
  if (allowed.has(canonicalInput)) return canonicalInput;

  throw refusal(projectDir, allowlistPath, "not-in-allowlist");
}

export interface EnrollProjectDirOptions {
  // Override the allowlist file location — same contract as
  // `AssertProjectDirAllowedOptions.allowlistPath`. Production omits it.
  allowlistPath?: string;
}

// Append a project_dir to the operator allowlist as the result of an EXPLICIT
// operator action (the dashboard "add project" gesture), NOT a drive path — the
// gate above still default-denies, so an agent / tool call can never reach this.
// The dir is canonicalized (`realpath`) before comparison and append, so the
// stored line is a stable identity and symlink/`..` aliases dedupe correctly.
// Idempotent: a dir already authorized is a no-op (`added: false`). The operator's
// file is preserved verbatim (comments + ordering); a header seeds an empty/new
// file. Throws only when the input does not resolve on disk or the allowlist is
// unwritable — the caller treats enrollment as best-effort so a catalog add of a
// not-yet-existing dir never fails here.
export async function enrollProjectDir(
  projectDir: string,
  opts?: EnrollProjectDirOptions,
): Promise<{ dir: string; added: boolean }> {
  const allowlistPath = opts?.allowlistPath ?? defaultAllowlistPath();

  // Resolve the input the same way the gate does — there is nothing to authorize
  // for a path that does not exist on disk.
  const canonical = await realpath(resolve(projectDir));

  let raw = "";
  try {
    raw = await readFile(allowlistPath, "utf8");
  } catch {
    // Missing file → create it below; nothing to dedupe against.
  }

  const allowed = await canonicalAllowlist(raw);
  if (allowed.has(canonical)) return { dir: canonical, added: false };

  await mkdir(dirname(allowlistPath), { recursive: true });
  const header = raw.length === 0 ? "# loom project allowlist — one absolute path per line\n" : "";
  const sep = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  await writeFile(allowlistPath, `${header}${raw}${sep}${canonical}\n`, "utf8");
  return { dir: canonical, added: true };
}

// The set of canonical (realpath'd) dirs an allowlist body authorizes. Comment
// and blank lines are dropped; a stale entry that no longer resolves is skipped,
// never fatal — it must not block the valid entries. Shared so the gate and
// `enrollProjectDir` agree byte-for-byte on what "already allowed" means.
async function canonicalAllowlist(raw: string): Promise<Set<string>> {
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const canonical = new Set<string>();
  for (const entry of entries) {
    try {
      canonical.add(await realpath(resolve(entry)));
    } catch {
      continue;
    }
  }
  return canonical;
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
