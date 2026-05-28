import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureNow,
  closeDb,
  discoverExtensions,
  openDb,
  reconcileExtensions,
} from "../src/index.js";
import type {
  DiscoveredManifest,
  ExtensionManifest,
} from "../src/index.js";
import type { NowToken } from "../src/types/now.js";

// One isolated project dir per test so the per-projectDir DB singleton
// never bleeds state across cases.
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-ext-"));
}

function cleanup(projectDir: string): void {
  try { closeDb(projectDir); } catch { /* may have already closed */ }
  rmSync(projectDir, { recursive: true, force: true });
}

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "loom-ws-"));
}

function makeValidManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return {
    manifest_version: "1.0",
    name: "code",
    display_name: "Code pipeline",
    description: "Code task workflows.",
    version: "3.0.0",
    kind: "bundle",
    publisher: "@loom",
    capabilities: ["state.read", "stage.event"],
    requires: { kernel_api: "^3.0" },
    ...overrides,
  };
}

interface InstalledRow {
  id: string;
  kind: string;
  name: string;
  publisher: string;
  version: string;
  manifest_json: string;
  status: string;
  installed_at: string;
  updated_at: string;
  failure_reason: string | null;
}

interface AuditRow {
  ts: string;
  type: string;
  task_id: string | null;
  driver_state_id: string | null;
  payload: string;
  verdict: string;
  error_class: string | null;
}

function readRow(projectDir: string, id: string): InstalledRow | undefined {
  return openDb(projectDir)
    .prepare("SELECT * FROM installed_extensions WHERE id = ?")
    .get(id) as unknown as InstalledRow | undefined;
}

function readAuditByType(projectDir: string, type: string): AuditRow[] {
  return openDb(projectDir)
    .prepare("SELECT * FROM audit WHERE type = ? ORDER BY id")
    .all(type) as unknown as AuditRow[];
}

function asDiscovered(raw: unknown, path = "/fixture/manifest.json"): DiscoveredManifest {
  return { path, raw };
}

// ============================================================================
// Shape validation
// ============================================================================

describe("validateManifest — shape cascade", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("rejects manifest_version !== '1.0'", async () => {
    const m = makeValidManifest({ manifest_version: "0.9" as unknown as "1.0" });
    const now = captureNow();
    const report = await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now,
    });
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.failure_reason, "manifest-shape-invalid: manifest_version");
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.status, "failed");
    assert.equal(row?.failure_reason, "manifest-shape-invalid: manifest_version");
  });

  it("rejects missing name", async () => {
    const raw = { ...makeValidManifest(), name: "" };
    const now = captureNow();
    const report = await reconcileExtensions({
      manifests: [asDiscovered(raw, "/fixture/no-name")],
      project_dir: projectDir,
      now,
    });
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.failure_reason, "manifest-shape-invalid: name");
    // No installed_extensions row written (kind alone is not enough).
    const rows = openDb(projectDir)
      .prepare("SELECT * FROM installed_extensions")
      .all();
    assert.equal(rows.length, 0);
    // Audit row lands either way.
    const audits = readAuditByType(projectDir, "extension-load-failed");
    assert.equal(audits.length, 1);
  });

  it("rejects invalid kind", async () => {
    const raw = { ...makeValidManifest(), kind: "agent" as unknown as ExtensionManifest["kind"] };
    const now = captureNow();
    const report = await reconcileExtensions({
      manifests: [asDiscovered(raw, "/fixture/bad-kind")],
      project_dir: projectDir,
      now,
    });
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.failure_reason, "manifest-shape-invalid: kind");
    const rows = openDb(projectDir)
      .prepare("SELECT * FROM installed_extensions")
      .all();
    assert.equal(rows.length, 0);
    const audits = readAuditByType(projectDir, "extension-load-failed");
    assert.equal(audits.length, 1);
  });

  it("rejects missing requires.kernel_api", async () => {
    const m = makeValidManifest();
    const raw: Record<string, unknown> = { ...m, requires: {} };
    const now = captureNow();
    const report = await reconcileExtensions({
      manifests: [asDiscovered(raw)],
      project_dir: projectDir,
      now,
    });
    assert.equal(report.failed.length, 1);
    assert.equal(
      report.failed[0]?.failure_reason,
      "manifest-shape-invalid: requires.kernel_api",
    );
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.status, "failed");
  });
});

// ============================================================================
// Publisher allowlist
// ============================================================================

