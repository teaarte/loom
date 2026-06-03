// Outbound-notify config, read from the environment and shared by `loom daemon`
// (single project) and `loom serve` (fleet-wide). Mirrors `lib/resilience.ts`:
// env over flags (the daemon's argv parser is boolean-only), matching the
// established `LOOM_*` posture.
//
// Every channel is OFF until its URL/token is set — no config means
// `nullNotifier` and zero overhead. A channel that IS configured is composed
// into a best-effort fan-out filtered by the event allowlist
// (`LOOM_NOTIFY_EVENTS`, default complete/parked/failed).
//
//   LOOM_NOTIFY_WEBHOOK_URL     generic JSON POST of the whole event
//   LOOM_NOTIFY_SLACK_URL       Slack incoming-webhook ({text})
//   LOOM_NOTIFY_TELEGRAM_TOKEN  Telegram bot token  (needs _CHAT too)
//   LOOM_NOTIFY_TELEGRAM_CHAT   Telegram chat id
//   LOOM_NOTIFY_SCRIPT          path to a hook script (event JSON on stdin + env)
//   LOOM_NOTIFY_EVENTS          csv allowlist (default: complete,parked,failed)
//   LOOM_NOTIFY_TIMEOUT_MS      per-delivery timeout for the HTTP/script channels
//
// `@loomfsm/daemon` (which owns the notify channels) is a LAZY dependency: the
// value imports live behind a dynamic `import()` inside `resolveNotifier`, so a
// base `loom` install that never runs `daemon`/`serve` does not need it on disk
// — the same posture the command handlers take for daemon/server.

import { parseDurationMs } from "./resilience.js";
import type { Notifier, NotifyEventName } from "@loomfsm/daemon";

// The CLI-owned default allowlist (kept local so this module stays free of a
// static `@loomfsm/daemon` value import). The three signals a walk-away
// operator must learn about.
const DEFAULT_EVENTS: readonly NotifyEventName[] = ["complete", "parked", "failed"];

const ALL_EVENTS: readonly NotifyEventName[] = [
  "complete",
  "parked",
  "failed",
  "rate-limit-wait",
  "watch-park",
  "retry",
];

// Parse the `LOOM_NOTIFY_EVENTS` csv allowlist: trims, drops unknown tokens,
// and falls back to the default set when unset/blank/all-invalid.
export function parseNotifyEvents(raw: string | undefined): NotifyEventName[] {
  if (raw === undefined) return [...DEFAULT_EVENTS];
  const wanted = raw
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .filter((x): x is NotifyEventName => (ALL_EVENTS as readonly string[]).includes(x));
  return wanted.length > 0 ? wanted : [...DEFAULT_EVENTS];
}

// Build the notifier from the environment. Returns the `nullNotifier` singleton
// when no channel is configured — callers can identity-check it to skip wiring.
// `onError` receives a swallowed channel failure (best-effort). Async because
// the channel constructors are loaded lazily.
export async function resolveNotifier(
  env: NodeJS.ProcessEnv,
  onError?: (message: string) => void,
): Promise<Notifier> {
  const {
    filterEvents,
    multiNotifier,
    nullNotifier,
    scriptNotifier,
    slackNotifier,
    telegramNotifier,
    webhookNotifier,
  } = await import("@loomfsm/daemon");

  const timeout = parseDurationMs(env["LOOM_NOTIFY_TIMEOUT_MS"]);
  const timeoutOpt = timeout !== undefined && timeout > 0 ? { timeout_ms: timeout } : {};
  const onErrorOpt = onError !== undefined ? { onError } : {};

  const channels: Notifier[] = [];

  const webhook = env["LOOM_NOTIFY_WEBHOOK_URL"];
  if (webhook !== undefined && webhook.length > 0) {
    channels.push(webhookNotifier({ url: webhook, ...timeoutOpt, ...onErrorOpt }));
  }

  const slack = env["LOOM_NOTIFY_SLACK_URL"];
  if (slack !== undefined && slack.length > 0) {
    channels.push(slackNotifier({ url: slack, ...timeoutOpt, ...onErrorOpt }));
  }

  const tgToken = env["LOOM_NOTIFY_TELEGRAM_TOKEN"];
  const tgChat = env["LOOM_NOTIFY_TELEGRAM_CHAT"];
  if (tgToken !== undefined && tgToken.length > 0 && tgChat !== undefined && tgChat.length > 0) {
    channels.push(telegramNotifier({ token: tgToken, chat_id: tgChat, ...timeoutOpt, ...onErrorOpt }));
  }

  const script = env["LOOM_NOTIFY_SCRIPT"];
  if (script !== undefined && script.length > 0) {
    channels.push(scriptNotifier({ command: script, ...timeoutOpt, ...onErrorOpt }));
  }

  if (channels.length === 0) return nullNotifier;
  return filterEvents(multiNotifier(channels), parseNotifyEvents(env["LOOM_NOTIFY_EVENTS"]));
}
