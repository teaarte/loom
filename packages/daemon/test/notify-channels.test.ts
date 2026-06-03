// The non-webhook channels — Slack ({text}), Telegram (sendMessage), and a
// spawned custom script. The HTTP channels run over an injected fake `fetch`
// (offline, shape asserted); the script channel spawns a REAL node process and
// asserts it received the event JSON, then proves the best-effort contract on a
// non-zero exit and on a timeout.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  scriptNotifier,
  slackNotifier,
  telegramNotifier,
  type FetchLike,
  type NotifyEvent,
} from "../src/index.js";

const TS = "2026-06-02T10:00:00.000Z";

function ev(over: Partial<NotifyEvent> = {}): NotifyEvent {
  return { event: "complete", task_id: "t1", verdict: "accepted", branch: "loom/t1", ts: TS, ...over };
}

interface Captured {
  url: string;
  body?: string;
}

function recordingFetch(into: Captured[]): FetchLike {
  return async (url, init) => {
    into.push({ url, body: init?.body });
    return { ok: true, status: 200 };
  };
}

describe("notify channels — Slack incoming-webhook shape", () => {
  it("POSTs {text} with a one-line human rendering", async () => {
    const calls: Captured[] = [];
    const n = slackNotifier({ url: "https://hooks.slack.com/services/XXX", fetchImpl: recordingFetch(calls) });
    await n.notify(ev());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://hooks.slack.com/services/XXX");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload), ["text"]);
    assert.equal(typeof payload["text"], "string");
    assert.match(payload["text"] as string, /complete/);
    assert.match(payload["text"] as string, /accepted/);
  });
});

describe("notify channels — Telegram sendMessage shape", () => {
  it("POSTs {chat_id, text} to the bot sendMessage endpoint", async () => {
    const calls: Captured[] = [];
    const n = telegramNotifier({ token: "BOT123", chat_id: 4242, fetchImpl: recordingFetch(calls) });
    await n.notify(ev({ event: "parked", gate: "review" }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.telegram.org/botBOT123/sendMessage");
    const payload = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    assert.equal(payload["chat_id"], 4242);
    assert.equal(typeof payload["text"], "string");
    assert.match(payload["text"] as string, /parked/);
  });
});

describe("notify channels — custom script", () => {
  // A node one-liner that writes the event JSON (from the env) to argv[1].
  const WRITE_ENV = "require('fs').writeFileSync(process.argv[1], process.env.LOOM_NOTIFY_EVENT || '')";

  it("spawns the command and hands it the event JSON via env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-notify-script-"));
    try {
      const out = join(dir, "event.json");
      const n = scriptNotifier({ command: process.execPath, args: ["-e", WRITE_ENV, out] });
      const event = ev({ message: "hello" });
      await n.notify(event);
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), event);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swallows a non-zero exit (onError, resolves)", async () => {
    const errors: string[] = [];
    const n = scriptNotifier({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      onError: (m) => errors.push(m),
    });
    await n.notify(ev());
    assert.deepEqual(errors, ["script: exit 3"]);
  });

  it("kills and resolves a script that runs past the timeout", async () => {
    const errors: string[] = [];
    const n = scriptNotifier({
      command: process.execPath,
      args: ["-e", "setTimeout(function(){}, 60000)"],
      timeout_ms: 50,
      onError: (m) => errors.push(m),
    });
    await n.notify(ev()); // resolves once the timeout kills the child
    assert.ok(errors.includes("script: timeout"));
  });

  it("swallows a missing command (onError, resolves)", async () => {
    const errors: string[] = [];
    const n = scriptNotifier({
      command: join(tmpdir(), "loom-no-such-binary-xyz"),
      onError: (m) => errors.push(m),
    });
    await n.notify(ev());
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /^script: /);
  });
});
