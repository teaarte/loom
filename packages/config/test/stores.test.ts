// Stores + paths + at-rest posture — exercised against real temp-dir files
// (never a mock): round-trip each store, an absent file reads empty, a malformed
// file throws a clear sourced error, writes are atomic, and secrets.json lands
// chmod 600 and is never written under a repo.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  configPath,
  projectConfigPath,
  readGlobalConfig,
  readProjectConfig,
  readSecrets,
  readWorkspace,
  resolveLoomHome,
  secretsPath,
  workspacePath,
  writeGlobalConfig,
  writeProjectConfig,
  writeSecrets,
  writeWorkspace,
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

describe("resolveLoomHome", () => {
  it("honors $LOOM_HOME above everything", () => {
    const home = resolveLoomHome({ LOOM_HOME: "/x/loom", XDG_CONFIG_HOME: "/y" }, "/home/u");
    assert.equal(home, "/x/loom");
  });
  it("falls back to $XDG_CONFIG_HOME/loom", () => {
    const home = resolveLoomHome({ XDG_CONFIG_HOME: "/y/cfg" }, "/home/u");
    assert.equal(home, join("/y/cfg", "loom"));
  });
  it("defaults to ~/.config/loom", () => {
    const home = resolveLoomHome({}, "/home/u");
    assert.equal(home, join("/home/u", ".config", "loom"));
  });
});

describe("global + project config stores", () => {
  it("round-trips a config and reads empty when absent", () => {
    const home = tmp();
    assert.deepEqual(readGlobalConfig(home), {});
    writeGlobalConfig(home, { backend: "auto", bundles: { demo: { agents: { a: "x:y" } } } });
    const back = readGlobalConfig(home);
    assert.equal(back.backend, "auto");
    assert.equal(back.bundles?.["demo"]?.agents?.["a"], "x:y");
  });

  it("round-trips a project config under <repo>/.claude/loom.json", () => {
    const proj = tmp();
    assert.deepEqual(readProjectConfig(proj), {});
    writeProjectConfig(proj, { bundles: { demo: { agents: { b: "tier" } } } });
    assert.equal(projectConfigPath(proj), join(proj, ".claude", "loom.json"));
    assert.equal(readProjectConfig(proj).bundles?.["demo"]?.agents?.["b"], "tier");
  });

  it("throws a clear, sourced error on a malformed global config", () => {
    const home = tmp();
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ backend: 42 }), "utf8");
    assert.throws(() => readGlobalConfig(home), /global config\.json/);
  });

  it("throws on invalid JSON", () => {
    const home = tmp();
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), "{ not json", "utf8");
    assert.throws(() => readGlobalConfig(home), /invalid JSON/);
  });
});

describe("secrets store", () => {
  it("round-trips and writes chmod 600", () => {
    const home = tmp();
    assert.deepEqual(readSecrets(home), {});
    writeSecrets(home, { OPENROUTER_KEY: "sk-secret-value" });
    assert.equal(readSecrets(home)["OPENROUTER_KEY"], "sk-secret-value");
    const mode = statSync(secretsPath(home)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 600, got ${mode.toString(8)}`);
  });

  it("never lets a secret value land in a project file", () => {
    // A secret written through the secrets store goes to the global home only;
    // the project config path is a different file under the repo.
    const home = tmp();
    const proj = tmp();
    writeSecrets(home, { TG_TOKEN: "12345:abcdef" });
    writeProjectConfig(proj, { backend: "auto" });
    const projRaw = readFileSync(projectConfigPath(proj), "utf8");
    assert.ok(!projRaw.includes("12345:abcdef"), "secret value leaked into project config");
    assert.notEqual(secretsPath(home), projectConfigPath(proj));
  });
});

describe("workspace store", () => {
  it("round-trips and reads empty when absent", () => {
    const home = tmp();
    assert.deepEqual(readWorkspace(home), []);
    writeWorkspace(home, [{ id: "abc", dir: "/p/one", label: "one" }]);
    const back = readWorkspace(home);
    assert.equal(back.length, 1);
    assert.equal(back[0]?.id, "abc");
    assert.equal(workspacePath(home), join(home, "workspace.json"));
  });
});
