// The interactive Telegram bot — full remote control of loom from chat. It is a
// thin client of the EXISTING control-plane HTTP API (the same seam the
// dashboard uses): pick a project, submit a task, approve / answer gates, read
// the plan and status, and ship the result. ZERO kernel/core change.
//
// Two concerns run as two loops over one abort signal:
//   • telegramLoop — long-polls `getUpdates` and dispatches messages + button
//     taps (the operator-driven path).
//   • watchLoop    — sweeps the read-model of each chat's active project and
//     PROACTIVELY DMs gate prompts and completion summaries with inline buttons
//     (the supervision path). It does not rely on the fire-and-forget notifier;
//     it dedups by gate_event_id / terminal marker so a sweep never double-sends.
//
// Security: the sole auth surface is the sender allowlist by Telegram user_id —
// the bot can launch agents on the operator's repos, so every update from a
// non-allowlisted user is refused. The transport is outbound-only (long-poll),
// so the control plane stays loopback-bound. The bot token and bearer are read
// from env and never logged.
//
// Testability: `handleUpdate` and `watchTick` are the unit-tested core, driven
// with a fake `FetchLike` (no live Telegram, no live server, no loops).

import { makeLoomClient, type AnswerBody, type ApiResult, type LoomClient, type SubmitBody } from "./loom-client.js";
import { makeTelegramApi, type TelegramApi, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./telegram-api.js";
import {
  cancelConfirmKeyboard,
  chunk,
  complexityKeyboard,
  completionText,
  gateKeyboard,
  gatePromptText,
  HELP_TEXT,
  parseCallback,
  pickerKeyboard,
  projectTitle,
  shipKeyboard,
  shipResultText,
  statusText,
} from "./telegram-render.js";
import {
  getChat,
  loadState,
  markGatePrompted,
  markTerminalAnnounced,
  saveState,
  type BotState,
  type ChatState,
} from "./telegram-state.js";
import type { FetchLike } from "./telegram.js";

export interface TelegramBotConfig {
  // Bot token for the Telegram Bot API.
  bot_token: string;
  // Telegram user_ids permitted to drive the bot. Every other sender is refused.
  allowed_users: number[];
  // The loom control-plane base URL (e.g. http://127.0.0.1:4317).
  server_url: string;
  // The control-plane bearer token, if it requires one.
  server_token?: string;
  // Where the per-chat sidecar lives.
  state_path: string;
  fetchImpl: FetchLike;
}

export interface TelegramBotOptions {
  signal?: AbortSignal;
  poll_timeout_s?: number;
  watch_interval_ms?: number;
  onLog?: (line: string) => void;
  // Test seam — a sleep that a suite can stub. Production uses a timer.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Test seam — a fixed clock for deterministic elapsed rendering.
  nowMs?: () => number;
}

// The bundle of dependencies the handlers act on. A test builds this directly
// with a fake `tg` / `loom` and an in-memory state; production builds it from a
// config in `createBotContext`.
export interface BotContext {
  tg: TelegramApi;
  loom: LoomClient;
  state: BotState;
  statePath: string;
  allowed: Set<number>;
  log: (line: string) => void;
  nowMs: () => number;
}

export function createBotContext(
  cfg: TelegramBotConfig,
  deps: { nowMs?: () => number; log?: (line: string) => void } = {},
): BotContext {
  return {
    tg: makeTelegramApi(cfg.fetchImpl, cfg.bot_token),
    loom: makeLoomClient(cfg.fetchImpl, cfg.server_url, cfg.server_token),
    state: loadState(cfg.state_path),
    statePath: cfg.state_path,
    allowed: new Set(cfg.allowed_users),
    log: deps.log ?? ((): void => {}),
    nowMs: deps.nowMs ?? ((): number => Date.now()),
  };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const persist = (ctx: BotContext): void => saveState(ctx.statePath, ctx.state);
// A function (not a direct `signal.aborted` read) so each call re-evaluates the
// live getter — a direct comparison inside a loop body would be narrowed away by
// the enclosing `while (signal?.aborted !== true)` condition.
const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

// Render an ApiResult into a one-line reply: a refusal becomes a readable code +
// message rather than silence — the bot is never quiet about a failed call.
function replyError(code: string, message: string): string {
  return `⚠️ ${code}: ${message}`;
}

// ----- update dispatch --------------------------------------------------

export async function handleUpdate(ctx: BotContext, update: TgUpdate): Promise<void> {
  if (update.callback_query !== undefined) {
    await handleCallback(ctx, update.callback_query);
    return;
  }
  const message = update.message;
  if (message === undefined) return;
  const chatId = message.chat?.id;
  if (typeof chatId !== "number") return;
  const userId = message.from?.id;
  if (typeof userId !== "number" || !ctx.allowed.has(userId)) {
    // Refuse — but echo the sender their OWN id so a misconfigured operator can
    // populate the allowlist (learning your own id is not a disclosure).
    ctx.log(`refused message from user ${userId ?? "?"} (not allowlisted)`);
    await ctx.tg.sendMessage(chatId, `⛔ Not authorized.\nAdd your id to LOOM_TG_ALLOWED_USERS: ${userId ?? "unknown"}`);
    return;
  }
  await handleMessage(ctx, chatId, message);
}

async function handleMessage(ctx: BotContext, chatId: number, message: TgMessage): Promise<void> {
  const chat = getChat(ctx.state, chatId);
  const text = message.text?.trim() ?? "";

  // 1) A reply to a force-reply rejection-reason prompt -> answer reject+revise.
  const awaiting = chat.awaiting_reason;
  if (
    awaiting !== undefined &&
    message.reply_to_message?.message_id === awaiting.prompt_message_id &&
    text.length > 0
  ) {
    delete chat.awaiting_reason;
    persist(ctx);
    const r = await ctx.loom.answer(awaiting.project, {
      gate_event_id: awaiting.gate_event_id,
      decision: "reject",
      reject_intent: "revise",
      message: text,
    });
    await ctx.tg.sendMessage(chatId, answerReply(r, "rejected for revision"));
    return;
  }

  if (text.length === 0) return;

  // 2) A command.
  if (text.startsWith("/")) {
    await handleCommand(ctx, chatId, chat, text);
    return;
  }

  // 3) Free text = a task for the active project. Stash it and offer the
  // complexity row (with a Docker toggle when the backend can honour it).
  if (chat.active_project === undefined) {
    await ctx.tg.sendMessage(chatId, "No active project yet — pick one with /projects.");
    return;
  }
  chat.pending_task = { project: chat.active_project, task: text };
  persist(ctx);
  const providers = await ctx.loom.getProviders();
  const dockerAvailable = providers.ok && providers.data.docker?.available === true;
  await ctx.tg.sendMessage(
    chatId,
    `Task for ${chat.active_project}:\n“${truncate(text, 200)}”\n\nPick complexity (Auto lets the classifier decide):`,
    { reply_markup: { inline_keyboard: complexityKeyboard({ dockerAvailable, dockerOn: false }) } },
  );
}

async function handleCommand(ctx: BotContext, chatId: number, chat: ChatState, text: string): Promise<void> {
  const cmd = text.split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (cmd) {
    case "/start":
    case "/help":
      await ctx.tg.sendMessage(chatId, HELP_TEXT);
      return;
    case "/projects":
      await sendPicker(ctx, chatId, chat);
      return;
    case "/status":
      if (chat.active_project === undefined) {
        await ctx.tg.sendMessage(chatId, "No active project — /projects first.");
        return;
      }
      await sendStatus(ctx, chatId, chat.active_project);
      return;
    case "/plan":
      if (chat.active_project === undefined) {
        await ctx.tg.sendMessage(chatId, "No active project — /projects first.");
        return;
      }
      await sendPlan(ctx, chatId, chat.active_project);
      return;
    case "/cancel":
      if (chat.active_project === undefined) {
        await ctx.tg.sendMessage(chatId, "No active project — /projects first.");
        return;
      }
      await ctx.tg.sendMessage(chatId, "Cancel the active task?", {
        reply_markup: { inline_keyboard: cancelConfirmKeyboard() },
      });
      return;
    default:
      await ctx.tg.sendMessage(chatId, `Unknown command.\n\n${HELP_TEXT}`);
  }
}

// ----- callback dispatch ------------------------------------------------

async function handleCallback(ctx: BotContext, cq: TgCallbackQuery): Promise<void> {
  const userId = cq.from?.id;
  if (typeof userId !== "number" || !ctx.allowed.has(userId)) {
    ctx.log(`refused callback from user ${userId ?? "?"} (not allowlisted)`);
    await ctx.tg.answerCallback(cq.id, "Not authorized");
    return;
  }
  const chatId = cq.message?.chat?.id;
  if (typeof chatId !== "number") {
    await ctx.tg.answerCallback(cq.id);
    return;
  }
  try {
    await dispatchCallback(ctx, chatId, cq);
  } catch (err) {
    ctx.log(`callback failed: ${errMsg(err)}`);
  } finally {
    // Always ack so Telegram stops the button's spinner.
    await ctx.tg.answerCallback(cq.id);
  }
}

async function dispatchCallback(ctx: BotContext, chatId: number, cq: TgCallbackQuery): Promise<void> {
  const chat = getChat(ctx.state, chatId);
  const { action, arg } = parseCallback(cq.data);

  switch (action) {
    case "sp": {
      const idx = Number(arg);
      const picker = chat.picker ?? [];
      const projectId = Number.isInteger(idx) ? picker[idx] : undefined;
      if (projectId === undefined) {
        await ctx.tg.sendMessage(chatId, "That project list is stale — run /projects again.");
        return;
      }
      chat.active_project = projectId;
      persist(ctx);
      await ctx.tg.sendMessage(chatId, `Active project: ${projectId}\nSend a task, or /status.`);
      return;
    }
    case "cx": {
      const pending = chat.pending_task;
      if (pending === undefined) {
        await ctx.tg.sendMessage(chatId, "Nothing to submit — send a task first.");
        return;
      }
      const complexity = arg !== undefined && arg !== "auto" ? arg : undefined;
      const body: SubmitBody = {
        project: pending.project,
        task: pending.task,
        ...(complexity !== undefined ? { complexity } : {}),
        ...(pending.docker === true ? { docker: true } : {}),
      };
      delete chat.pending_task;
      persist(ctx);
      const r = await ctx.loom.submit(body);
      if (r.ok) {
        await ctx.tg.sendMessage(chatId, `✅ submitted ${r.data.task_id ?? "?"} [${r.data.status}]`);
      } else {
        await ctx.tg.sendMessage(chatId, replyError(r.code, r.message));
      }
      return;
    }
    case "dk": {
      if (chat.pending_task !== undefined) {
        chat.pending_task.docker = !(chat.pending_task.docker ?? false);
        persist(ctx);
      }
      const dockerOn = chat.pending_task?.docker ?? false;
      await ctx.tg.sendMessage(chatId, `Docker ${dockerOn ? "ON" : "OFF"} for the next submit. Pick complexity:`, {
        reply_markup: { inline_keyboard: complexityKeyboard({ dockerAvailable: true, dockerOn }) },
      });
      return;
    }
    case "ga": {
      await answerGate(ctx, chatId, chat, arg, { decision: "accept" }, "approved");
      return;
    }
    case "gx": {
      await answerGate(ctx, chatId, chat, arg, { decision: "reject", reject_intent: "abandon" }, "abandoned");
      return;
    }
    case "gr": {
      const project = chat.active_project;
      if (arg === undefined || project === undefined) {
        await ctx.tg.sendMessage(chatId, "No gate to reject.");
        return;
      }
      const mid = await ctx.tg.sendMessage(
        chatId,
        "Reject reason? Reply to this message with a one-line note.",
        { reply_markup: { force_reply: true, selective: true } },
      );
      if (mid !== null) {
        chat.awaiting_reason = { project, gate_event_id: arg, prompt_message_id: mid };
        persist(ctx);
      }
      return;
    }
    case "pl":
      if (chat.active_project !== undefined) await sendPlan(ctx, chatId, chat.active_project);
      return;
    case "st":
      if (chat.active_project !== undefined) await sendStatus(ctx, chatId, chat.active_project);
      return;
    case "pm":
      await ship(ctx, chatId, chat, "merge");
      return;
    case "pu":
      await ship(ctx, chatId, chat, "push");
      return;
    case "cn":
      await ctx.tg.sendMessage(chatId, "Cancel the active task?", {
        reply_markup: { inline_keyboard: cancelConfirmKeyboard() },
      });
      return;
    case "cy": {
      const project = chat.active_project;
      if (project === undefined) {
        await ctx.tg.sendMessage(chatId, "No active project.");
        return;
      }
      const r = await ctx.loom.cancel(project);
      await ctx.tg.sendMessage(chatId, r.ok ? "🛑 cancelled" : replyError(r.code, r.message));
      return;
    }
    case "cnx":
      await ctx.tg.sendMessage(chatId, "Ok — left it running.");
      return;
    default:
      ctx.log(`unknown callback action: ${action}`);
  }
}

// ----- shared actions ---------------------------------------------------

function answerReply(r: ApiResult<{ status: string }>, what: string): string {
  return r.ok ? `✅ gate ${what} [${r.data.status}]` : replyError(r.code, r.message);
}

async function answerGate(
  ctx: BotContext,
  chatId: number,
  chat: ChatState,
  gateEventId: string | undefined,
  decision: Omit<AnswerBody, "gate_event_id">,
  what: string,
): Promise<void> {
  const project = chat.active_project;
  if (gateEventId === undefined || project === undefined) {
    await ctx.tg.sendMessage(chatId, "No gate to answer.");
    return;
  }
  const r = await ctx.loom.answer(project, { gate_event_id: gateEventId, ...decision });
  await ctx.tg.sendMessage(chatId, answerReply(r, what));
}

async function sendPicker(ctx: BotContext, chatId: number, chat: ChatState): Promise<void> {
  const ws = await ctx.loom.listProjects();
  if (!ws.ok) {
    await ctx.tg.sendMessage(chatId, replyError(ws.code, ws.message));
    return;
  }
  const projects = ws.data.projects;
  if (projects.length === 0) {
    await ctx.tg.sendMessage(chatId, "No projects registered. Add one in the dashboard, or `loom serve --project <dir>`.");
    return;
  }
  chat.picker = projects.map((p) => p.id);
  persist(ctx);
  await ctx.tg.sendMessage(chatId, "Pick the active project:", {
    reply_markup: { inline_keyboard: pickerKeyboard(projects) },
  });
}

async function sendStatus(ctx: BotContext, chatId: number, project: string): Promise<void> {
  const p = await ctx.loom.getProject(project);
  if (!p.ok) {
    await ctx.tg.sendMessage(chatId, replyError(p.code, p.message));
    return;
  }
  const trace = await ctx.loom.getTrace(project);
  const title = projectTitle({ id: project, dir: p.data.dir });
  await ctx.tg.sendMessage(chatId, statusText(title, p.data.status, trace.ok ? trace.data : null, ctx.nowMs()));
}

async function sendPlan(ctx: BotContext, chatId: number, project: string): Promise<void> {
  let art = await ctx.loom.getArtifact(project, ".claude/plan.md");
  if (!art.ok) {
    // Fall back to whatever the bundle did write.
    const list = await ctx.loom.listArtifacts(project);
    if (list.ok && list.data.artifacts.length > 0) {
      const pick = list.data.artifacts.find((a) => a.path.endsWith("plan.md")) ?? list.data.artifacts[0];
      if (pick !== undefined) art = await ctx.loom.getArtifact(project, pick.path);
    }
  }
  if (!art.ok) {
    await ctx.tg.sendMessage(chatId, `📄 no plan yet (${art.code}).`);
    return;
  }
  const content = art.data.content.length > 0 ? art.data.content : "(empty plan)";
  if (content.length <= 4000) {
    await ctx.tg.sendMessage(chatId, content);
  } else {
    // Too long to chat-message — ship it as a document rather than dozens of
    // chunks (chunking stays for the bounded views).
    await ctx.tg.sendDocument(chatId, "plan.md", content, `Plan for ${project}${art.data.truncated ? " (truncated)" : ""}`);
  }
}

async function ship(ctx: BotContext, chatId: number, chat: ChatState, action: "push" | "merge"): Promise<void> {
  const project = chat.active_project;
  if (project === undefined) {
    await ctx.tg.sendMessage(chatId, "No active project.");
    return;
  }
  const r = action === "merge" ? await ctx.loom.merge(project) : await ctx.loom.push(project);
  // Honesty: a clean refusal (no remote / dirty tree / not a git repo) is a
  // readable reply, never a silent "done".
  await ctx.tg.sendMessage(chatId, r.ok ? shipResultText(action, r.data) : replyError(r.code, r.message));
}

// ----- read-model watch -------------------------------------------------

// One supervision sweep for a chat's active project: DM a newly-parked gate or a
// freshly-completed task with inline buttons, dedup'd so neither is sent twice.
export async function watchTick(ctx: BotContext, chatId: number, chat: ChatState): Promise<void> {
  const project = chat.active_project;
  if (project === undefined) return;
  const p = await ctx.loom.getProject(project);
  if (!p.ok) {
    ctx.log(`watch ${project}: ${p.code}`);
    return;
  }
  const status = p.data.status;
  const title = projectTitle({ id: project, dir: p.data.dir });

  if (status.parked_gate !== null) {
    const geid = status.parked_gate.gate_event_id;
    if (markGatePrompted(chat, geid)) {
      persist(ctx);
      await ctx.tg.sendMessage(chatId, gatePromptText(title, status.parked_gate), {
        reply_markup: { inline_keyboard: gateKeyboard(geid) },
      });
    }
  }

  if (status.status === "completed" || status.status === "abandoned") {
    const marker = `${status.status}:${status.task_id ?? "?"}`;
    if (markTerminalAnnounced(chat, project, marker)) {
      persist(ctx);
      const trace = await ctx.loom.getTrace(project);
      const summary = await ctx.loom.getArtifact(project, ".claude/summary.md");
      await ctx.tg.sendMessage(
        chatId,
        completionText(title, status, trace.ok ? trace.data : null, summary.ok ? summary.data.content : null, ctx.nowMs()),
        { reply_markup: { inline_keyboard: shipKeyboard() } },
      );
    }
  }
}

// ----- the long-running loops -------------------------------------------

export async function runTelegramBot(cfg: TelegramBotConfig, opts: TelegramBotOptions = {}): Promise<void> {
  const ctx = createBotContext(cfg, { ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}), log: opts.onLog ?? ((): void => {}) });
  const sleep = opts.sleep ?? defaultSleep;
  const pollTimeout = opts.poll_timeout_s ?? 25;
  const watchInterval = opts.watch_interval_ms ?? 4000;
  await Promise.all([
    telegramLoop(ctx, opts.signal, pollTimeout, sleep),
    watchLoop(ctx, opts.signal, watchInterval, sleep),
  ]);
}

async function telegramLoop(
  ctx: BotContext,
  signal: AbortSignal | undefined,
  pollTimeout: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  let offset = 0;
  let backoff = 1000;
  while (!isAborted(signal)) {
    let updates: TgUpdate[];
    try {
      updates = await ctx.tg.getUpdates(offset, pollTimeout);
      backoff = 1000;
    } catch (err) {
      ctx.log(`getUpdates failed: ${errMsg(err)}`);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      try {
        await handleUpdate(ctx, update);
      } catch (err) {
        ctx.log(`handle failed: ${errMsg(err)}`);
      }
    }
  }
}

async function watchLoop(
  ctx: BotContext,
  signal: AbortSignal | undefined,
  watchInterval: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  while (!isAborted(signal)) {
    for (const [key, chat] of Object.entries(ctx.state.chats)) {
      if (isAborted(signal)) break;
      const chatId = Number(key);
      if (!Number.isInteger(chatId)) continue;
      try {
        await watchTick(ctx, chatId, chat);
      } catch (err) {
        ctx.log(`watch failed: ${errMsg(err)}`);
      }
    }
    await sleep(watchInterval, signal);
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// `chunk` is part of the render surface; re-export it so the launcher / future
// callers can split long bounded replies without reaching into render.
export { chunk };
