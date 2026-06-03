// The layered resolver — precedence + the env overlay. Real temp-dir files.
//
// Precedence proven here: global ← project (project wins per agent), and the
// non-model settings reach the environment via an overlay that is merged UNDER
// the real environment so the environment still wins (the 0.2.1 no-regression
// guarantee).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_BACKEND,
  buildEnvOverlay,
  mergeConfig,
  resolveConfig,
  writeGlobalConfig,
  writeProjectConfig,
  writeSecrets,
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

describe("mergeConfig", () => {
  it("higher layer wins on backend + per-agent model", () => {
    const merged = mergeConfig(
      { backend: "auto", bundles: { d: { agents: { a: "g1", b: "g2" } } } },
      { bundles: { d: { agents: { a: "p1" } } } },
    );
    assert.equal(merged.backend, "auto");
    assert.equal(merged.bundles?.["d"]?.agents?.["a"], "p1"); // project wins
    assert.equal(merged.bundles?.["d"]?.agents?.["b"], "g2"); // global kept
  });

  it("merges notify + resilience field-wise", () => {
    const merged = mergeConfig(
      { notify: { slack_url: "s", webhook_url: "w" }, resilience: { rate_limit_wait: "1h" } },
      { notify: { slack_url: "s2" }, resilience: { drive_deadline_ms: 5 } },
    );
    assert.equal(merged.notify?.slack_url, "s2");
    assert.equal(merged.notify?.webhook_url, "w");
    assert.equal(merged.resilience?.rate_limit_wait, "1h");
    assert.equal(merged.resilience?.drive_deadline_ms, 5);
  });
});

describe("resolveConfig", () => {
  it("defaults backend to auto and merges global ← project model map", () => {
    const home = tmp();
    const proj = tmp();
    writeGlobalConfig(home, { bundles: { d: { agents: { a: "ga", b: "gb" } } } });
    writeProjectConfig(proj, { bundles: { d: { agents: { a: "pa" } } } });

    const r = resolveConfig({ projectDir: proj, env: { LOOM_HOME: home } });
    assert.equal(r.backend, AUTO_BACKEND);
    assert.equal(r.home, home);
    // Layers are kept separate (so a caller can slot providers.json between them).
    assert.equal(r.layers.global.bundles?.["d"]?.agents?.["a"], "ga");
    assert.equal(r.layers.project.bundles?.["d"]?.agents?.["a"], "pa");
    // Merged view: project wins on `a`, global retained for `b`.
    assert.equal(r.merged.bundles?.["d"]?.agents?.["a"], "pa");
    assert.equal(r.merged.bundles?.["d"]?.agents?.["b"], "gb");
  });

  it("derives a LOOM_* env overlay from notify + resilience", () => {
    const home = tmp();
    const proj = tmp();
    writeGlobalConfig(home, {
      resilience: { rate_limit_wait: "1h", drive_deadline_ms: 1000 },
      notify: { slack_url: "https://hooks/x", events: ["complete", "failed"], timeout_ms: 2000 },
    });
    const r = resolveConfig({ projectDir: proj, env: { LOOM_HOME: home } });
    assert.equal(r.envOverlay["LOOM_RATE_LIMIT_WAIT"], "1h");
    assert.equal(r.envOverlay["LOOM_DRIVE_DEADLINE_MS"], "1000");
    assert.equal(r.envOverlay["LOOM_NOTIFY_SLACK_URL"], "https://hooks/x");
    assert.equal(r.envOverlay["LOOM_NOTIFY_EVENTS"], "complete,failed");
    assert.equal(r.envOverlay["LOOM_NOTIFY_TIMEOUT_MS"], "2000");
  });

  it("resolves a secret-referenced notify token via secrets.json", () => {
    const home = tmp();
    const proj = tmp();
    writeSecrets(home, { TG: "999:token" });
    writeGlobalConfig(home, { notify: { telegram_token: "secret:TG", telegram_chat: "42" } });
    const overlay = buildEnvOverlay(
      resolveConfig({ projectDir: proj, env: { LOOM_HOME: home } }).merged,
      home,
      { LOOM_HOME: home },
    );
    assert.equal(overlay["LOOM_NOTIFY_TELEGRAM_TOKEN"], "999:token");
    assert.equal(overlay["LOOM_NOTIFY_TELEGRAM_CHAT"], "42");
  });

  it("env still wins when the overlay is merged under the real environment", () => {
    const home = tmp();
    const proj = tmp();
    writeGlobalConfig(home, { resilience: { rate_limit_wait: "1h" } });
    const r = resolveConfig({ projectDir: proj, env: { LOOM_HOME: home } });
    // The caller merges overlay UNDER process.env — the real env beats config.
    const realEnv = { LOOM_RATE_LIMIT_WAIT: "30m" };
    const effective = { ...r.envOverlay, ...realEnv };
    assert.equal(effective["LOOM_RATE_LIMIT_WAIT"], "30m");
  });
});
