// Read the tail of a project's daemon audit log for the dashboard's live log
// view. The supervisor's `createFileLogger` appends one JSON object per line
// to `<projectDir>/.claude/daemon/log.jsonl`; this reads the last `n` lines
// back as parsed events. A project with no log yet (an in-memory logger, or a
// just-registered project) reads as an empty tail — never an error.
//
// Transport-only file IO, outside the kernel's replay graph.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LogLine {
  ts?: string;
  level?: string;
  event?: string;
  detail?: Record<string, unknown>;
}

export function daemonLogPath(projectDir: string): string {
  return join(projectDir, ".claude", "daemon", "log.jsonl");
}

export function readLogTail(projectDir: string, n: number): LogLine[] {
  const path = daemonLogPath(projectDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const tail = lines.slice(Math.max(0, lines.length - n));
  const out: LogLine[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as LogLine);
    } catch {
      /* skip a torn final line */
    }
  }
  return out;
}
