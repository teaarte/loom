// The per-spawn transcript writer — writes to the HOST project's
// `.loom/transcripts/<run_id>.json`, caps the prompt + output, drops a
// self-ignoring `.gitignore`, and keys the filename strictly. No mocks: a real
// temp tree.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnTranscriptDir, spawnTranscriptPath, writeSpawnTranscript } from "../src/transcript.js";

describe("writeSpawnTranscript", () => {
  it("writes one file per agent_run_id with the full record", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-tx-"));
    try {
      writeSpawnTranscript(dir, {
        agent: "implementer",
        agent_run_id: "ar-1",
        phase: "implementation",
        model: "opus",
        prompt: "PROMPT",
        raw_output: "OUTPUT",
        parse_result: { files_modified: ["a.ts"], files_created: ["b.ts"] },
        usage: { tokens: { in: 1, out: 2 }, cost_usd: 0.5 },
        recorded_at: "2026-06-05T00:00:00.000Z",
      });
      const parsed = JSON.parse(readFileSync(spawnTranscriptPath(dir, "ar-1"), "utf8"));
      assert.equal(parsed.agent, "implementer");
      assert.equal(parsed.prompt, "PROMPT");
      assert.equal(parsed.raw_output, "OUTPUT");
      assert.deepEqual(parsed.parse_result.files_created, ["b.ts"]);
      assert.equal(parsed.usage.cost_usd, 0.5);
      // Self-ignoring dir.
      assert.equal(readFileSync(join(spawnTranscriptDir(dir), ".gitignore"), "utf8"), "*\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps an oversized prompt / output with a truncation marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-tx-"));
    try {
      const big = "x".repeat(250_000);
      writeSpawnTranscript(dir, {
        agent: "a", agent_run_id: "ar-big", phase: "p", model: null,
        prompt: big, raw_output: big, parse_result: {}, recorded_at: "2026-06-05T00:00:00.000Z",
      });
      const parsed = JSON.parse(readFileSync(spawnTranscriptPath(dir, "ar-big"), "utf8"));
      assert.ok(parsed.prompt.length < big.length, "prompt should be clamped");
      assert.match(parsed.prompt, /chars truncated/);
      assert.match(parsed.raw_output, /chars truncated/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes a hostile agent_run_id into a single safe path segment", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-tx-"));
    try {
      const p = spawnTranscriptPath(dir, "../../etc/passwd");
      // Separators are stripped, so the file lands DIRECTLY in the transcripts
      // dir — it can never nest or escape, whatever dots the id carries.
      assert.equal(dirname(p), spawnTranscriptDir(dir));
      writeSpawnTranscript(dir, {
        agent: "a", agent_run_id: "../../etc/passwd", phase: "p", model: null,
        prompt: "", raw_output: "", parse_result: {}, recorded_at: "2026-06-05T00:00:00.000Z",
      });
      assert.ok(existsSync(p));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
