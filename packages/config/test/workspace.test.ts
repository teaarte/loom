// The project catalog — CRUD. Add upserts by id and preserves the original
// added_at; remove reports whether anything was dropped; touch patches in place
// and no-ops on an unknown id.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addProject,
  getProject,
  listProjects,
  removeProject,
  touchProject,
} from "../src/index.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-config-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("workspace catalog CRUD", () => {
  it("adds, lists, gets", () => {
    const home = tmp();
    addProject(home, { id: "a", dir: "/p/one", label: "One", added_at: "T0" });
    addProject(home, { id: "b", dir: "/p/two" });
    const all = listProjects(home);
    assert.equal(all.length, 2);
    assert.equal(getProject(home, "a")?.label, "One");
    assert.equal(getProject(home, "missing"), undefined);
  });

  it("re-adding upserts fields but preserves added_at", () => {
    const home = tmp();
    addProject(home, { id: "a", dir: "/p/one", label: "Old", added_at: "T0" });
    addProject(home, { id: "a", dir: "/p/one", label: "New" });
    const entry = getProject(home, "a");
    assert.equal(entry?.label, "New");
    assert.equal(entry?.added_at, "T0");
    assert.equal(listProjects(home).length, 1);
  });

  it("removes and reports", () => {
    const home = tmp();
    addProject(home, { id: "a", dir: "/p/one" });
    assert.equal(removeProject(home, "a").removed, true);
    assert.equal(removeProject(home, "a").removed, false);
    assert.equal(listProjects(home).length, 0);
  });

  it("touch patches in place and no-ops on unknown id", () => {
    const home = tmp();
    addProject(home, { id: "a", dir: "/p/one" });
    const updated = touchProject(home, "a", { last_opened_at: "T1" });
    assert.equal(updated?.last_opened_at, "T1");
    assert.equal(touchProject(home, "missing", { last_opened_at: "T1" }), undefined);
  });
});
