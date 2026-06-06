// Per-spawn transcript sidecar — the record of WHAT a spawn was asked and WHAT
// it produced (the rendered prompt, the raw agent output, the structured parse,
// and the usage), written to a project-local file so an operator can read what
// they are about to approve at a gate, and diagnose a spawn that did nothing,
// without spelunking a backend's own session logs.
//
// NOT kernel state. The kernel models tokens, not agent prose, and storing raw
// agent output in the FSM store is an ADR-gated temptation that is deliberately
// avoided (executor-usage-capture-no-kernel-persist) — this is a plain file at
// the SAME capture boundary the usage sink fires at.
//
// It is written to the HOST project's `.loom/transcripts/`, NOT the sandbox
// copy: a fresh sandbox copy has loom's `.loom/` state stripped by
// `cleanLoomArtifacts`, so a sandbox-side write would be cleaned out from under
// the next task. The host sidecar survives the sandbox discard, so the server
// reads it consistently for a live task and an archived one alike.
//
// Ambient I/O is fine here — this is transport runtime outside the kernel's
// replay graph, the same posture `readState` / the audit log take.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { projectFootprintDir } from "@loomfsm/kernel";

import type { SpawnUsage } from "./drive.js";

// One spawn's transcript. `agent` / `phase` / `model` are opaque DATA off the
// kernel's shuttle intent; `raw_output` is the agent's text; `parse_result` is
// the executor's structured read of it (the self-diff file accounting); `usage`
// is the per-spawn token/cost accounting when the backend surfaced it.
export interface SpawnTranscript {
  agent: string;
  agent_run_id: string;
  phase: string;
  model: string | null;
  prompt: string;
  raw_output: string;
  parse_result: {
    files_modified?: string[];
    files_created?: string[];
  };
  usage?: SpawnUsage;
  // ISO-8601 of when the transcript was written (end-of-spawn). Minted by the
  // caller from the kernel's NowToken capture, threaded in.
  recorded_at: string;
}

const TRANSCRIPTS_DIRNAME = "transcripts";

// Cap the prompt + output independently so one runaway spawn cannot bloat the
// sidecar — a transcript is for reading, not for byte-exact replay.
const MAX_FIELD_CHARS = 100_000;

// `<project>/.loom/transcripts` — the HOST sidecar dir (NOT the sandbox copy).
// Exported so a transport (the server's read route) locates it the same way for
// both the live and the archived path.
export function spawnTranscriptDir(projectDir: string): string {
  return join(projectFootprintDir(projectDir), TRANSCRIPTS_DIRNAME);
}

// The per-spawn file path, keyed by the kernel's `agent_run_id` (unique per
// logical spawn; a resume re-shuttle reuses it, so a re-run overwrites in place).
export function spawnTranscriptPath(projectDir: string, agentRunId: string): string {
  return join(spawnTranscriptDir(projectDir), `${safeId(agentRunId)}.json`);
}

// `agent_run_id` is server-minted (uuid-shaped), but keep the filename strict
// regardless: a single segment, no separators / dot-dot, so it can never join
// outside the transcripts dir.
function safeId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, "-");
  return s.length > 0 ? s : "spawn";
}

function clamp(s: string): string {
  if (s.length <= MAX_FIELD_CHARS) return s;
  return `${s.slice(0, MAX_FIELD_CHARS)}\n…[${s.length - MAX_FIELD_CHARS} chars truncated]…`;
}

// Write one spawn's transcript. Best-effort: a transcript is observability, never
// a failure path, so a write error is swallowed and can never break the drive.
// On first write it drops a self-ignoring `.gitignore` (`*`) into the dir so the
// transcripts never reach the operator's VCS regardless of their root ignore.
export function writeSpawnTranscript(projectDir: string, t: SpawnTranscript): void {
  try {
    const dir = spawnTranscriptDir(projectDir);
    mkdirSync(dir, { recursive: true });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n", "utf8");
    const record: SpawnTranscript = {
      ...t,
      prompt: clamp(t.prompt),
      raw_output: clamp(t.raw_output),
    };
    writeFileSync(spawnTranscriptPath(projectDir, t.agent_run_id), JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* observability is best-effort; never break the drive on a write error */
  }
}
