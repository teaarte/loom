// The supervisor's audit sink. D2 wired the sandboxed executor's `onNotice`
// to a drop — E1 gives it a real home: a structured event log so a
// degraded-mode / no-isolation warning and the supervisor's own lifecycle
// (driving, parking, waking, retrying, recovering) are visible after the
// fact, not lost.
//
// The default writes one JSON object per line to `.loom/daemon/log.jsonl`
// AND a terse human line to stderr, so an operator watching the terminal and
// a later forensic read both work. It is injectable — a test captures events
// in memory; a deployment can route them elsewhere.
//
// Transport runtime: the timestamp is an ambient-clock reading (via the
// injected `Clock`), outside the kernel's replay graph.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { projectFootprintDir } from "@loomfsm/kernel";

import { type Clock, isoFrom, systemClock } from "./clock.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  detail?: Record<string, unknown>;
}

export interface DaemonLogger {
  info(event: string, detail?: Record<string, unknown>): void;
  warn(event: string, detail?: Record<string, unknown>): void;
  error(event: string, detail?: Record<string, unknown>): void;
}

export interface FileLoggerOptions {
  clock?: Clock;
  // Where the JSONL log is appended. Default `<projectDir>/.loom/daemon/log.jsonl`.
  logPath?: string;
  // Mirror a human line to this sink (default `process.stderr.write`). Pass a
  // no-op to silence the terminal and keep only the JSONL trail.
  echo?: (line: string) => void;
}

// Build the default logger for a project: JSONL trail under `.loom/daemon/`
// plus a one-line stderr echo.
export function createFileLogger(projectDir: string, opts: FileLoggerOptions = {}): DaemonLogger {
  const clock = opts.clock ?? systemClock;
  const daemonDir = join(projectFootprintDir(projectDir), "daemon");
  const logPath = opts.logPath ?? join(daemonDir, "log.jsonl");
  const echo = opts.echo ?? ((line: string) => void process.stderr.write(line));
  let dirReady = false;

  const emit = (level: LogLevel, event: string, detail?: Record<string, unknown>): void => {
    const entry: LogEvent = {
      ts: isoFrom(clock),
      level,
      event,
      ...(detail !== undefined ? { detail } : {}),
    };
    try {
      if (!dirReady) {
        mkdirSync(daemonDir, { recursive: true });
        dirReady = true;
      }
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // A log-write failure must never take the supervisor down; the stderr
      // echo below still surfaces the event.
    }
    echo(`loom daemon [${level}] ${event}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}\n`);
  };

  return {
    info: (event, detail) => emit("info", event, detail),
    warn: (event, detail) => emit("warn", event, detail),
    error: (event, detail) => emit("error", event, detail),
  };
}

// A no-op logger for tests/embedding that want silence.
export const nullLogger: DaemonLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// An in-memory logger — tests assert on the captured event stream.
export function createMemoryLogger(): DaemonLogger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const push = (level: LogLevel, event: string, detail?: Record<string, unknown>): void => {
    events.push({ ts: "", level, event, ...(detail !== undefined ? { detail } : {}) });
  };
  return {
    events,
    info: (event, detail) => push("info", event, detail),
    warn: (event, detail) => push("warn", event, detail),
    error: (event, detail) => push("error", event, detail),
  };
}