describe("validateManifest — publisher allowlist", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("rejects non-@loom publisher with failure_reason=publisher-not-curated", async () => {
    const m = makeValidManifest({ publisher: "@third-party" });
    const now = captureNow();
    const report = await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now,
    });
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.failure_reason, "publisher-not-curated");
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.status, "failed");
    assert.equal(row?.failure_reason, "publisher-not-curated");
    const audits = readAuditByType(projectDir, "extension-load-failed");
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.error_class, "extension-load-failed");
  });
});

// ============================================================================
// kernel_api semver matching
// ============================================================================

describe("validateManifest — kernel_api range", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("accepts exact match 3.0.0", async () => {
    const m = makeValidManifest({ requires: { kernel_api: "3.0.0" } });
    const now = captureNow();
    const report = await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now,
    });
    assert.deepEqual(report.installed, ["bundle:code"]);
  });

  it("accepts caret ranges ^3.0 and ^3.0.0", async () => {
    const projectA = freshProject();
    const projectB = freshProject();
    try {
      const mA = makeValidManifest({ name: "a", requires: { kernel_api: "^3.0" } });
      const mB = makeValidManifest({ name: "b", requires: { kernel_api: "^3.0.0" } });
      const repA = await reconcileExtensions({ manifests: [asDiscovered(mA)], project_dir: projectA, now: captureNow() });
      const repB = await reconcileExtensions({ manifests: [asDiscovered(mB)], project_dir: projectB, now: captureNow() });
      assert.deepEqual(repA.installed, ["bundle:a"]);
      assert.deepEqual(repB.installed, ["bundle:b"]);
    } finally {
      cleanup(projectA);
      cleanup(projectB);
    }
  });

  it("rejects ^4.0 against KERNEL_SCHEMA_VERSION 3.0.0", async () => {
    const m = makeValidManifest({ requires: { kernel_api: "^4.0" } });
    const report = await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.failure_reason, "kernel-api-mismatch: ^4.0 vs 3.0.0");
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.status, "failed");
  });
});

// ============================================================================
// Lifecycle transitions
// ============================================================================

describe("reconcileExtensions — lifecycle", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("installs a new manifest: row enabled + payload populated + canonical manifest persisted", async () => {
    const m = makeValidManifest();
    const report = await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.deepEqual(report.installed, ["bundle:code"]);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.changed, []);
    const audits = readAuditByType(projectDir, "extension-installed");
    assert.equal(audits.length, 1);
    const payload = JSON.parse(audits[0]?.payload ?? "{}");
    assert.equal(payload.id, "bundle:code");
    assert.equal(payload.kind, "bundle");
    assert.equal(payload.name, "code");
    assert.equal(payload.publisher, "@loom");
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.status, "enabled");
    assert.equal(row?.failure_reason, null);
    // The stored manifest_json is the canonical (key-sorted) form, which
    // is what change-detection compares against. Confirm a sentinel key
    // ordering: "capabilities" sorts before "description" before "kind".
    const storedKeys = Object.keys(JSON.parse(row?.manifest_json ?? "{}"));
    assert.deepEqual(storedKeys, [...storedKeys].sort());
  });

  it("re-running the same manifest is a no-op (no new audit)", async () => {
    const m = makeValidManifest();
    await reconcileExtensions({ manifests: [asDiscovered(m)], project_dir: projectDir, now: captureNow() });
    const second = await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.changed, []);
    assert.deepEqual(second.removed, []);
    const installs = readAuditByType(projectDir, "extension-installed");
    const changes = readAuditByType(projectDir, "extension-manifest-changed");
    assert.equal(installs.length, 1);
    assert.equal(changes.length, 0);
  });

  it("changed manifest emits extension-manifest-changed and updates row", async () => {
    const m1 = makeValidManifest({ version: "3.0.0" });
    await reconcileExtensions({ manifests: [asDiscovered(m1)], project_dir: projectDir, now: captureNow() });
    const m2 = makeValidManifest({ version: "3.0.1" });
    const second = await reconcileExtensions({
      manifests: [asDiscovered(m2)],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.deepEqual(second.changed, ["bundle:code"]);
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.version, "3.0.1");
    const changes = readAuditByType(projectDir, "extension-manifest-changed");
    assert.equal(changes.length, 1);
  });

  it("vanished manifest is marked disabled + extension-removed audit fires", async () => {
    const m = makeValidManifest();
    await reconcileExtensions({ manifests: [asDiscovered(m)], project_dir: projectDir, now: captureNow() });
    const second = await reconcileExtensions({
      manifests: [],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.deepEqual(second.removed, ["bundle:code"]);
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.status, "disabled");
    assert.equal(row?.failure_reason, "removed");
    const removes = readAuditByType(projectDir, "extension-removed");
    assert.equal(removes.length, 1);
    const payload = JSON.parse(removes[0]?.payload ?? "{}");
    assert.equal(payload.failure_reason, "removed");
  });
});

