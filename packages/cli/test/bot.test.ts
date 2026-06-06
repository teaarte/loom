// The `loom bot telegram` launcher's pre-flight: a bad subcommand and the env
// validation that refuses to start without a bot token or an allowlist (both
// return before the heavy control-plane import, so they are driven directly).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { bot } from "../src/commands/bot.js";
import type { CliEnv } from "../src/lib/env.js";

function makeEnv(): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = { home: "/tmp/nohome", cwd: "/tmp/nocwd", out: (l) => out.push(l), err: (l) => err.push(l) };
  return { env, out, err };
}

const KEYS = ["LOOM_TG_BOT_TOKEN", "LOOM_TG_ALLOWED_USERS", "LOOM_SERVER_URL", "LOOM_SERVER_TOKEN"] as const;
let saved: Record<string, string | undefined>;

describe("loom bot — pre-flight", () => {
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("rejects a missing subcommand with usage", async () => {
    const { env, err } = makeEnv();
    assert.equal(await bot([], env), 1);
    assert.ok(err.some((l) => /expected 'telegram'/.test(l)));
  });

  it("refuses to start without a bot token", async () => {
    const { env, err } = makeEnv();
    assert.equal(await bot(["telegram"], env), 1);
    assert.ok(err.some((l) => /LOOM_TG_BOT_TOKEN is required/.test(l)));
  });

  it("refuses to start without an allowlist", async () => {
    process.env["LOOM_TG_BOT_TOKEN"] = "123:abc";
    const { env, err } = makeEnv();
    assert.equal(await bot(["telegram"], env), 1);
    assert.ok(err.some((l) => /LOOM_TG_ALLOWED_USERS is required/.test(l)));
  });

  it("ignores non-numeric allowlist entries (an all-garbage list is empty)", async () => {
    process.env["LOOM_TG_BOT_TOKEN"] = "123:abc";
    process.env["LOOM_TG_ALLOWED_USERS"] = "abc, , -3";
    const { env, err } = makeEnv();
    assert.equal(await bot(["telegram"], env), 1);
    assert.ok(err.some((l) => /LOOM_TG_ALLOWED_USERS is required/.test(l)));
  });
});
