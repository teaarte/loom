// Telegram Bot API client — node built-ins only (the Bot API is plain HTTPS, so
// no SDK and no runtime dependency, keeping @loomfsm/server dep-free). The
// `FetchLike` is injectable so the whole bot is driven by a fake in tests — no
// live Telegram, no network in CI. Domain-blind: it sends the text + buttons it
// is handed, never an interpretation of what a flow meant.
//
// Transport shape: the bot LONG-POLLS `getUpdates` (outbound only). There is no
// webhook, so the loom control plane it drives stays loopback-bound — no inbound
// port, no public ingress.

import type { FetchLike } from "./telegram.js";

// One inline button. `callback_data` is bounded at 64 bytes by the Bot API, so
// callers encode short action codes (see telegram-render).
export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];

// The reply markup we use: an inline-button grid, or a force-reply prompt (used
// to collect a one-line gate-rejection reason as the next message).
export type ReplyMarkup =
  | { inline_keyboard: InlineKeyboard }
  | { force_reply: true; selective?: boolean };

export interface TgFrom {
  id: number;
}
export interface TgMessage {
  message_id: number;
  chat?: { id?: number };
  from?: TgFrom;
  text?: string;
  // Present when this message replies to another — used to bind the answer to a
  // force-reply rejection-reason prompt.
  reply_to_message?: { message_id?: number };
}
export interface TgCallbackQuery {
  id: string;
  from?: TgFrom;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TelegramApi {
  getUpdates(offset: number, timeoutS: number): Promise<TgUpdate[]>;
  // Returns the sent message_id (needed to bind a force-reply), or null.
  sendMessage(chatId: number, text: string, opts?: { reply_markup?: ReplyMarkup }): Promise<number | null>;
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  sendDocument(chatId: number, filename: string, content: string, caption?: string): Promise<void>;
}

const API_BASE = "https://api.telegram.org";
const DOC_BOUNDARY = "----loomBotMultipartBoundaryX9f2";

export function makeTelegramApi(fetchImpl: FetchLike, botToken: string): TelegramApi {
  const url = (method: string): string => `${API_BASE}/bot${botToken}/${method}`;

  const postJson = async (method: string, body: unknown): Promise<unknown> => {
    const res = await fetchImpl(url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    try {
      return raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  const sendMessage: TelegramApi["sendMessage"] = async (chatId, text, opts = {}) => {
    const body = await postJson("sendMessage", {
      chat_id: chatId,
      text,
      ...(opts.reply_markup !== undefined ? { reply_markup: opts.reply_markup } : {}),
    });
    const result = (body as { result?: { message_id?: number } } | null)?.result;
    return typeof result?.message_id === "number" ? result.message_id : null;
  };

  const sendDocument: TelegramApi["sendDocument"] = async (chatId, filename, content, caption) => {
    // A long artifact ships as a `.md` document rather than dozens of chunked
    // messages. multipart/form-data is built by hand (no form-data dep); the body
    // is a UTF-8 string, which is sufficient for text artifacts. If the content
    // happened to contain the boundary, fall back to a single truncated message.
    if (content.includes(DOC_BOUNDARY)) {
      await sendMessage(chatId, `${caption ?? ""}\n\n${content}`.slice(0, 4000));
      return;
    }
    const parts: string[] = [];
    const field = (name: string, value: string): void => {
      parts.push(`--${DOC_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    };
    field("chat_id", String(chatId));
    if (caption !== undefined) field("caption", caption.slice(0, 1024));
    parts.push(
      `--${DOC_BOUNDARY}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        `Content-Type: text/markdown\r\n\r\n${content}\r\n`,
    );
    parts.push(`--${DOC_BOUNDARY}--\r\n`);
    await fetchImpl(url("sendDocument"), {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${DOC_BOUNDARY}` },
      body: parts.join(""),
    });
  };

  return {
    async getUpdates(offset, timeoutS) {
      // Long-poll: blocks up to `timeoutS` for a new update. `allowed_updates`
      // scopes the stream to what the bot acts on — messages and button taps.
      const allowed = encodeURIComponent(JSON.stringify(["message", "callback_query"]));
      const res = await fetchImpl(
        `${url("getUpdates")}?timeout=${timeoutS}&offset=${offset}&allowed_updates=${allowed}`,
      );
      const body = JSON.parse(await res.text()) as { result?: TgUpdate[] };
      return Array.isArray(body.result) ? body.result : [];
    },
    sendMessage,
    async answerCallback(callbackQueryId, text) {
      await postJson("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text !== undefined ? { text } : {}),
      });
    },
    sendDocument,
  };
}
