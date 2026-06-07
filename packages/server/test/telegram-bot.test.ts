// The interactive bot's dispatch core, driven end-to-end through a fake
// `FetchLike` — no live Telegram, no live control plane, no loops. The real
// telegram + loom clients run over the fake fetch, so the codec, the bearer
// contract, and the handlers are all exercised. Asserts the acceptance surface:
// the allowlist refuses an un-listed user, a button tap makes the right /answer
// call, gate prompts dedup, a free-text task submits with the chosen complexity,
// completion offers ship buttons, and a clean ship refusal is surfaced.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ProjectStatusView } from "../src/read-model.js";
import type { TgUpdate } from "../src/intake/telegram-api.js";
import { createBotContext, handleUpdate, watchTick, type BotContext, type TelegramBotConfig } from "../src/intake/telegram-bot.js";
import { getChat } from "../src/intake/telegram-state.js";
import type { FetchLike } from "../src/intake/telegram.js";

const USER = 7;
const CHAT = 1000;
const SERVER = "http://loom.test";

interface TgCall {
  method: string;
  payload: Record<string, unknown> | string | undefined;
}
interface LoomCall {
  method: string;
  path: string;
  body: unknown;
}
type LoomResponder = (method: string, path: string, body: unknown) => { status?: number; body: unknown };

interface Harness {
  ctx: BotContext;
  tgCalls: TgCall[];
  loomCalls: LoomCall[];
  cleanup: () => void;
}

function harness(opts: { allowed?: number[]; loom?: LoomResponder; nowMs?: number } = {}): Harness {
  const tgCalls: TgCall[] = [];
  const loomCalls: LoomCall[] = [];
  let messageId = 500;

  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const ct = init?.headers?.["content-type"];
    const body =
      init?.body !== undefined && ct !== undefined && ct.includes("application/json")
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : init?.body;

    if (url.startsWith("https://api.telegram.org")) {
      const tgMethod = url.split("/").pop()?.split("?")[0] ?? "";
      tgCalls.push({ method: tgMethod, payload: body });
      let result: unknown = true;
      if (tgMethod === "sendMessage") result = { message_id: messageId++ };
      else if (tgMethod === "getUpdates") result = [];
      return resp(200, { ok: true, result });
    }

    const parsed = new URL(url);
    loomCalls.push({ method, path: parsed.pathname + parsed.search, body });
    const r = opts.loom?.(method, parsed.pathname, body) ?? { status: 200, body: {} };
    return resp(r.status ?? 200, r.body);
  };

  const dir = mkdtempSync(join(tmpdir(), "loom-bot-"));
  const cfg: TelegramBotConfig = {
    bot_token: "T",
    allowed_users: opts.allowed ?? [USER],
    server_url: SERVER,
    state_path: join(dir, "state.json"),
    fetchImpl,
  };
  const ctx = createBotContext(cfg, { nowMs: () => opts.nowMs ?? 1_700_000_000_000 });
  return { ctx, tgCalls, loomCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function resp(status: number, body: unknown): { ok: boolean; status: number; text(): Promise<string> } {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function statusView(over: Partial<ProjectStatusView> = {}): ProjectStatusView {
  return {
    project_dir: "/repos/demo",
    has_task: true,
    task_id: "t1",
    task_label: "lbl",
    task: "the task",
    status: "in_progress",
    verdict: null,
    flow: { name: "main", step_index: 1 },
    active_phase: "build",
    parked_gate: null,
    pending_agents: [],
    stalled: false,
    started_at: null,
    ended_at: null,
    ...over,
  };
}

function msgUpdate(text: string, opts: { from?: number; replyTo?: number } = {}): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: CHAT },
      from: { id: opts.from ?? USER },
      text,
      ...(opts.replyTo !== undefined ? { reply_to_message: { message_id: opts.replyTo } } : {}),
    },
  };
}

function cbUpdate(data: string, from = USER): TgUpdate {
  return {
    update_id: 1,
    callback_query: { id: "cb1", from: { id: from }, message: { message_id: 1, chat: { id: CHAT } }, data },
  };
}

function lastText(tgCalls: TgCall[]): string {
  const sends = tgCalls.filter((c) => c.method === "sendMessage");
  const last = sends[sends.length - 1]?.payload;
  return typeof last === "object" && last !== null ? String((last as { text?: unknown }).text ?? "") : "";
}

function sendMarkup(call: TgCall | undefined): { inline_keyboard?: { callback_data: string }[][] } | undefined {
  const p = call?.payload;
  if (typeof p !== "object" || p === null) return undefined;
  return (p as { reply_markup?: { inline_keyboard?: { callback_data: string }[][] } }).reply_markup;
}

