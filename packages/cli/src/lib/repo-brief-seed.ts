// Compose the repo-brief sandbox seeds for a drive.
//
// `@loomfsm/repo-memory` AUTHORS the persistent brief (it owns the code-domain
// knowledge — languages, symbols, stack); this transport-side helper decides
// WHERE the produced files land in the agent sandbox (`.loom/work/…`, beside
// `diff.txt` and `refs/`) and wires them into the dispatch executor's
// `sandbox_seed`. The split keeps the sandbox-layout convention in the transport
// and the language knowledge out of it.
//
// LAZY BY DESIGN. `@loomfsm/repo-memory` transitively loads the kernel barrel
// (and thus `node:sqlite`), so importing it eagerly would force `node:sqlite`
// onto cold paths like `loom --version` that never enable the flag. The flag is
// checked FIRST (cheaply, no import), and the package is dynamic-imported only
// when repo-brief is actually ON — by which point the command is a real drive
// running with sqlite available.
//
// Returns [] when `LOOM_REPO_BRIEF` is off OR the brief degrades (non-git repo,
// over the file cap, any error) — then the run behaves exactly as it does with
// repo-brief disabled. `ensureBrief` is invoked ONCE here per drive (the
// dispatch shell calls the seed callback once when it builds the backend), so
// this is the "pre-spawn ensure against the real project root" step.

import type { SandboxSeed } from "@loomfsm/driver";

// The flag's truthy values — kept in sync with `repoBriefEnabled` in
// @loomfsm/repo-memory (the canonical definition). Inlined here so the OFF path
// (the default) never imports the heavy package.
function flagOn(env: Record<string, string | undefined>): boolean {
  const v = (env["LOOM_REPO_BRIEF"] ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "yes";
}

export async function repoBriefSeeds(
  projectDir: string,
  env: Record<string, string | undefined>,
  onNotice?: (message: string) => void,
): Promise<readonly SandboxSeed[]> {
  if (!flagOn(env)) return [];
  const { ensureBrief } = await import("@loomfsm/repo-memory");
  const stats = ensureBrief(projectDir, onNotice !== undefined ? { onNotice } : {});
  if (!stats.enabled || stats.briefPath === null) return [];
  onNotice?.(
    stats.built
      ? `repo-brief: ${stats.changedFiles.length} changed / ${stats.filesIndexed} indexed${stats.truncated ? " (truncated)" : ""}`
      : `repo-brief: reused, no changes (${stats.filesIndexed} indexed)`,
  );
  const seeds: SandboxSeed[] = [{ src: stats.briefPath, rel: ".loom/work/repo-brief.md" }];
  if (stats.changedListPath !== null) {
    seeds.push({ src: stats.changedListPath, rel: ".loom/work/repo-brief.changed.txt" });
  }
  return seeds;
}
