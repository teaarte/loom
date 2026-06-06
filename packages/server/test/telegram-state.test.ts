// The per-chat sidecar store — a real temp-file round-trip (no mock fs) plus the
// pure dedup transitions. The round-trip is what makes the bot restart-safe: the
// chat's active project, the prompted-gate cursor, and a pending task survive a
// reload.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  emptyState,
  getChat,
  loadState,
  markGatePrompted,
  markTerminalAnnounced,
  saveState,
} from "../src/intake/telegram-state.js";

function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-bot-state-"));
  return { path: join(dir, "telegram.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("telegram-state — round-trip", () => {
  it("persists and reloads the session-only fields atomically", () => {
    const { path, cleanup } = tempFile();
    try {
      const state = emptyState();
      const chat = getChat(state, 42);
      chat.active_project = "proj-7";
      chat.picker = ["a", "b", "proj-7"];
      chat.pending_task = { project: "proj-7", task: "do it", docker: true };
      chat.awaiting_reason = { project: "proj-7", gate_event_id: "gev-1", prompt_message_id: 99 };
      markGatePrompted(chat, "gev-1");
      markTerminalAnnounced(chat, "proj-7", "completed:t1");
      saveState(path, state);

      const reloaded = loadState(path);
      const back = reloaded.chats["42"];
      assert.ok(back);
      assert.equal(back.active_project, "proj-7");
      assert.deepEqual(back.picker, ["a", "b", "proj-7"]);
      assert.deepEqual(back.pending_task, { project: "proj-7", task: "do it", docker: true });
      assert.deepEqual(back.awaiting_reason, { project: "proj-7", gate_event_id: "gev-1", prompt_message_id: 99 });
      assert.deepEqual(back.prompted_gates, ["gev-1"]);
      assert.equal(back.announced_terminal["proj-7"], "completed:t1");
    } finally {
      cleanup();
    }
  });

  it("degrades a missing or corrupt sidecar to an empty state", () => {
    const { path, cleanup } = tempFile();
    try {
      assert.deepEqual(loadState(path), emptyState());
      saveState(path, emptyState());
      // Overwrite with garbage and confirm it does not throw.
      saveState(path, JSON.parse('{"chats": 5}') as never);
      assert.deepEqual(loadState(path), emptyState());
    } finally {
      cleanup();
    }
  });
});

describe("telegram-state — dedup transitions", () => {
  it("marks a gate prompted exactly once", () => {
    const chat = getChat(emptyState(), 1);
    assert.equal(markGatePrompted(chat, "gev-x"), true);
    assert.equal(markGatePrompted(chat, "gev-x"), false);
    assert.equal(markGatePrompted(chat, "gev-y"), true);
  });

  it("bounds the prompted-gate cursor", () => {
    const chat = getChat(emptyState(), 1);
    for (let i = 0; i < 250; i++) markGatePrompted(chat, `gev-${i}`);
    assert.ok(chat.prompted_gates.length <= 200);
    // The most recent id is retained; the oldest is evicted.
    assert.ok(chat.prompted_gates.includes("gev-249"));
    assert.ok(!chat.prompted_gates.includes("gev-0"));
  });

  it("announces a terminal marker once, re-announces a new one", () => {
    const chat = getChat(emptyState(), 1);
    assert.equal(markTerminalAnnounced(chat, "p", "completed:t1"), true);
    assert.equal(markTerminalAnnounced(chat, "p", "completed:t1"), false);
    assert.equal(markTerminalAnnounced(chat, "p", "completed:t2"), true);
  });
});
