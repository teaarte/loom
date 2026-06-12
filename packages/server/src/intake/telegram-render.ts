// Pure render helpers for the bot — keyboards, the callback_data codec, and the
// text views (gate prompt, status, completion summary, ship result). Every
// function here is pure (input -> string / keyboard) so it is unit-tested
// without a network, and DOMAIN-BLIND: it prints the gate name, phase, agent,
// model, and verdict the read-model carries as DATA — never an interpretation of
// what a code/spec/legal flow meant. The bot hard-codes no agent, tier, or
// bundle name.

import { basename } from "node:path";

import type { InlineKeyboard } from "./telegram-api.js";
import type { ProjectStatusView } from "../read-model.js";
import type { ShipWire, TraceWire } from "./loom-client.js";

// ----- callback_data codec ----------------------------------------------
// The Bot API bounds callback_data at 64 bytes, so a tap carries a short action
// code plus at most one argument. The project a tap concerns is the chat's
// active project (the bot watches one project per chat), so only the
// gate_event_id (`gev-<uuid>`, ~40 bytes) or a picker index ever travels inline.

export type CallbackAction =
  | "sp" // select project (arg: picker index)
  | "cx" // complexity chosen -> submit (arg: complexity value)
  | "dk" // toggle docker for the pending submit
  | "ga" // gate: approve (arg: gate_event_id)
  | "gr" // gate: reject + revise (arg: gate_event_id) -> force-reply for a reason
  | "gx" // gate: abandon (arg: gate_event_id)
  | "pl" // plan
  | "st" // status
  | "pm" // squash-merge to checkout
  | "pu" // push branch
  | "cn" // cancel (ask to confirm)
  | "cy" // cancel: confirmed
  | "cnx"; // cancel: dismissed

export function encodeCallback(action: CallbackAction, arg?: string): string {
  return arg !== undefined ? `${action}|${arg}` : action;
}

export function parseCallback(data: string | undefined): { action: string; arg?: string } {
  if (data === undefined || data.length === 0) return { action: "" };
  const i = data.indexOf("|");
  if (i < 0) return { action: data };
  return { action: data.slice(0, i), arg: data.slice(i + 1) };
}

// ----- titles -----------------------------------------------------------

export function projectTitle(p: { id: string; label?: string; dir: string }): string {
  if (p.label !== undefined && p.label.length > 0) return p.label;
  const base = basename(p.dir);
  return base.length > 0 ? base : p.id;
}

// ----- keyboards --------------------------------------------------------

export function gateKeyboard(gateEventId: string): InlineKeyboard {
  return [
    [
      { text: "✅ Approve", callback_data: encodeCallback("ga", gateEventId) },
      { text: "✏️ Reject", callback_data: encodeCallback("gr", gateEventId) },
    ],
    [{ text: "🗑 Abandon", callback_data: encodeCallback("gx", gateEventId) }],
    [
      { text: "📄 Plan", callback_data: encodeCallback("pl") },
      { text: "ℹ️ Status", callback_data: encodeCallback("st") },
    ],
  ];
}

// The generic create-arg complexity row. These values are FSM / create-args
// vocabulary, NOT domain names — `auto` means "let the classifier decide" (the
// bot omits `complexity` so the bundle picks).
export const COMPLEXITY_VALUES = ["trivial", "simple", "medium", "complex", "question"] as const;

export function complexityKeyboard(opts: { dockerAvailable: boolean; dockerOn: boolean }): InlineKeyboard {
  const rows: InlineKeyboard = [
    [
      { text: "🤖 Auto", callback_data: encodeCallback("cx", "auto") },
      { text: "⚡ Trivial", callback_data: encodeCallback("cx", "trivial") },
    ],
    [
      { text: "Simple", callback_data: encodeCallback("cx", "simple") },
      { text: "Medium", callback_data: encodeCallback("cx", "medium") },
      { text: "Complex", callback_data: encodeCallback("cx", "complex") },
    ],
  ];
  if (opts.dockerAvailable) {
    rows.push([
      { text: opts.dockerOn ? "🐳 Docker: on" : "🐳 Docker: off", callback_data: encodeCallback("dk") },
    ]);
  }
  return rows;
}

export function pickerKeyboard(projects: { id: string; label?: string; dir: string }[]): InlineKeyboard {
  return projects.map((p, i) => [{ text: projectTitle(p), callback_data: encodeCallback("sp", String(i)) }]);
}

export function shipKeyboard(): InlineKeyboard {
  return [
    [{ text: "🚀 Squash-merge to checkout", callback_data: encodeCallback("pm") }],
    [{ text: "🔀 Push branch", callback_data: encodeCallback("pu") }],
    [{ text: "📄 Plan", callback_data: encodeCallback("pl") }],
  ];
}

export function cancelConfirmKeyboard(): InlineKeyboard {
  return [
    [
      { text: "Yes, cancel", callback_data: encodeCallback("cy") },
      { text: "No", callback_data: encodeCallback("cnx") },
    ],
  ];
}

// ----- text views -------------------------------------------------------

export function gatePromptText(title: string, gate: { gate: string; message: string }): string {
  return `⏸ ${title} — parked at gate «${gate.gate}»\n\n${gate.message}`;
}

