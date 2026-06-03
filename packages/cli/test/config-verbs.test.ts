// `loom config` + `loom secrets` verbs — driven directly against a temp global
// home (the `loomHome` override seam), no bin, no store. Asserts get/set,
// key + value validation, and that secrets are masked on read.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { readGlobalConfig, secretsPath } from "@loomfsm/config";

import { config } from "../src/commands/config.js";
import { secrets } from "../src/commands/secrets.js";
import type { CliEnv } from "../src/lib/env.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-cli-cfg-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function capture(): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = { home: "/unused", cwd: "/unused", out: (l) => out.push(l), err: (l) => err.push(l) };
  return { env, out, err };
}

describe("loom config", () => {
  it("set + get a backend", () => {
    const home = tmp();
    const { env, out } = capture();
    assert.equal(config(["set", "backend", "auto"], env, { loomHome: home }), 0);
    assert.equal(readGlobalConfig(home).backend, "auto");
    assert.equal(config(["get", "backend"], env, { loomHome: home }), 0);
    assert.ok(out.some((l) => l.includes("backend = auto")));
  });

  it("rejects an unknown backend and an unknown key", () => {
    const home = tmp();
    const { env, err } = capture();
    assert.equal(config(["set", "backend", "nope"], env, { loomHome: home }), 1);
    assert.ok(err.some((l) => l.includes("unknown backend")));
    assert.equal(config(["set", "frobnicate", "x"], env, { loomHome: home }), 1);
    assert.ok(err.some((l) => l.includes("unknown key")));
  });

  it("coerces a numeric key and rejects a non-integer", () => {
    const home = tmp();
    const { env } = capture();
    assert.equal(config(["set", "resilience.drive_deadline_ms", "5000"], env, { loomHome: home }), 0);
    assert.equal(readGlobalConfig(home).resilience?.drive_deadline_ms, 5000);
    assert.equal(config(["set", "resilience.drive_deadline_ms", "soon"], env, { loomHome: home }), 1);
  });

  it("sets a nested notify field and an events list", () => {
    const home = tmp();
    const { env } = capture();
    assert.equal(config(["set", "notify.slack_url", "https://hooks/x"], env, { loomHome: home }), 0);
    assert.equal(config(["set", "notify.events", "complete,failed"], env, { loomHome: home }), 0);
    const cfg = readGlobalConfig(home);
    assert.equal(cfg.notify?.slack_url, "https://hooks/x");
    assert.deepEqual(cfg.notify?.events, ["complete", "failed"]);
  });
});

describe("loom secrets", () => {
  it("set + list masked, chmod 600", () => {
    const home = tmp();
    const { env, out } = capture();
    assert.equal(secrets(["set", "OPENROUTER_KEY", "sk-abcdef123456"], env, { loomHome: home }), 0);
    // The set confirmation never prints the full value.
    assert.ok(!out.join("\n").includes("sk-abcdef123456"));
    assert.equal(statSync(secretsPath(home)).mode & 0o777, 0o600);

    const list = capture();
    assert.equal(secrets(["list"], list.env, { loomHome: home }), 0);
    const text = list.out.join("\n");
    assert.ok(text.includes("OPENROUTER_KEY"));
    assert.ok(!text.includes("sk-abcdef123456"), "list must mask the secret value");
  });

  it("list reports an empty store", () => {
    const home = tmp();
    const { env, out } = capture();
    assert.equal(secrets(["list"], env, { loomHome: home }), 0);
    assert.ok(out.some((l) => l.includes("none stored")));
  });
});
