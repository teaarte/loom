// Per-project validation-command resolution — config precedence + package.json
// auto-detection. Real temp-dir files (a fixture project tree), no mocks.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_NAMES,
  detectPackageManager,
  mergeConfig,
  resolveCheckCommands,
  type ResolvedCheckCommand,
} from "../src/index.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-checks-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function byName(rows: ResolvedCheckCommand[], name: string): ResolvedCheckCommand {
  const r = rows.find((x) => x.name === name);
  assert.ok(r !== undefined, `expected a resolved check for '${name}'`);
  return r;
}

describe("resolveCheckCommands — config precedence", () => {
  it("a configured command runs verbatim via the shell", () => {
    const dir = tmp();
    const rows = resolveCheckCommands(dir, { typecheck: "tsc --noEmit" });
    const tc = byName(rows, "typecheck");
    assert.deepEqual(tc.run, { kind: "shell", command: "tsc --noEmit" });
  });

  it("an empty configured command is treated as skip (not a shell run)", () => {
    const dir = tmp();
    const rows = resolveCheckCommands(dir, { lint: "   " });
    assert.equal(byName(rows, "lint").run.kind, "skip");
  });

  it("returns one entry per check, always in CHECK_NAMES order", () => {
    const dir = tmp();
    const rows = resolveCheckCommands(dir, {});
    assert.deepEqual(rows.map((r) => r.name), [...CHECK_NAMES]);
  });

  it("nothing configured and no package.json → every check is skipped", () => {
    const dir = tmp();
    const rows = resolveCheckCommands(dir);
    for (const r of rows) assert.equal(r.run.kind, "skip", `${r.name} should skip`);
  });
});

describe("resolveCheckCommands — package.json auto-detection", () => {
  it("falls back to a matching package.json script via the detected package manager", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc", test: "node --test" } }),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const rows = resolveCheckCommands(dir);
    assert.deepEqual(byName(rows, "typecheck").run, {
      kind: "argv",
      argv: ["pnpm", "run", "typecheck"],
      display: "pnpm run typecheck",
    });
    // No `lint` script → that check is skipped, not failed.
    assert.equal(byName(rows, "lint").run.kind, "skip");
  });

  it("an explicit config command wins over a detected package.json script", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const rows = resolveCheckCommands(dir, { test: "node --test dist/test" });
    assert.deepEqual(byName(rows, "test").run, {
      kind: "shell",
      command: "node --test dist/test",
    });
  });

  it("a malformed package.json detects no scripts (skips, never throws)", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), "{ not json");
    const rows = resolveCheckCommands(dir);
    for (const r of rows) assert.equal(r.run.kind, "skip");
  });
});

describe("detectPackageManager", () => {
  it("maps a lockfile to its package manager, defaulting to npm", () => {
    const npmDir = tmp();
    assert.equal(detectPackageManager(npmDir), "npm");
    const yarnDir = tmp();
    writeFileSync(join(yarnDir, "yarn.lock"), "");
    assert.equal(detectPackageManager(yarnDir), "yarn");
    const bunDir = tmp();
    writeFileSync(join(bunDir, "bun.lockb"), "");
    assert.equal(detectPackageManager(bunDir), "bun");
  });
});

describe("mergeConfig — checks", () => {
  it("merges checks field-wise, higher layer wins per command", () => {
    const merged = mergeConfig(
      { checks: { typecheck: "tsc-global", lint: "eslint" } },
      { checks: { typecheck: "tsc-project" } },
    );
    assert.deepEqual(merged.checks, { typecheck: "tsc-project", lint: "eslint" });
  });
});