// ============================================================================
// Canonical-JSON change detection
// ============================================================================

describe("reconcileExtensions — canonical-JSON change detection", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("different key order does not trip a manifest-changed event", async () => {
    const ordered: ExtensionManifest = makeValidManifest();
    await reconcileExtensions({
      manifests: [asDiscovered(ordered)],
      project_dir: projectDir,
      now: captureNow(),
    });
    // Same content, fields in shuffled order. The cast surfaces the
    // raw shape — what matters is that canonicalJson equates the two.
    const reordered = {
      publisher: ordered.publisher,
      version: ordered.version,
      requires: ordered.requires,
      capabilities: [...ordered.capabilities],
      kind: ordered.kind,
      description: ordered.description,
      display_name: ordered.display_name,
      name: ordered.name,
      manifest_version: ordered.manifest_version,
    } as unknown as ExtensionManifest;
    const second = await reconcileExtensions({
      manifests: [asDiscovered(reordered)],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.deepEqual(second.changed, []);
    assert.deepEqual(second.installed, []);
    const changes = readAuditByType(projectDir, "extension-manifest-changed");
    assert.equal(changes.length, 0);
  });
});

// ============================================================================
// now: NowToken discipline
// ============================================================================

describe("reconcileExtensions — now threading", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("audit ts equals the now token passed in by the caller", async () => {
    const m = makeValidManifest();
    const now = "2026-05-28T12:34:56.789Z" as NowToken;
    await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now,
    });
    const audits = readAuditByType(projectDir, "extension-installed");
    assert.equal(audits[0]?.ts, now);
    const row = readRow(projectDir, "bundle:code");
    assert.equal(row?.installed_at, now);
    assert.equal(row?.updated_at, now);
  });
});

// ============================================================================
// discoverExtensions — smoke
// ============================================================================

describe("discoverExtensions", () => {
  let projectDir: string;
  let workspaceRoot: string;
  beforeEach(() => {
    projectDir = freshProject();
    workspaceRoot = freshWorkspace();
  });
  afterEach(() => {
    cleanup(projectDir);
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("globs packages/{bundles,providers}/* and reconciles each manifest.json", async () => {
    const bundleDir = join(workspaceRoot, "packages", "bundles", "code");
    const providerDir = join(workspaceRoot, "packages", "providers", "openrouter");
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(
      join(bundleDir, "manifest.json"),
      JSON.stringify(makeValidManifest({ name: "code", kind: "bundle" })),
    );
    writeFileSync(
      join(providerDir, "manifest.json"),
      JSON.stringify(makeValidManifest({ name: "openrouter", kind: "provider" })),
    );

    const report = await discoverExtensions({
      workspace_root: workspaceRoot,
      project_dir: projectDir,
      now: captureNow(),
    });
    const sorted = [...report.installed].sort();
    assert.deepEqual(sorted, ["bundle:code", "provider:openrouter"]);
    assert.deepEqual(report.failed, []);
  });

  it("no packages/ dir at workspace root is a no-op (empty report)", async () => {
    // workspaceRoot exists but has no packages/ subdir.
    const report = await discoverExtensions({
      workspace_root: workspaceRoot,
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.deepEqual(report.installed, []);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(report.changed, []);
    assert.deepEqual(report.removed, []);
  });

  it("package directory without a manifest file is silently skipped", async () => {
    const pkgDir = join(workspaceRoot, "packages", "bundles", "noisy");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "README.md"), "no manifest here");
    const report = await discoverExtensions({
      workspace_root: workspaceRoot,
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.deepEqual(report.installed, []);
    assert.deepEqual(report.failed, []);
  });

  it("malformed manifest.json surfaces as failure_reason=manifest-load-failed", async () => {
    const pkgDir = join(workspaceRoot, "packages", "bundles", "broken");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "manifest.json"), "{ this is not json");
    const report = await discoverExtensions({
      workspace_root: workspaceRoot,
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.equal(report.installed.length, 0);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0]?.failure_reason ?? "", /^manifest-load-failed: /);
    const audits = readAuditByType(projectDir, "extension-load-failed");
    assert.equal(audits.length, 1);
  });
});

// ============================================================================
// reconcileExtensions — load_error branch (pure core, no filesystem)
// ============================================================================

describe("reconcileExtensions — load_error path", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("DiscoveredManifest.load_error → audit only, no installed_extensions row", async () => {
    const d: DiscoveredManifest = {
      path: "/fixture/unreadable/manifest.json",
      raw: undefined,
      load_error: "ENOENT: no such file or directory",
    };
    const report = await reconcileExtensions({
      manifests: [d],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0]?.failure_reason ?? "", /^manifest-load-failed: ENOENT/);
    // No row — extractPartial(undefined) returns nulls, so handleFailed
    // does not synthesize an installed_extensions row.
    const rows = openDb(projectDir).prepare("SELECT * FROM installed_extensions").all();
    assert.equal(rows.length, 0);
    const audits = readAuditByType(projectDir, "extension-load-failed");
    assert.equal(audits.length, 1);
    const payload = JSON.parse(audits[0]?.payload ?? "{}");
    assert.equal(payload.kind, null);
    assert.equal(payload.name, null);
  });
});

// ============================================================================
// reconcileExtensions — re-enable after a fix in a follow-up sweep
// ============================================================================

// Walk up from this test file until pnpm-workspace.yaml is found. The
// kernel package and its dist/test layout are nested several levels
// deep from the repo root; computing the walk inline avoids hard-
// coding a count of `..` that would silently break if the layout
// shifts.
function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate workspace root from " + fileURLToPath(import.meta.url));
}