describe("telegram-bot — allowlist", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  it("refuses a message from an un-listed user and makes no control-plane call", async () => {
    h = harness({ allowed: [USER] });
    await handleUpdate(h.ctx, msgUpdate("do something", { from: 999 }));
    assert.equal(h.loomCalls.length, 0);
    assert.match(lastText(h.tgCalls), /Not authorized/);
  });

  it("refuses a callback from an un-listed user without answering a gate", async () => {
    h = harness({ allowed: [USER] });
    getChat(h.ctx.state, CHAT).active_project = "p1";
    await handleUpdate(h.ctx, cbUpdate("ga|gev-1", 999));
    assert.ok(!h.loomCalls.some((c) => c.path.includes("/answer")));
    assert.ok(h.tgCalls.some((c) => c.method === "answerCallbackQuery"));
  });
});

describe("telegram-bot — select project + submit", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  it("sets the active project from a picker tap", async () => {
    h = harness();
    getChat(h.ctx.state, CHAT).picker = ["alpha", "beta"];
    await handleUpdate(h.ctx, cbUpdate("sp|1"));
    assert.equal(getChat(h.ctx.state, CHAT).active_project, "beta");
    assert.match(lastText(h.tgCalls), /Active project: beta/);
  });

  it("free text offers a complexity row, then submits with the chosen complexity", async () => {
    h = harness({
      loom: (method, path) => {
        if (path === "/providers") return { body: { backend_mode: "x", providers: [], docker: { available: false } } };
        if (path === "/submit") return { body: { id: "p1", dir: "/d", task_id: "task-9", status: "spawn-agent", replayed: false } };
        return { body: {} };
      },
    });
    getChat(h.ctx.state, CHAT).active_project = "p1";

    await handleUpdate(h.ctx, msgUpdate("add a route"));
    // Complexity keyboard offered; no submit yet.
    assert.ok(!h.loomCalls.some((c) => c.path === "/submit"));
    const kb = sendMarkup(h.tgCalls.filter((c) => c.method === "sendMessage").at(-1));
    assert.ok(kb?.inline_keyboard?.flat().some((b) => b.callback_data === "cx|medium"));

    await handleUpdate(h.ctx, cbUpdate("cx|medium"));
    const submit = h.loomCalls.find((c) => c.path === "/submit");
    assert.ok(submit);
    assert.deepEqual(submit.body, { project: "p1", task: "add a route", complexity: "medium" });
    assert.match(lastText(h.tgCalls), /submitted task-9/);
  });

  it("auto complexity omits the field; docker toggle adds docker:true", async () => {
    h = harness({
      loom: (method, path) => {
        if (path === "/providers") return { body: { backend_mode: "x", providers: [], docker: { available: true } } };
        if (path === "/submit") return { body: { id: "p1", dir: "/d", task_id: "task-1", status: "s", replayed: false } };
        return { body: {} };
      },
    });
    getChat(h.ctx.state, CHAT).active_project = "p1";

    await handleUpdate(h.ctx, msgUpdate("a task"));
    await handleUpdate(h.ctx, cbUpdate("dk")); // toggle docker on
    await handleUpdate(h.ctx, cbUpdate("cx|auto"));

    const submit = h.loomCalls.find((c) => c.path === "/submit");
    assert.ok(submit);
    assert.deepEqual(submit.body, { project: "p1", task: "a task", docker: true });
  });

  it("free text with no active project asks to pick one, submits nothing", async () => {
    h = harness();
    await handleUpdate(h.ctx, msgUpdate("a task"));
    assert.ok(!h.loomCalls.some((c) => c.path === "/submit"));
    assert.match(lastText(h.tgCalls), /No active project/);
  });
});

describe("telegram-bot — gate answers", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  function answerLoom(): LoomResponder {
    return (method, path) => (path.endsWith("/answer") ? { body: { id: "p1", status: "spawn-agent" } } : { body: {} });
  }

  it("approve -> POST answer {accept}", async () => {
    h = harness({ loom: answerLoom() });
    getChat(h.ctx.state, CHAT).active_project = "p1";
    await handleUpdate(h.ctx, cbUpdate("ga|gev-7"));
    const call = h.loomCalls.find((c) => c.path.endsWith("/answer"));
    assert.ok(call);
    assert.equal(call.path, "/projects/p1/answer");
    assert.deepEqual(call.body, { gate_event_id: "gev-7", decision: "accept" });
  });

  it("abandon -> POST answer {reject, abandon}", async () => {
    h = harness({ loom: answerLoom() });
    getChat(h.ctx.state, CHAT).active_project = "p1";
    await handleUpdate(h.ctx, cbUpdate("gx|gev-7"));
    const call = h.loomCalls.find((c) => c.path.endsWith("/answer"));
    assert.deepEqual(call?.body, { gate_event_id: "gev-7", decision: "reject", reject_intent: "abandon" });
  });

  it("reject -> force-reply -> the reply answers {reject, revise, message}", async () => {
    h = harness({ loom: answerLoom() });
    getChat(h.ctx.state, CHAT).active_project = "p1";

    await handleUpdate(h.ctx, cbUpdate("gr|gev-7"));
    // No answer yet — a force-reply prompt went out and was recorded as pending.
    assert.ok(!h.loomCalls.some((c) => c.path.endsWith("/answer")));
    const promptId = getChat(h.ctx.state, CHAT).awaiting_reason?.prompt_message_id;
    assert.ok(typeof promptId === "number");

    await handleUpdate(h.ctx, msgUpdate("tighten the error handling", { replyTo: promptId }));
    const call = h.loomCalls.find((c) => c.path.endsWith("/answer"));
    assert.deepEqual(call?.body, {
      gate_event_id: "gev-7",
      decision: "reject",
      reject_intent: "revise",
      message: "tighten the error handling",
    });
    assert.equal(getChat(h.ctx.state, CHAT).awaiting_reason, undefined);
  });

  it("surfaces a stale-gate refusal as a readable reply", async () => {
    h = harness({
      loom: (method, path) =>
        path.endsWith("/answer")
          ? { status: 409, body: { error: { code: "GATE_EVENT_STALE", message: "gate moved on" } } }
          : { body: {} },
    });
    getChat(h.ctx.state, CHAT).active_project = "p1";
    await handleUpdate(h.ctx, cbUpdate("ga|gev-old"));
    assert.match(lastText(h.tgCalls), /GATE_EVENT_STALE/);
  });
});

