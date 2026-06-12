// Server-side file-delta computation — the transport's honest answer to
// "what did this task touch?".
//
// This lives in the transport runtime on purpose: the kernel is
// side-effect-free and never shells out, so ALL world-coupling (here, a
// git working tree) belongs to whoever drives it. Computing the delta here
// — rather than trusting a driver to report it — makes the accounting
// trustworthy by construction: a thin or lazy driver can no longer silently
// feed an empty list and turn the change-conditional reviewers into no-ops.
//
// The delta is measured against a BASELINE captured at task start, not
// against the current HEAD. A run that COMMITS its work moves HEAD forward,
// so a working-tree-vs-HEAD diff comes back empty even though the tree
// changed — which is exactly how an earlier run recorded an empty file set
// for a fully-committed change. Diffing the working tree against the
// task-start baseline instead catches committed AND uncommitted edits;
// untracked files are added separately.
//
// All functions DEGRADE GRACEFULLY: a non-git project, a missing git
// binary, or any git error yields null / empty rather than throwing, so a
// host that supplies its own accounting (or none) is unaffected.

import { spawnSync } from "node:child_process";

// The well-known SHA-1 of the empty tree object. Used as the baseline for
// a repository that has no commit yet (no resolvable HEAD): a diff against
// it surfaces every path the task subsequently tracks, so a first-commit
// task is still accounted for.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Loom's own reserved footprint inside the worktree. The per-task state, the
// seeded knowledge refs (`.loom/work/refs/*`), and the rendered diff itself
// (`.loom/work/diff.txt`) all live under `.loom/` — none of it is the AGENT's
// change to the PROJECT, so it must never appear in the self-diff that feeds
// the change-conditional reviewers or the "files touched" accounting. A project
// that does NOT gitignore `.loom/` would otherwise leak every seeded ref (and
// diff.txt referencing itself) into `created`, defeating the empty-diff
// review-skip and burying the real change under thousands of lines of refs.
// Excluding it with a git pathspec — rather than depending on the project's
// .gitignore — keeps the delta honest by construction. The leading "." is
// required: git rejects an exclude-only pathspec.
const LOOM_FOOTPRINT_PATHSPEC: readonly string[] = ["--", ".", ":(exclude).loom"];

export interface GitDelta {
  modified: string[];
  created: string[];
}

