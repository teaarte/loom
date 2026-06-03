// Notify config resolution from the environment: the allowlist parser, the
// "nothing configured → nullNotifier" short-circuit, and an end-to-end proof
// that a configured channel actually delivers (via the custom-script channel,
// so the test stays offline) AND that the allowlist gates the stream.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { nullNotifier, type NotifyEvent } from "@loomfsm/daemon";

import { parseNotifyEvents, resolveNotifier } from "../src/lib/notify.js";

const TS = "2026-06-02T10:00:00.000Z";
function ev(over: Partial<NotifyEvent> = {}): NotifyEvent {
  return { event: "complete", task_id: "t1", ts: TS, ...over };
}

describe("parseNotifyEvents", () => {
  it("defaults to complete,parked,failed when unset", () => {
    assert.deepEqual(parseNotifyEvents(undefined), ["complete", "parked", "failed"]);
  });
  it("parses a csv allowlist, trimming whitespace", () => {
    assert.deepEqual(parseNotifyEvents("complete, retry , watch-park"), [
      "complete",
      "retry",
      "watch-park",
    ]);
  });
  it("drops unknown tokens and keeps the valid ones", () => {
    assert.deepEqual(parseNotifyEvents("complete,bogus,failed"), ["complete", "failed"]);
  });
  it("falls back to the default when blank or all-invalid", () => {
    assert.deepEqual(parseNotifyEvents(""), ["complete", "parked", "failed"]);
    assert.deepEqual(parseNotifyEvents("nope,nada"), ["complete", "parked", "failed"]);
  });
});

describe("resolveNotifier — off by default", () => {
  it("returns the nullNotifier singleton when no channel is configured", async () => {
    assert.equal(await resolveNotifier({}), nullNotifier);
  });
});

describe("resolveNotifier — wires a configured channel end-to-end", () => {
  // An executable node hook that appends the event JSON (read from the env) to
  // a file. Proves env → channel → delivery without a network.
  const HOOK = [
    "#!/usr/bin/env node",
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.LOOM_NOTIFY_OUT, (process.env.LOOM_NOTIFY_EVENT ?? '') + '\\n');",
    "",
  ].join("\n");

  it("delivers an allowed event and the allowlist drops the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-cli-notify-"));
    const savedOut = process.env["LOOM_NOTIFY_OUT"];
    try {
      const hookPath = join(dir, "hook.mjs");
      const outPath = join(dir, "out.log");
      writeFileSync(hookPath, HOOK, "utf8");
      chmodSync(hookPath, 0o755);
      // The script channel inherits process.env for the child; the hook reads
      // its output path from there.
      process.env["LOOM_NOTIFY_OUT"] = outPath;

      const notifier = await resolveNotifier({
        LOOM_NOTIFY_SCRIPT: hookPath,
        LOOM_NOTIFY_EVENTS: "complete", // only complete is allowed
      });
      assert.notEqual(notifier, nullNotifier);

      await notifier.notify(ev({ event: "complete", verdict: "accepted" }));
      await notifier.notify(ev({ event: "retry", code: "X" })); // filtered out

      assert.ok(existsSync(outPath), "the allowed event reached the hook");
      const lines = readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 1, "exactly the one allowed event was delivered");
      const delivered = JSON.parse(lines[0] ?? "{}") as NotifyEvent;
      assert.equal(delivered.event, "complete");
      assert.equal(delivered.verdict, "accepted");
    } finally {
      if (savedOut === undefined) delete process.env["LOOM_NOTIFY_OUT"];
      else process.env["LOOM_NOTIFY_OUT"] = savedOut;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
