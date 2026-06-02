// A reference intake adapter — proof that intake is just a thin client of
// `POST /submit`, with NO knowledge of the domain and NO coupling to the
// control-plane core. A Telegram bot long-polls `getUpdates`, turns each
// message into a `submit`, and replies with the outcome. A Jira poller, an
// email watcher, or a web form would be the same shape against the same one
// endpoint.
//
// It is deliberately NOT re-exported from the package barrel: the control
// plane does not depend on it, and it does not depend on anything but `fetch`
// (injectable, so the test drives it with a fake — no live Telegram, no live
// server). The runnable wiring lives in `examples/telegram-intake.mjs`.

// A minimal structural `fetch` so the adapter stays dependency-free and the
// test injects a fake. Node's global `fetch` satisfies it at runtime.
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TelegramConfig {
  // Bot token for the Telegram Bot API.
  bot_token: string;
  // The loom control-plane base URL (e.g. http://127.0.0.1:4317).
  server_url: string;
  // The project (id or dir) every submitted task targets.
  project: string;
  // The control-plane bearer token, if it requires one.
  server_token?: string;
  // Optional policy preset applied to every submitted task.
  policy_preset?: string;
  fetchImpl: FetchLike;
}

// The shape of one Telegram update we care about (message text + chat id).
export interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id?: number }; text?: string };
}

export interface ParsedMessage {
  chat_id: number;
  text: string;
}

// Pull the chat id + a non-empty task text out of an update, or null when the
// update carries nothing actionable (a non-text message, an empty body).
export function parseUpdate(update: TelegramUpdate): ParsedMessage | null {
  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();
  if (typeof chatId !== "number" || text === undefined || text.length === 0) return null;
  return { chat_id: chatId, text };
}

// Submit one parsed message as a task and return the human reply string. A
// control-plane refusal (unknown project, task already active) becomes a
// readable reply rather than a thrown error — intake should never crash on a
// bad message.
export async function submitFromTelegram(
  cfg: TelegramConfig,
  msg: ParsedMessage,
): Promise<string> {
  const res = await cfg.fetchImpl(`${cfg.server_url}/submit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.server_token !== undefined ? { authorization: `Bearer ${cfg.server_token}` } : {}),
    },
    body: JSON.stringify({
      project: cfg.project,
      task: msg.text,
      ...(cfg.policy_preset !== undefined ? { policy_preset: cfg.policy_preset } : {}),
    }),
  });
  const raw = await res.text();
  let data: { task_id?: unknown; status?: unknown; error?: { code?: unknown; message?: unknown } } = {};
  try {
    data = raw.length > 0 ? (JSON.parse(raw) as typeof data) : {};
  } catch {
    /* fall through to a generic reply */
  }
  if (!res.ok) {
    const code = data.error?.code ?? `HTTP ${res.status}`;
    const message = data.error?.message ?? "submit failed";
    return `⚠️ ${String(code)}: ${String(message)}`;
  }
  return `✅ submitted ${String(data.task_id ?? "?")} [${String(data.status ?? "?")}]`;
}

// Send a reply back into a Telegram chat.
export async function sendReply(cfg: TelegramConfig, chatId: number, text: string): Promise<void> {
  await cfg.fetchImpl(`https://api.telegram.org/bot${cfg.bot_token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// Long-poll `getUpdates` and submit each message, until `signal` aborts. The
// offset advances past every consumed update so a restart does not re-handle
// old messages. Network blips are swallowed (a transient getUpdates failure
// just retries on the next loop) — intake is best-effort, the store is the
// authority.
export async function runTelegramIntake(
  cfg: TelegramConfig,
  opts: { signal?: AbortSignal; poll_timeout_s?: number; onLog?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.onLog ?? ((): void => {});
  const timeout = opts.poll_timeout_s ?? 25;
  let offset = 0;
  while (opts.signal?.aborted !== true) {
    let updates: TelegramUpdate[] = [];
    try {
      const res = await cfg.fetchImpl(
        `https://api.telegram.org/bot${cfg.bot_token}/getUpdates?timeout=${timeout}&offset=${offset}`,
      );
      const body = JSON.parse(await res.text()) as { result?: TelegramUpdate[] };
      updates = Array.isArray(body.result) ? body.result : [];
    } catch (err) {
      log(`getUpdates failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const msg = parseUpdate(update);
      if (msg === null) continue;
      try {
        const reply = await submitFromTelegram(cfg, msg);
        await sendReply(cfg, msg.chat_id, reply);
        log(`submitted from chat ${msg.chat_id}: ${reply}`);
      } catch (err) {
        log(`submit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
