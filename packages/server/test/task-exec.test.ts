// The per-task execution-prefs sidecar — the submit→drive seam for P4's per-task
// Docker flag. A real file round-trip (no mocks): write a choice, read it back;
// a missing / malformed / non-boolean sidecar degrades to the deployment default.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { readTaskExecPrefs, taskExecPath, writeTaskExecPrefs } from "../src/task-exec.js";

const dirs: string[] = [];
function project(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-task-exec-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("task-exec sidecar", () => {
  it("round-trips a docker:true choice", () => {
    const dir = project();
    writeTaskExecPrefs(dir, { docker: true });
    assert.deepEqual(readTaskExecPrefs(dir), { docker: true });
  });

  it("round-trips a docker:false (forced-worktree) choice", () => {
    const dir = project();
    writeTaskExecPrefs(dir, { docker: false });
    assert.deepEqual(readTaskExecPrefs(dir), { docker: false });
  });

  it("a written empty prefs clears to the deployment default (no docker key)", () => {
    const dir = project();
    writeTaskExecPrefs(dir, { docker: true });
    writeTaskExecPrefs(dir, {});
    assert.deepEqual(readTaskExecPrefs(dir), {});
  });

  it("reads as default when the sidecar is absent", () => {
    assert.deepEqual(readTaskExecPrefs(project()), {});
  });

  it("ignores a malformed or non-boolean sidecar", () => {
    const dir = project();
    const path = taskExecPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json", "utf8");
    assert.deepEqual(readTaskExecPrefs(dir), {});
    writeFileSync(path, JSON.stringify({ docker: "yes" }), "utf8");
    assert.deepEqual(readTaskExecPrefs(dir), {});
  });
});
