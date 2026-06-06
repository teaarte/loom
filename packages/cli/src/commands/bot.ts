// `loom bot telegram` — the interactive Telegram remote control. A thin launcher
// that wires env -> config -> the long-poll loop in @loomfsm/server (pulled in
// via a dynamic import so the heavy transport stays out of the eager command
// graph, exactly as `loom serve` does). The bot is outbound-only (long-poll, no
// webhook), so the control plane it drives stays loopback-bound — no inbound
// port. The sender allowlist is the one auth surface: the bot can launch agents
// on your repos, so an un-listed Telegram user_id is refused.
//
//   bot telegram   Start the bot loop. Reads:
//       LOOM_TG_BOT_TOKEN      the @BotFather bot token (required)
//       LOOM_TG_ALLOWED_USERS  comma-separated Telegram user ids (required)
//       LOOM_SERVER_URL        control plane base URL (default 127.0.0.1:4317)
//       LOOM_SERVER_TOKEN      control-plane bearer, if it requires one

import { homedir } from "node:os";
import { resolve } from "node:path";

import { resolveLoomHome } from "@loomfsm/config";

import type { CliEnv } from "../lib/env.js";

export async function bot(argv: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "telegram") return await telegram(rest, env);
  env.err(`loom bot: expected 'telegram', got ${sub ?? "(nothing)"}`);
  env.err("usage: loom bot telegram");
  return 1;
}

async function telegram(_argv: string[], env: CliEnv): Promise<number> {
  const botToken = process.env["LOOM_TG_BOT_TOKEN"];
  if (botToken === undefined || botToken.length === 0) {
    env.err("loom bot telegram: LOOM_TG_BOT_TOKEN is required (create a bot with @BotFather)");
    return 1;
  }
  const allowed = parseAllowed(process.env["LOOM_TG_ALLOWED_USERS"]);
  if (allowed.length === 0) {
    env.err("loom bot telegram: LOOM_TG_ALLOWED_USERS is required (comma-separated Telegram user ids)");
    env.err("  tip: message the bot once and it replies with your id, or ask @userinfobot");
    return 1;
  }
  const serverUrl = process.env["LOOM_SERVER_URL"] ?? "http://127.0.0.1:4317";
  const serverToken = process.env["LOOM_SERVER_TOKEN"];
  const home = env.home.length > 0 ? env.home : homedir();
  const statePath = resolve(resolveLoomHome(process.env, home), "bot", "telegram.json");

  // Dynamic import keeps @loomfsm/server (and its heavy transitive graph) out of
  // the launcher's eager import chain — a bare `loom --version` never loads it.
  const { runTelegramBot } = await import("@loomfsm/server/bot");

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  env.out(`loom bot telegram: polling Telegram → control plane ${serverUrl}`);
  env.out(`  allowed users: ${allowed.length} · state: ${statePath}`);
  try {
    await runTelegramBot(
      {
        bot_token: botToken,
        allowed_users: allowed,
        server_url: serverUrl,
        ...(serverToken !== undefined && serverToken.length > 0 ? { server_token: serverToken } : {}),
        state_path: statePath,
        fetchImpl: (url, init) => fetch(url, init),
      },
      {
        signal: controller.signal,
        onLog: (line) => env.err(`loom bot telegram: ${line}`),
      },
    );
    env.out("loom bot telegram: stopped");
    return 0;
  } catch (err) {
    env.err(`loom bot telegram: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

// Parse the allowlist: comma-separated positive integer Telegram user ids.
function parseAllowed(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}