// Run git with explicit args (no shell, so paths/refs cannot be
// interpreted) rooted at projectDir. Returns trimmed stdout on a clean
// exit, or null on any failure (binary missing, non-repo, non-zero exit).
function runGit(projectDir: string, args: string[]): string | null {
  const res = spawnSync("git", ["-C", projectDir, ...args], {
    encoding: "utf8",
    // A delta is bounded by the worktree size; the default 1 MiB buffer is
    // plenty for a name-only listing, but lift it so a very large change
    // set is never truncated mid-path.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error !== undefined) return null;
  if (res.status !== 0) return null;
  return typeof res.stdout === "string" ? res.stdout : null;
}

// As `runGit`, but also returns stdout on exit code 1. `git diff --no-index`
// (used to render an untracked file as an add-only hunk) exits 1 precisely WHEN
// the inputs differ — the normal case for a new file — so a strict
// exit-0 check would discard its output. Any other non-zero exit (a real error)
// still yields null.
function runGitDiffTolerant(projectDir: string, args: string[]): string | null {
  const res = spawnSync("git", ["-C", projectDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error !== undefined) return null;
  if (res.status !== 0 && res.status !== 1) return null;
  return typeof res.stdout === "string" ? res.stdout : null;
}

// True when projectDir sits inside a git working tree.
function isGitWorkTree(projectDir: string): boolean {
  const out = runGit(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  return out !== null && out.trim() === "true";
}

// Split git's newline-separated name-only output into a clean path list.
function parsePaths(out: string | null): string[] {
  if (out === null) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Capture the baseline ref to diff against for the lifetime of a task.
// Returns the current HEAD sha for a repo with at least one commit, the
// empty-tree sha for an initialized-but-empty repo, or null when the
// project is not a git work tree (then no server-side delta is computed
// and the host's own accounting, if any, stands).
export function gitBaselineRef(projectDir: string): string | null {
  if (!isGitWorkTree(projectDir)) return null;
  const head = runGit(projectDir, ["rev-parse", "HEAD"]);
  if (head !== null && head.trim().length > 0) return head.trim();
  // Initialized repo with no commit yet — diff against the empty tree.
  return EMPTY_TREE_SHA;
}

// Compute the cumulative file delta of the working tree relative to the
// baseline:
//   modified — every tracked path that differs from the baseline tree
//              (committed OR uncommitted edits, plus deletions);
//   created  — untracked files not ignored by .gitignore.
// A path committed-and-then-modified appears once (set semantics on the
// caller's union). Returns null when there is no baseline or the project
// is not a git work tree — the caller treats that as "nothing to add".
export function gitDelta(projectDir: string, baseline: string | null): GitDelta | null {
  if (baseline === null) return null;
  if (!isGitWorkTree(projectDir)) return null;
  const modified = parsePaths(
    runGit(projectDir, ["diff", "--name-only", baseline, ...LOOM_FOOTPRINT_PATHSPEC]),
  );
  const created = parsePaths(
    runGit(projectDir, ["ls-files", "--others", "--exclude-standard", ...LOOM_FOOTPRINT_PATHSPEC]),
  );
  return { modified, created };
}

// Render the FULL textual diff of the working tree against the baseline — the
// unified diff a reviewer reads to see exactly what changed. Two parts, so a
// brand-new file is not silently absent:
//   - `git diff <baseline>` — every tracked path that differs (committed OR
//     uncommitted edits, plus deletions);
//   - each untracked, non-ignored file rendered as an add-only hunk via
//     `git diff --no-index /dev/null <file>` (which exits 1 by design — see
//     runGitDiffTolerant).
// Read-only: it never touches the index, so a later `gitDelta` still classifies
// new files as `created` rather than tracked. Returns null when there is no
// baseline or the project is not a git work tree (the caller writes nothing
// then); an empty string is a real "nothing changed" answer.
export function gitDiffText(projectDir: string, baseline: string | null): string | null {
  if (baseline === null) return null;
  if (!isGitWorkTree(projectDir)) return null;
  const parts: string[] = [];
  const tracked = runGit(projectDir, ["diff", baseline, ...LOOM_FOOTPRINT_PATHSPEC]);
  if (tracked !== null && tracked.trim().length > 0) parts.push(tracked.replace(/\n+$/, ""));
  for (const file of parsePaths(
    runGit(projectDir, ["ls-files", "--others", "--exclude-standard", ...LOOM_FOOTPRINT_PATHSPEC]),
  )) {
    const hunk = runGitDiffTolerant(projectDir, ["diff", "--no-index", "--", "/dev/null", file]);
    if (hunk !== null && hunk.trim().length > 0) parts.push(hunk.replace(/\n+$/, ""));
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

// ----- Pathological-diff cap -------------------------------------------------
//
// The reviewer-facing `diff.txt` is read by up to ~8 reviewer spawns, so a
// multi-megabyte diff is the same huge payload re-sent eight times. A NORMAL
// diff is left untouched; only when the FULL diff crosses the threshold is it
// capped — each file's hunk keeps its first changed lines (a reviewer reads the
// start of a change), and a COMPLETE per-file stat list is appended so no file
// is invisible. The reviewer runs in the same worktree, so a truncated hunk is
// always recoverable by opening the file.

// Above this byte size the diff is treated as pathological and capped. A diff
// under it is written verbatim (the common case sees zero difference).
const DIFF_CAP_BYTES = 256 * 1024;

// Per-file budget of CHANGED (`+`/`-`) lines kept in a capped diff. Context
// lines ride along for free until the budget is spent.
const PER_FILE_CHANGED_LINE_CAP = 300;

interface FileStat {
  path: string;
  added: number;
  removed: number;
  truncated: boolean;
}

// Split a unified diff into one section per file. A section starts at a
// `diff --git ` line and runs until the next one; any preamble before the first
// such line (none in git's own output, but tolerated) is kept as a leading
// section so nothing is dropped.
function splitDiffSections(diff: string): string[] {
  const lines = diff.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

// A content line is an added/removed line — NOT the `+++`/`---` file headers,
// which also start with `+`/`-`.
function isAdded(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}
function isRemoved(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

// Extract the file path a section touches (the post-image side of
// `diff --git a/<path> b/<path>`), falling back to the pre-image or a marker.
function sectionPath(section: string): string {
  const first = section.split("\n", 1)[0] ?? "";
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(first);
  if (m !== null) return m[2] ?? m[1] ?? "(unknown)";
  return "(unknown)";
}

// Truncate one file's section to the first PER_FILE_CHANGED_LINE_CAP changed
// lines, returning the kept text plus the file's FULL added/removed counts
// (counted over the whole section, before truncation, so the stat list is
// complete regardless of where the cut fell).
function capSection(section: string): { text: string; stat: FileStat } {
  const path = sectionPath(section);
  const lines = section.split("\n");
  let added = 0;
  let removed = 0;
  const kept: string[] = [];
  let changedKept = 0;
  let cut = false;
  for (const line of lines) {
    const add = isAdded(line);
    const rem = isRemoved(line);
    if (add) added += 1;
    if (rem) removed += 1;
    if (cut) continue; // keep counting the tail for the stat, emit nothing more
    if (add || rem) {
      if (changedKept >= PER_FILE_CHANGED_LINE_CAP) {
        cut = true;
        kept.push(
          `… [diff truncated: first ${PER_FILE_CHANGED_LINE_CAP} changed lines shown; open ${path} in the worktree for the rest] …`,
        );
        continue;
      }
      changedKept += 1;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), stat: { path, added, removed, truncated: cut } };
}

// Render the complete per-file change summary appended to a capped diff.
function renderStatList(stats: readonly FileStat[], originalBytes: number): string {
  const kb = Math.round(originalBytes / 1024);
  const out = [
    `=== diff truncated (full diff was ~${kb} KB) — complete per-file change summary below; open files in the worktree for full detail ===`,
  ];
  for (const s of stats) {
    out.push(`  +${s.added} -${s.removed}\t${s.path}${s.truncated ? "  (hunk truncated above)" : ""}`);
  }
  return out.join("\n");
}

// Cap a pathological diff. A diff at or under DIFF_CAP_BYTES is returned
// verbatim (the normal case). Over it: each file's hunk is truncated to its
// first changed lines with an omission marker, and a complete per-file stat
// list is appended. Pure and deterministic (no clock, git-order preserved) —
// the same diff always caps to the same text.
export function capDiffText(diff: string): string {
  const originalBytes = Buffer.byteLength(diff, "utf8");
  if (originalBytes <= DIFF_CAP_BYTES) return diff;
  const sections = splitDiffSections(diff);
  const stats: FileStat[] = [];
  const capped: string[] = [];
  for (const section of sections) {
    if (!section.startsWith("diff --git ")) {
      // A non-file preamble (not produced by git here) — keep it as-is.
      capped.push(section);
      continue;
    }
    const { text, stat } = capSection(section);
    capped.push(text);
    stats.push(stat);
  }
  return `${capped.join("\n")}\n${renderStatList(stats, originalBytes)}\n`;
}
