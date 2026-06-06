// Per-chat bot state — a tiny JSON sidecar, written atomically (tmp + rename) so
// a crash never leaves a half-written file. It holds only what the read-model
// CANNOT re-derive: which project a chat's free-text task targets (a session
// choice), the gate-prompt dedup cursor (so a restart does not re-DM a gate
// already shown), and the last terminal status announced (so a finished task is
// announced once). The control plane stays the authority for live state; this is
// reconciled against it by the first watch sweep after boot. Single operator +
// allowlist, so a flat per-chat map is enough.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A task typed but awaiting a complexity / docker choice before it is submitted.
export interface PendingTask {
  project: string;
  task: string;
  docker?: boolean;
}

// A force-reply rejection-reason prompt in flight: the next reply to
// `prompt_message_id` becomes the gate's revise note.
export interface AwaitingReason {
  project: string;
  gate_event_id: string;
  prompt_message_id: number;
}

export interface ChatState {
  active_project?: string;
  // gate_event_ids already DM'd to this chat — the dedup cursor (bounded).
  prompted_gates: string[];
  // projectId -> the terminal marker (`<status>:<task_id>`) already announced.
  announced_terminal: Record<string, string>;
  // The project ids shown in the last picker, indexed by the select callback.
  picker?: string[];
  pending_task?: PendingTask;
  awaiting_reason?: AwaitingReason;
}

export interface BotState {
  chats: Record<string, ChatState>;
}

export function emptyState(): BotState {
  return { chats: {} };
}

// Fetch (creating if absent) the mutable state for one chat.
export function getChat(state: BotState, chatId: number): ChatState {
  const key = String(chatId);
  const existing = state.chats[key];
  if (existing !== undefined) return existing;
  const fresh: ChatState = { prompted_gates: [], announced_terminal: {} };
  state.chats[key] = fresh;
  return fresh;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Load + normalize the sidecar. A missing or corrupt file degrades to an empty
// state — the read-model reconciles live state on the next sweep, so starting
// fresh is never wrong, only forgetful of the session's active-project choice.
export function loadState(path: string): BotState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyState();
  }
  if (!isRecord(parsed) || !isRecord(parsed["chats"])) return emptyState();
  const chats: Record<string, ChatState> = {};
  for (const [k, raw] of Object.entries(parsed["chats"])) {
    if (!isRecord(raw)) continue;
    const chat: ChatState = {
      prompted_gates: Array.isArray(raw["prompted_gates"])
        ? raw["prompted_gates"].filter((x): x is string => typeof x === "string")
        : [],
      announced_terminal: isRecord(raw["announced_terminal"])
        ? (raw["announced_terminal"] as Record<string, string>)
        : {},
    };
    if (typeof raw["active_project"] === "string") chat.active_project = raw["active_project"];
    if (Array.isArray(raw["picker"])) {
      chat.picker = raw["picker"].filter((x): x is string => typeof x === "string");
    }
    const pt = raw["pending_task"];
    if (isRecord(pt) && typeof pt["project"] === "string" && typeof pt["task"] === "string") {
      chat.pending_task = {
        project: pt["project"],
        task: pt["task"],
        ...(typeof pt["docker"] === "boolean" ? { docker: pt["docker"] } : {}),
      };
    }
    const ar = raw["awaiting_reason"];
    if (
      isRecord(ar) &&
      typeof ar["project"] === "string" &&
      typeof ar["gate_event_id"] === "string" &&
      typeof ar["prompt_message_id"] === "number"
    ) {
      chat.awaiting_reason = {
        project: ar["project"],
        gate_event_id: ar["gate_event_id"],
        prompt_message_id: ar["prompt_message_id"],
      };
    }
    chats[k] = chat;
  }
  return { chats };
}

// Persist atomically. Best-effort — an unwritable home degrades to in-memory
// (the operator loses restart-safety, not correctness).
export function saveState(path: string, state: BotState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    /* best-effort persistence */
  }
}

// Record a gate as prompted; returns true only if it was NEW (so the caller
// should actually DM it). Bounds the cursor so it cannot grow without limit.
export function markGatePrompted(chat: ChatState, gateEventId: string): boolean {
  if (chat.prompted_gates.includes(gateEventId)) return false;
  chat.prompted_gates.push(gateEventId);
  const MAX = 200;
  if (chat.prompted_gates.length > MAX) {
    chat.prompted_gates.splice(0, chat.prompted_gates.length - MAX);
  }
  return true;
}

// Record a terminal announcement; returns true only if this marker is NEW for
// the project (so a completed task is announced exactly once).
export function markTerminalAnnounced(chat: ChatState, projectId: string, marker: string): boolean {
  if (chat.announced_terminal[projectId] === marker) return false;
  chat.announced_terminal[projectId] = marker;
  return true;
}
