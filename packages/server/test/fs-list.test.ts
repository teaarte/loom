// GET /fs/list end to end, over a REAL server (loopback) + a REAL temp tree —
// the add-project folder picker. Proves the security posture: it lists immediate
// child directories bounded to the browse root, skips dot-directories, works on
// an empty folder, and REFUSES every escape (an out-of-root absolute path, a
// `..` climb, and a symlink whose real target leaves the root). No mocked fs.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startControlPlane, type ControlPlaneHandle } from "../src/index.js";
import { makeDashboardFixture, recordingExecutor, spawnRegistry, tempStateDir } from "./fixtures.js";

const TOKEN = "dev-token";

let handle: ControlPlaneHandle;
let base: string;
const controller = new AbortController();
const stateDir = tempStateDir();
const root = mkdtempSync(join(tmpdir(), "loom-fs-root-"));
const outside = mkdtempSync(join(tmpdir(), "loom-fs-outside-"));
// The canonical root (macOS temp dirs live under a /var -> /private/var symlink).
const rootReal = realpathSync(root);

before(async () => {
  // root/
  //   alpha/nested/      (a child to navigate into)
  //   alpha/file.txt     (a file — directories-only listing skips it)
  //   beta/              (empty — the "new project in an empty dir" case)
  //   .hidden/           (a dot-dir — filtered from listings)
  //   escape -> <outside> (a symlink whose real target escapes the root)
  mkdirSync(join(root, "alpha", "nested"), { recursive: true });
  writeFileSync(join(root, "alpha", "file.txt"), "x");
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, ".hidden"));
  mkdirSync(join(outside, "secretproj"));
  symlinkSync(outside, join(root, "escape"), "dir");

  handle = await startControlPlane({
    stateDir,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    resolveRegistry: () => spawnRegistry(),
    buildExecutor: () => recordingExecutor([]),
    dashboardDir: makeDashboardFixture(),
    fsBrowseRoot: root,
    signal: controller.signal,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  controller.abort();
  await handle.closed;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

interface Resp {
  status: number;
  json: { root?: string; path?: string; parent?: string | null; entries?: { name: string; path: string }[]; error?: { code?: string } };
}

async function list(path: string | null, token: string | null = TOKEN): Promise<Resp> {
  const qs = path === null ? "" : `?path=${encodeURIComponent(path)}`;
  const res = await fetch(`${base}/fs/list${qs}`, token !== null ? { headers: { authorization: `Bearer ${token}` } } : {});
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Resp["json"] };
}

const names = (r: Resp): string[] => (r.json.entries ?? []).map((e) => e.name);

describe("GET /fs/list — the add-project folder picker", () => {
  it("requires a bearer token", async () => {
    const r = await list(null, null);
    assert.equal(r.status, 401);
  });

  it("lists the root's immediate child directories, skipping dot-dirs, files, and symlinks", async () => {
    const r = await list(null);
    assert.equal(r.status, 200);
    // alpha + beta only: .hidden is a dot-dir, file.txt is a file, escape is a symlink.
    assert.deepEqual(names(r), ["alpha", "beta"]);
    assert.equal(r.json.root, rootReal);
    assert.equal(r.json.path, rootReal);
    // No climbing above the root.
    assert.equal(r.json.parent, null);
  });

  it("navigates into a child, exposing the parent back to the root", async () => {
    const r = await list(join(root, "alpha"));
    assert.equal(r.status, 200);
    assert.deepEqual(names(r), ["nested"]);
    assert.equal(r.json.parent, rootReal);
  });

  it("lists an empty folder as no entries (the new-project case)", async () => {
    const r = await list(join(root, "beta"));
    assert.equal(r.status, 200);
    assert.deepEqual(names(r), []);
    assert.equal(r.json.parent, rootReal);
  });

  it("404s a path that does not exist inside the root", async () => {
    const r = await list(join(root, "nope"));
    assert.equal(r.status, 404);
  });

  it("refuses an absolute path outside the root", async () => {
    const r = await list(outside);
    assert.equal(r.status, 403);
    assert.equal(r.json.error?.code, "PATH_REFUSED");
  });

  it("refuses a `..` climb out of the root", async () => {
    const r = await list(join(root, "..", ".."));
    assert.equal(r.status, 403);
    assert.equal(r.json.error?.code, "PATH_REFUSED");
  });

  it("refuses a symlink whose real target escapes the root", async () => {
    const r = await list(join(root, "escape"));
    assert.equal(r.status, 403);
    assert.equal(r.json.error?.code, "PATH_REFUSED");
  });
});
