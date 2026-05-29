// Shared project-file walker for the read-only tools.
//
// `grep` and `file_glob` both recurse from `ctx.project_dir`, skip the
// same vendored / VCS / build trees, and route each candidate through
// the path guard. The only difference is the emitted path form, so the
// walk lives here once and a future change to the skip set or the
// recursion bound touches a single site.

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// Directory names no project-file walk descends into: VCS metadata, the
// dependency tree, and build output.
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
]);

// Emit form: `"absolute"` returns full filesystem paths (grep, which
// re-resolves each through `resolveSafePath`); `"relative"` returns
// root-relative paths (file_glob, which matches a glob over POSIX
// relative paths).
export type WalkPathMode = "absolute" | "relative";

// Collect every file under `root`, skipping SKIP_DIRS. A directory
// symlink reports `isDirectory() === false`, so the walk never recurses
// into one — there is no symlink-loop hazard.
export async function walkProjectFiles(
  root: string,
  mode: WalkPathMode,
): Promise<string[]> {
  const out: string[] = [];
  await walkInto(root, root, mode, out);
  return out;
}

async function walkInto(
  root: string,
  dir: string,
  mode: WalkPathMode,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      await walkInto(root, full, mode, out);
    } else if (ent.isFile()) {
      out.push(mode === "absolute" ? full : relative(root, full));
    }
  }
}