describe("discoverExtensions — real workspace integration", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("finds the five curated manifests shipped at the package roots", async () => {
    const workspaceRoot = findWorkspaceRoot();
    const report = await discoverExtensions({
      workspace_root: workspaceRoot,
      project_dir: projectDir,
      now: captureNow(),
    });

    const installedSet = new Set(report.installed);
    const expected = [
      "bundle:code",
      "provider:anthropic-sdk",
      "provider:claude-code-shuttle",
      "provider:ollama",
      "provider:openrouter",
    ];
    for (const id of expected) {
      assert.ok(
        installedSet.has(id),
        `expected ${id} in report.installed; got ${[...installedSet].join(", ")}` +
          ` (failed=${JSON.stringify(report.failed)})`,
      );
    }
    assert.deepEqual(report.failed, []);
  });
});

describe("reconcileExtensions — failed → enabled transition", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("failed row flips to enabled when the manifest is fixed and re-presented", async () => {
    const broken = makeValidManifest({ publisher: "@third-party" });
    await reconcileExtensions({
      manifests: [asDiscovered(broken)],
      project_dir: projectDir,
      now: captureNow(),
    });
    const before = readRow(projectDir, "bundle:code");
    assert.equal(before?.status, "failed");
    assert.equal(before?.failure_reason, "publisher-not-curated");

    const fixed = makeValidManifest();
    const second = await reconcileExtensions({
      manifests: [asDiscovered(fixed)],
      project_dir: projectDir,
      now: captureNow(),
    });
    // The row was already there with a different status; the reconcile
    // path treats that as a change (`existing.status !== "enabled"`),
    // so this lands as a manifest-changed event rather than a fresh
    // install.
    assert.deepEqual(second.changed, ["bundle:code"]);
    assert.deepEqual(second.installed, []);
    const after = readRow(projectDir, "bundle:code");
    assert.equal(after?.status, "enabled");
    assert.equal(after?.failure_reason, null);
  });
});

// ============================================================================
// satisfiesRange — branch-specific semver edges
// ============================================================================

describe("satisfiesRange — semver edges via reconcileExtensions", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  async function assertRangeFails(range: string): Promise<void> {
    const m = makeValidManifest({ requires: { kernel_api: range } });
    const report = await reconcileExtensions({
      manifests: [asDiscovered(m)],
      project_dir: projectDir,
      now: captureNow(),
    });
    assert.equal(report.failed.length, 1, `range ${range} should fail`);
    assert.equal(
      report.failed[0]?.failure_reason,
      `kernel-api-mismatch: ${range} vs 3.0.0`,
    );
  }

  it("caret with patch above kernel fails (^3.0.5 vs 3.0.0)", async () => {
    await assertRangeFails("^3.0.5");
  });

  it("caret with minor above kernel fails (^3.1 vs 3.0.0)", async () => {
    await assertRangeFails("^3.1");
  });

  it("exact mismatch fails (3.0.1 vs 3.0.0)", async () => {
    await assertRangeFails("3.0.1");
  });

  it("unsupported range form (tilde) is treated as mismatch", async () => {
    await assertRangeFails("~3.0");
  });
});
