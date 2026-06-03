// The non-webhook notify channels — Slack and Telegram (HTTP, same best-effort
// POST as the webhook) and a custom script (a spawned process). Each is a thin
// shaper over the generic `NotifyEvent`: Slack and Telegram want a human text
// line, a script gets the raw JSON. All best-effort: a failure is swallowed
// into `onError`, never thrown.

import { spawn } from "node:child_process";

import {
  DEFAULT_NOTIFY_TIMEOUT_MS,
  postBestEffort,
  type FetchLike,
  type Notifier,
  type NotifyEvent,
} from "./notify.js";

// A one-line human rendering of the generic event for the text channels. Stays
// domain-blind — it prints the verdict / gate name / error code / branch the
// payload carries, never an interpretation of what the flow meant.
export function formatEventText(event: NotifyEvent): string {
  const id = event.task_id ?? "(no id)";
  const where = event.project_id !== undefined ? `${event.project_id}/${id}` : id;
  switch (event.event) {
    case "complete": {
      const branch = event.branch !== undefined ? ` → ${event.branch}` : "";
      return `✅ loom complete: ${where} — ${event.verdict ?? "?"}${branch}`;
    }
    case "parked": {
      const gate = event.gate !== undefined ? ` at gate "${event.gate}"` : "";
      const msg = event.message !== undefined ? ` — ${event.message}` : "";
      return `⏸️ loom parked: ${where}${gate}${msg} (resume to continue)`;
    }
    case "failed":
      return `❌ loom failed: ${where} [${event.code ?? "ERROR"}]${event.message !== undefined ? ` — ${event.message}` : ""}`;
    case "rate-limit-wait":
      return `⏳ loom rate-limit: ${where} [${event.code ?? "?"}]${event.message !== undefined ? ` — ${event.message}` : ""}`;
    case "watch-park":
      return `🅿️ loom watch parked: ${where} [${event.code ?? "?"}]${event.message !== undefined ? ` — ${event.message}` : ""}`;
    case "retry":
      return `🔁 loom retry: ${where} [${event.code ?? "?"}]${event.message !== undefined ? ` — ${event.message}` : ""}`;
  }
}

export interface SlackNotifierOptions {
  // The Slack incoming-webhook URL.
  url: string;
  fetchImpl?: FetchLike;
  timeout_ms?: number;
  onError?: (message: string) => void;
}

// Slack incoming webhook: POST `{ "text": "<line>" }` (the minimal documented
// payload — a single `text` field, `\n` for line breaks).
export function slackNotifier(opts: SlackNotifierOptions): Notifier {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const timeout = opts.timeout_ms ?? DEFAULT_NOTIFY_TIMEOUT_MS;
  return {
    notify: (event) =>
      postBestEffort(
        fetchImpl,
        opts.url,
        JSON.stringify({ text: formatEventText(event) }),
        timeout,
        "slack",
        opts.onError,
      ),
  };
}

export interface TelegramNotifierOptions {
  // Bot token for the Telegram Bot API.
  token: string;
  // The chat to send to (a numeric id or an @channel string).
  chat_id: string | number;
  fetchImpl?: FetchLike;
  timeout_ms?: number;
  onError?: (message: string) => void;
}

// Telegram Bot API `sendMessage`: POST `{ chat_id, text }` to
// `https://api.telegram.org/bot<token>/sendMessage` — the same shape the
// inbound intake adapter uses to reply.
export function telegramNotifier(opts: TelegramNotifierOptions): Notifier {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const timeout = opts.timeout_ms ?? DEFAULT_NOTIFY_TIMEOUT_MS;
  const url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
  return {
    notify: (event) =>
      postBestEffort(
        fetchImpl,
        url,
        JSON.stringify({ chat_id: opts.chat_id, text: formatEventText(event) }),
        timeout,
        "telegram",
        opts.onError,
      ),
  };
}

export interface ScriptNotifierOptions {
  // The command to spawn (a path to an executable hook script).
  command: string;
  // Extra argv for the command.
  args?: string[];
  timeout_ms?: number;
  onError?: (message: string) => void;
}

// A custom script channel: spawn `command` and hand it the event JSON on stdin
// AND in the `LOOM_NOTIFY_EVENT` env var (whichever the hook prefers to read).
// Best-effort with a kill-after-timeout; a spawn error / non-zero exit / timeout
// surfaces through `onError` and the promise still resolves — never throws.
export function scriptNotifier(opts: ScriptNotifierOptions): Notifier {
  const timeout = opts.timeout_ms ?? DEFAULT_NOTIFY_TIMEOUT_MS;
  return {
    notify: (event) =>
      new Promise<void>((resolve) => {
        const payload = JSON.stringify(event);
        let child;
        try {
          child = spawn(opts.command, opts.args ?? [], {
            stdio: ["pipe", "ignore", "ignore"],
            env: { ...process.env, LOOM_NOTIFY_EVENT: payload },
          });
        } catch (err) {
          opts.onError?.(`script: ${err instanceof Error ? err.message : String(err)}`);
          resolve();
          return;
        }

        // Resolve exactly once, reporting at most one failure — a failed spawn
        // can emit both `error` and `close`, and a timeout-kill emits `close`
        // after the timer; the first to land wins, the rest are no-ops.
        let settled = false;
        const finish = (errMsg?: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (errMsg !== undefined) opts.onError?.(errMsg);
          resolve();
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish("script: timeout");
        }, timeout);

        child.on("error", (err: Error) => finish(`script: ${err.message}`));
        child.on("close", (code: number | null) =>
          finish(code !== null && code !== 0 ? `script: exit ${code}` : undefined),
        );
        // Hand the payload over stdin; ignore an EPIPE if the hook never reads.
        child.stdin?.on("error", () => {});
        child.stdin?.end(payload);
      }),
  };
}

// Node's global fetch, adapted to `FetchLike` (a wrapper, not a cast).
const defaultFetch: FetchLike = (url, init) => fetch(url, init);
