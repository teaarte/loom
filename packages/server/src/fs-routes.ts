// GET /fs/list?path= — a traversal-guarded directory browser for the add-project
// folder picker. Root-bounded: every looked-up path is canonicalized and must
// stay within the browse root (LOOM_FS_ROOT, else the user's home dir). The
// kernel's `resolveSafePath` provides the same canonicalize-the-existing-ancestor
// + containment + sensitive-path guard the sandbox file tools use, so the picker
// can neither escape the root (a `..` or an out-of-root symlink resolves to its
// real target and is refused) nor descend into a credential store. It lists
// immediate child DIRECTORIES only — and skips dot-directories, so credential
// folders never appear and the picker stays uncluttered; navigating in is
// re-guarded each step. The add-project form keeps a manual-path field for a
// target outside the root.
//
// Transport-only file IO, outside the kernel's replay graph.

import { readdirSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { resolveSafePath } from "@loomfsm/kernel";
import type { ServerResponse } from "node:http";

import { ServerError } from "./errors.js";

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// The browse root the picker is bounded to: an explicit injected value, else the
// `LOOM_FS_ROOT` env, else the user's home dir. The picker cannot navigate above
// it; a project outside it is reached via the form's manual-path field.
export function resolveBrowseRoot(injected?: string): string {
  if (injected !== undefined && injected.length > 0) return injected;
  const env = process.env["LOOM_FS_ROOT"];
  return env !== undefined && env.length > 0 ? env : homedir();
}

interface FsEntry {
  name: string;
  path: string;
}

// List the immediate child directories of a requested path, bounded to `rootDir`.
// `requested` is an absolute path the picker navigated to (empty → the root).
export async function listDirectory(res: ServerResponse, requested: string, rootDir: string): Promise<void> {
  const rootReal = await realpath(resolve(rootDir)).catch(() => resolve(rootDir));

  // Canonicalize + containment + sensitive-path guard against the root. An
  // absolute `requested` resolves to itself; the guard refuses anything whose
  // real target escapes the root or lands in a credential store. Empty → root.
  const safe = await resolveSafePath(requested.length > 0 ? requested : ".", rootReal);
  if (!safe.ok) throw new ServerError("PATH_REFUSED", 403, `path refused: ${safe.reason}`);
  const target = safe.path;

  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    throw new ServerError("DIR_NOT_FOUND", 404, "no such directory");
  }
  if (!isDir) throw new ServerError("NOT_A_DIRECTORY", 400, "not a directory");

  // Immediate child directories only; dot-directories are skipped (credential
  // stores never appear, the picker stays uncluttered). An empty folder lists
  // nothing — which is exactly the "new project in an empty dir" case.
  let names: string[] = [];
  try {
    names = readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch (err) {
    throw new ServerError("DIR_UNREADABLE", 403, err instanceof Error ? err.message : String(err));
  }
  names.sort((a, b) => a.localeCompare(b));
  const entries: FsEntry[] = names.map((name) => ({ name, path: join(target, name) }));

  // The parent — null at (or above) the root, so the picker can't climb out.
  const parent = target === rootReal ? null : dirname(target);
  const parentInRoot = parent !== null && (parent === rootReal || parent.startsWith(rootReal + sep)) ? parent : null;

  sendJson(res, 200, { root: rootReal, path: target, parent: parentInRoot, entries });
}
