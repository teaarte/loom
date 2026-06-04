// The shared CLI capture seam — the operational timeouts (session + idle) and
// the rate-limit recognition on a non-zero exit. Exercised with `node -e` fake
// children (a sleeper, a periodic emitter, an envelope-on-exit) so the kill +
// timer behaviour is real with NO network and NO `claude`/`docker`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { spawnCapture } from "../src/spawn-cli.js";
import { defaultRateLimitDetector } from "../src/index.js";

const NODE = process.execPath;

// A child that never exits on its own (until killed) and emits nothing.
const SLEEPER = ["-e", "setTimeout(() => {}, 60000)"];

async function expectReject(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
  throw new Error("expected the capture to reject, but it resolved");
}

describe("spawnCapture — session timeout", () => {
  it("kills a long-running child and rejects EXECUTOR_TIMEOUT", async () => {
    const err = await expectReject(
      spawnCapture({
        bin: NODE,
        args: SLEEPER,
        label: "claude -p",
        notFoundMessage: "n/a",
        session_timeout_ms: 80,
      }),
    );
    assert.equal(err.code, "EXECUTOR_TIMEOUT");
    assert.match(err.message, /session timeout/);
  });
});

describe("spawnCapture — idle (output-silence) timeout", () => {
  it("kills a silent child and rejects EXECUTOR_IDLE_TIMEOUT", async () => {
    const err = await expectReject(
      spawnCapture({
        bin: NODE,
        args: SLEEPER,
        label: "claude -p",
        notFoundMessage: "n/a",
        idle_timeout_ms: 80,
      }),
    );
    assert.equal(err.code, "EXECUTOR_IDLE_TIMEOUT");
    assert.match(err.message, /no output/);
  });

  it("a steady output stream resets the idle timer — the run completes", async () => {
    // Emits every 40ms (< the 250ms idle cap), four times, then exits 0. The
    // idle timer is re-armed on each chunk, so it never fires.
    const args = [
      "-e",
      "let n=0;const t=setInterval(()=>{process.stdout.write('tick');if(++n>=4){clearInterval(t);process.exit(0);}},40)",
    ];
    const out = await spawnCapture({
      bin: NODE,
      args,
      label: "claude -p",
      notFoundMessage: "n/a",
      idle_timeout_ms: 250,
    });
    assert.match(out.stdout, /tick/);
  });
});

describe("spawnCapture — rate-limit recognition on a non-zero exit", () => {
  it("reads the api_error_status:429 envelope off stdout → EXECUTOR_RATE_LIMITED", async () => {
    const envelope = JSON.stringify({ is_error: true, api_error_status: 429, result: "rate_limit_error" });
    const args = ["-e", `process.stdout.write(${JSON.stringify(envelope)});process.exit(1)`];
    const err = await expectReject(
      spawnCapture({
        bin: NODE,
        args,
        label: "claude -p",
        notFoundMessage: "n/a",
        detectRateLimit: defaultRateLimitDetector,
      }),
    );
    assert.equal(err.code, "EXECUTOR_RATE_LIMITED");
  });

  it("a generic non-zero exit (no rate-limit signal) stays EXECUTOR_FAILED", async () => {
    const args = ["-e", "process.stderr.write('boom');process.exit(2)"];
    const err = await expectReject(
      spawnCapture({
        bin: NODE,
        args,
        label: "claude -p",
        notFoundMessage: "n/a",
        detectRateLimit: defaultRateLimitDetector,
      }),
    );
    assert.equal(err.code, "EXECUTOR_FAILED");
  });
});

describe("spawnCapture — raw output is diagnosable on a non-zero exit", () => {
  it("folds the truncated raw stdout AND stderr into the EXECUTOR_FAILED message", async () => {
    const args = [
      "-e",
      "process.stdout.write('partial transcript with no JSON');process.stderr.write('tool error 7');process.exit(3)",
    ];
    const err = await expectReject(
      spawnCapture({ bin: NODE, args, label: "claude -p", notFoundMessage: "n/a" }),
    );
    assert.equal(err.code, "EXECUTOR_FAILED");
    // The message — the only thing drive() forwards — carries the raw output, so
    // "why did this spawn fail?" is answerable without reading the backend's own
    // session transcript.
    assert.match(err.message, /exited with code 3/);
    assert.match(err.message, /partial transcript with no JSON/);
    assert.match(err.message, /tool error 7/);
  });
});

describe("spawnCapture — baseline paths still hold", () => {
  it("resolves with the captured streams on a clean exit", async () => {
    const args = ["-e", "process.stdout.write('hello');process.exit(0)"];
    const out = await spawnCapture({ bin: NODE, args, label: "claude -p", notFoundMessage: "n/a" });
    assert.equal(out.stdout, "hello");
    assert.equal(out.exitCode, 0);
  });

  it("rejects EXECUTOR_NOT_FOUND when the binary is missing", async () => {
    const err = await expectReject(
      spawnCapture({
        bin: "loom-definitely-not-a-real-binary-xyz",
        args: [],
        label: "claude -p",
        notFoundMessage: "install it",
      }),
    );
    assert.equal(err.code, "EXECUTOR_NOT_FOUND");
    assert.equal(err.message, "install it");
  });
});