// Elapsed wall-clock between two ISO bookends; `endISO === null` means still
// running, so measure to `nowMs`. Returns "?" on an unparseable start.
export function elapsed(startISO: string, endISO: string | null, nowMs: number): string {
  const start = Date.parse(startISO);
  if (Number.isNaN(start)) return "?";
  const end = endISO !== null ? Date.parse(endISO) : nowMs;
  const total = Math.max(0, Math.round((end - start) / 1000));
  const m = Math.floor(total / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${total % 60}s`;
  return `${total}s`;
}

export function statusText(
  title: string,
  status: ProjectStatusView,
  trace: TraceWire | null,
  nowMs: number,
): string {
  const lines: string[] = [`ℹ️ ${title}`];
  if (status.status !== null) {
    lines.push(`status: ${status.status}${status.verdict !== null ? ` (${status.verdict})` : ""}`);
  } else {
    lines.push("status: idle (no task)");
  }
  if (status.flow !== null) lines.push(`flow: ${status.flow.name} · step ${status.flow.step_index}`);
  if (status.active_phase !== null) lines.push(`phase: ${status.active_phase}`);
  if (status.started_at !== null) {
    lines.push(`elapsed: ${elapsed(status.started_at, status.ended_at, nowMs)}`);
  }
  if (status.pending_agents.length > 0) {
    lines.push(`pending: ${status.pending_agents.map((a) => `${a.agent}/${a.phase}`).join(", ")}`);
  }
  if (status.parked_gate !== null) lines.push(`⏸ awaiting gate: ${status.parked_gate.gate}`);
  const recent = trace?.agents.slice(-3) ?? [];
  if (recent.length > 0) {
    lines.push("recent:");
    for (const a of recent) {
      const tok = (a.tokens_in ?? 0) + (a.tokens_out ?? 0);
      const model = a.model !== null ? ` [${a.model}]` : "";
      const tokens = tok > 0 ? ` · ${tok} tok` : "";
      lines.push(`  · ${a.agent}/${a.phase}${model}${tokens}`);
    }
  }
  return lines.join("\n");
}

export function completionText(
  title: string,
  status: ProjectStatusView,
  trace: TraceWire | null,
  summaryArtifact: string | null,
  nowMs: number,
): string {
  const verdict = status.verdict ?? trace?.summary?.verdict ?? "?";
  const icon = verdict === "accepted" ? "✅" : verdict === "rejected" ? "🔸" : "⚠️";
  const lines: string[] = [`${icon} ${title} — ${status.status ?? "done"} (${verdict})`];

  const summary = (summaryArtifact ?? trace?.summary?.completion_summary ?? "").trim();
  if (summary.length > 0) {
    lines.push("", summary);
  } else {
    // Derived fallback when no completion summary was written: the last agents
    // that ran (names are DATA), so the chat still says "what happened".
    const recent = trace?.agents.slice(-4) ?? [];
    if (recent.length > 0) {
      lines.push("", "recent work:");
      for (const a of recent) lines.push(`  · ${a.agent}/${a.phase}`);
    }
  }
  if (status.started_at !== null) {
    lines.push("", `took ${elapsed(status.started_at, status.ended_at, nowMs)}`);
  }
  return lines.join("\n");
}

function shipReasonText(reason: string | undefined): string {
  switch (reason) {
    case "no-git":
      return "not a git repo";
    case "no-branch":
      return "no task branch (nothing to ship — no changes?)";
    case "no-remote":
      return "no remote configured";
    case "push-failed":
      return "git push failed";
    case "detached-head":
      return "detached HEAD";
    case "dirty-tree":
      return "working tree is dirty — commit or stash first";
    case "no-changes":
      return "no changes to merge";
    case "merge-conflict":
      return "merge conflict — reset to the pre-merge state";
    case "commit-failed":
      return "commit failed";
    default:
      return reason ?? "unknown reason";
  }
}

export function shipResultText(action: "push" | "merge", ship: ShipWire): string {
  if (action === "push") {
    if (ship.pushed === true) {
      return `🔀 pushed ${ship.branch ?? "branch"} → ${ship.remote ?? "remote"}`;
    }
    const detail = ship.detail !== undefined ? `\n${ship.detail}` : "";
    return `⚠️ not pushed${ship.branch !== undefined ? ` (${ship.branch})` : ""}: ${shipReasonText(ship.reason)}${detail}`;
  }
  if (ship.merged === true) {
    const files =
      ship.files_changed !== undefined && ship.files_changed.length > 0
        ? ` · ${ship.files_changed.length} file(s)`
        : "";
    return `🚀 squash-merged ${ship.branch ?? "branch"} → ${ship.into ?? "checkout"}${files}`;
  }
  const detail = ship.detail !== undefined ? `\n${ship.detail}` : "";
  return `⚠️ not merged${ship.into !== undefined ? ` into ${ship.into}` : ""}: ${shipReasonText(ship.reason)}${detail}`;
}

// Split a long body for Telegram's 4096-char message limit, preferring newline
// boundaries so a chunk does not slice mid-line.
export function chunk(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

export const HELP_TEXT = [
  "loom remote — drive your pipeline from chat.",
  "",
  "• /projects — pick the active project",
  "• send any text — submit it as a task to the active project",
  "• /status — status of the active project",
  "• /plan — the active project's plan",
  "• /cancel — cancel the active task",
  "",
  "Gates and completions are pushed to you with inline buttons.",
].join("\n");