describe("telegram-bot — watch loop", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  it("DMs a parked gate once and dedups by gate_event_id", async () => {
    const parked = statusView({ parked_gate: { gate: "review", message: "approve?", gate_event_id: "gev-42" } });
    h = harness({
      loom: (method, path) =>
        path === "/projects/p1" ? { body: { id: "p1", dir: "/repos/demo", supervised: true, status: parked } } : { body: {} },
    });
    const chat = getChat(h.ctx.state, CHAT);
    chat.active_project = "p1";

    await watchTick(h.ctx, CHAT, chat);
    await watchTick(h.ctx, CHAT, chat);

    const prompts = h.tgCalls.filter(
      (c) => c.method === "sendMessage" && typeof c.payload === "object" && String((c.payload as { text?: string }).text).includes("parked at gate"),
    );
    assert.equal(prompts.length, 1, "gate prompt must be sent exactly once");
    const kb = sendMarkup(prompts[0]);
    assert.ok(kb?.inline_keyboard?.flat().some((b) => b.callback_data === "ga|gev-42"));
  });

  it("DMs a completion summary with ship buttons once", async () => {
    const done = statusView({ status: "completed", verdict: "accepted", ended_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:00Z" });
    h = harness({
      loom: (method, path) => {
        if (path === "/projects/p1") return { body: { id: "p1", dir: "/repos/demo", supervised: true, status: done } };
        if (path === "/projects/p1/trace") return { body: { archived: false, summary: { completion_summary: "Done: 3 files." }, agents: [] } };
        if (path === "/projects/p1/artifact") return { status: 404, body: { error: { code: "ARTIFACT_NOT_FOUND", message: "no" } } };
        return { body: {} };
      },
    });
    const chat = getChat(h.ctx.state, CHAT);
    chat.active_project = "p1";

    await watchTick(h.ctx, CHAT, chat);
    await watchTick(h.ctx, CHAT, chat);

    const completions = h.tgCalls.filter(
      (c) => c.method === "sendMessage" && String((c.payload as { text?: string }).text).includes("Done: 3 files."),
    );
    assert.equal(completions.length, 1);
    const kb = sendMarkup(completions[0]);
    assert.ok(kb?.inline_keyboard?.flat().some((b) => b.callback_data === "pm"));
    assert.ok(kb?.inline_keyboard?.flat().some((b) => b.callback_data === "pu"));
  });
});

describe("telegram-bot — ship + plan", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  it("squash-merge surfaces a dirty-tree refusal honestly", async () => {
    h = harness({
      loom: (method, path) =>
        path === "/projects/p1/merge"
          ? { body: { id: "p1", dir: "/d", merged: false, into: "main", reason: "dirty-tree" } }
          : { body: {} },
    });
    getChat(h.ctx.state, CHAT).active_project = "p1";
    await handleUpdate(h.ctx, cbUpdate("pm"));
    assert.match(lastText(h.tgCalls), /not merged/);
    assert.match(lastText(h.tgCalls), /dirty/);
  });

  it("plan reads the plan artifact and sends it", async () => {
    h = harness({
      loom: (method, path) =>
        path === "/projects/p1/artifact"
          ? { body: { path: ".loom/work/plan.md", content: "# Plan\n- step one", truncated: false } }
          : { body: {} },
    });
    getChat(h.ctx.state, CHAT).active_project = "p1";
    await handleUpdate(h.ctx, cbUpdate("pl"));
    const artifactCall = h.loomCalls.find((c) => c.path.startsWith("/projects/p1/artifact"));
    assert.ok(artifactCall?.path.includes("path=.loom%2Fwork%2Fplan.md"));
    assert.match(lastText(h.tgCalls), /# Plan/);
  });
});
