// The reference Telegram intake adapter — proof that intake is a thin client
// of POST /submit. A fake `fetch` records the call; no live Telegram, no live
// control plane. This is what keeps the "any intake adapter is just a submit
// client" claim honest.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseUpdate,
  submitFromTelegram,
  type FetchLike,
  type TelegramConfig,
} from "../src/intake/telegram.js";

interface Recorded {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function fakeFetch(responder: (url: string) => { ok: boolean; status: number; body: string }): {
  fetchImpl: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ?? {}) });
    const r = responder(url);
    return { ok: r.ok, status: r.status, text: async () => r.body };
  };
  return { fetchImpl, calls };
}

function cfg(fetchImpl: FetchLike): TelegramConfig {
  return { bot_token: "bot-tok", server_url: "http://127.0.0.1:4317", project: "proj-id", server_token: "sek", fetchImpl };
}

describe("telegram intake — parseUpdate", () => {
  it("extracts chat id + text from a message update", () => {
    const m = parseUpdate({ update_id: 1, message: { chat: { id: 42 }, text: "  do it  " } });
    assert.deepEqual(m, { chat_id: 42, text: "do it" });
  });

  it("ignores a non-text or empty update", () => {
    assert.equal(parseUpdate({ update_id: 2, message: { chat: { id: 1 } } }), null);
    assert.equal(parseUpdate({ update_id: 3, message: { chat: { id: 1 }, text: "   " } }), null);
    assert.equal(parseUpdate({ update_id: 4 }), null);
  });
});

describe("telegram intake — submitFromTelegram", () => {
  it("POSTs the task to /submit with the bearer token and returns a success reply", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ task_id: "task-7", status: "spawn-agent" }),
    }));
    const reply = await submitFromTelegram(cfg(fetchImpl), { chat_id: 42, text: "add a route" });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, "http://127.0.0.1:4317/submit");
    assert.equal(call.method, "POST");
    assert.equal(call.headers?.["authorization"], "Bearer sek");
    assert.deepEqual(JSON.parse(call.body ?? "{}"), { project: "proj-id", task: "add a route" });
    assert.match(reply, /submitted task-7/);
  });

  it("turns a typed control-plane refusal into a readable reply", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      ok: false,
      status: 409,
      body: JSON.stringify({ error: { code: "PROJECT_TASK_ACTIVE", message: "a task is already live" } }),
    }));
    const reply = await submitFromTelegram(cfg(fetchImpl), { chat_id: 42, text: "another" });
    assert.match(reply, /PROJECT_TASK_ACTIVE/);
  });
});
