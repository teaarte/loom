// The public surface of the interactive chat bot — the entry the CLI launcher
// (`loom bot telegram`) imports via the `@loomfsm/server/bot` subpath. Kept thin
// and separate from the `.` barrel so the control plane never depends on the bot
// (intake is a client of the control plane, not part of it).

export { runTelegramBot } from "./telegram-bot.js";
export type { TelegramBotConfig, TelegramBotOptions } from "./telegram-bot.js";
