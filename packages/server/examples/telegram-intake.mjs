// Runnable Telegram intake adapter — proof that "task from my phone" is just a
// thin client of `POST /submit`. It does NOT touch the control-plane core; it
// only speaks HTTP to it.
//
// This is an example, not part of the published package. Build the package
// first (`pnpm --filter @loomfsm/server build`), start a control plane
// (`loom serve --project <dir> --token <t>`), then run:
//
//   TELEGRAM_BOT_TOKEN=123:abc \
//   LOOM_SERVER_URL=http://127.0.0.1:4317 \
//   LOOM_SERVER_TOKEN=<t> \
//   LOOM_PROJECT=<project-id-or-dir> \
//   node packages/server/examples/telegram-intake.mjs
//
// Every text message sent to the bot becomes a loom task in that project; the
// bot replies with the task id + first directive (or a typed refusal).

import { runTelegramIntake } from "../dist/src/intake/telegram.js";

const required = (name) => {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`telegram-intake: ${name} is required\n`);
    process.exit(1);
  }
  return v;
};

const cfg = {
  bot_token: required("TELEGRAM_BOT_TOKEN"),
  server_url: process.env.LOOM_SERVER_URL ?? "http://127.0.0.1:4317",
  project: required("LOOM_PROJECT"),
  ...(process.env.LOOM_SERVER_TOKEN ? { server_token: process.env.LOOM_SERVER_TOKEN } : {}),
  ...(process.env.LOOM_POLICY_PRESET ? { policy_preset: process.env.LOOM_POLICY_PRESET } : {}),
  fetchImpl: globalThis.fetch,
};

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

process.stdout.write(`telegram-intake: polling → ${cfg.server_url} (project ${cfg.project})\n`);
await runTelegramIntake(cfg, {
  signal: controller.signal,
  onLog: (line) => process.stdout.write(`telegram-intake: ${line}\n`),
});
process.stdout.write("telegram-intake: stopped\n");
