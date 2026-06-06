// The observability read routes — the agent-chain trace, the archived-task
// browser, and the read-only artifact reader. They project what a task's STORE
// recorded (live or archived) and the prose documents the work agents wrote into
// the task sandbox, so an operator can answer "what ran, in what order, what did
// each produce, and why did a spawn fail" without spelunking the backend's own
// session transcripts.
//
// Domain-blind, like the read-model: the chain reader (`@loomfsm/driver`'s
// `readTrace`) returns only generic FSM columns — agent / gate / output-kind
// NAMES are DATA, never branched on; the control plane names no agent, tier, or
// bundle. The artifact reader serves files the agent wrote, whitelisted to
// `.claude/*.md` documents and traversal-guarded by the kernel's `resolveSafePath`
// (the same canonicalize-the-existing-ancestor guard the sandbox file tools use)
// so a read can never escape the sandbox.
//
// Transport-only file/store IO, outside the kernel's replay graph.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  clonePathFor,
  readTrace,
  readTraceFile,
  spawnTranscriptDir,
  worktreePathFor,
  type TraceView,
} from "@loomfsm/driver";
import { projectFootprintDir, resolveSafePath } from "@loomfsm/kernel";
import type { ServerResponse } from "node:http";

import { ServerError } from "./errors.js";
import { readTaskExecPrefs } from "./task-exec.js";

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// A finished task's filesystem-safe id: it names an archived store file
// `<id>.db` directly, so it must be a single path segment with no separators or
// dot-dot. Task ids are uuids; the archival fallback id is a dash-sanitized
// ISO stamp. Anything else is refused before it can be joined into a path.
const SAFE_ARCHIVE_ID = /^[A-Za-z0-9._-]+$/;

// A whitelisted prose artifact: a single `.md` document directly under the
// task's `.claude/` directory (e.g. a context doc, a plan, a hand-off). One
// path segment after `.claude/`, no separators or dot-dot — the canonical
// traversal guard below then confirms the resolved path stays in the sandbox.
const ARTIFACT_PATH = /^\.claude\/[^/\\]+\.md$/;

const HISTORY_DIRNAME = "history";
const MAX_ARTIFACT_BYTES = 512 * 1024;

// ----- GET /projects/:id/trace (live or ?task=<archived id>) -------------

// Project a task's recorded agent chain. With no `task` query the LIVE store is
// read; with `?task=<archived id>` the matching `<dir>/.loom/history/<id>.db`
// is read by the SAME domain-blind reader (same schema, rotated aside on finish).
export async function getTrace(
  res: ServerResponse,
  dir: string,
  archivedTaskId: string | null,
): Promise<void> {
  let trace: TraceView;
  if (archivedTaskId !== null) {
    if (!SAFE_ARCHIVE_ID.test(archivedTaskId)) {
      throw new ServerError("BAD_TASK_ID", 400, "the archived task id is not a valid identifier");
    }
    const dbPath = join(projectFootprintDir(dir), HISTORY_DIRNAME, `${archivedTaskId}.db`);
    if (!existsSync(dbPath)) {
      throw new ServerError("ARCHIVE_NOT_FOUND", 404, `no archived task ${archivedTaskId}`);
    }
    trace = await readTraceFile(dbPath);
  } else {
    trace = await readTrace(dir);
  }
  sendJson(res, 200, { archived: archivedTaskId !== null, ...trace });
}

// ----- GET /projects/:id/spawn/:run_id ------------------------------------

// Read ONE spawn's transcript sidecar (the prompt + raw output + structured
// parse + usage the driver wrote per spawn). The id must be a single path
// segment (no separators / dot-dot); `resolveSafePath` then canonicalizes it
// against the HOST transcripts dir and refuses anything that escapes — the same
// double guard the artifact reader stacks. The transcript lives at the HOST
// project (NOT the discarded sandbox), so a live OR an archived run resolves the
// same way. The body is returned verbatim (already shaped + size-capped at write
// time); a torn file yields `transcript: null` rather than a 500.
export async function getSpawnTranscript(res: ServerResponse, dir: string, runId: string): Promise<void> {
  if (!SAFE_ARCHIVE_ID.test(runId)) {
    throw new ServerError("BAD_RUN_ID", 400, "the spawn run id is not a valid identifier");
  }
  const root = spawnTranscriptDir(dir);
  if (!existsSync(root)) {
    throw new ServerError("TRANSCRIPT_NOT_FOUND", 404, `no transcript for ${runId}`);
  }
  const safe = await resolveSafePath(`${runId}.json`, root);
  if (!safe.ok) {
    throw new ServerError("BAD_RUN_ID", 400, `spawn run id refused: ${safe.reason}`);
  }
  if (!existsSync(safe.path)) {
    throw new ServerError("TRANSCRIPT_NOT_FOUND", 404, `no transcript for ${runId}`);
  }
  let raw: string;
  try {
    raw = readFileSync(safe.path, "utf8");
  } catch (err) {
    throw new ServerError("TRANSCRIPT_UNREADABLE", 500, err instanceof Error ? err.message : String(err));
  }
  let transcript: unknown = null;
  try {
    transcript = JSON.parse(raw);
  } catch {
    transcript = null; // a torn / partial write surfaces as "no parseable transcript"
  }
  sendJson(res, 200, { run_id: runId, transcript });
}

// ----- GET /projects/:id/history -----------------------------------------

interface IndexEntry {
  task_id?: unknown;
  task_short?: unknown;
  task?: unknown;
  verdict?: unknown;
  status?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  archived_at?: unknown;
  db_file?: unknown;
}

interface HistoryTask {
  task_id: string | null;
  db_file: string;
  task_short: string | null;
  task: string | null;
  status: string | null;
  verdict: string | null;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// List a project's archived (finished) tasks with a one-line summary each. The
// browsable summaries live in `history/index.jsonl` (written at archival); a
// `.db` snapshot present without an index line is peeked with the same reader so
// the list never silently drops a task the index missed.
export async function getHistory(res: ServerResponse, dir: string): Promise<void> {
  const historyDir = join(projectFootprintDir(dir), HISTORY_DIRNAME);
  if (!existsSync(historyDir)) {
    sendJson(res, 200, { tasks: [] });
    return;
  }

  // The authoritative summaries, keyed by their snapshot file.
  const byFile = new Map<string, HistoryTask>();
  const indexPath = join(historyDir, "index.jsonl");
  if (existsSync(indexPath)) {
    let raw = "";
    try {
      raw = readFileSync(indexPath, "utf8");
    } catch {
      raw = "";
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let e: IndexEntry;
      try {
        e = JSON.parse(line) as IndexEntry;
      } catch {
        continue; // a torn / malformed line never blocks the rest
      }
      const dbFile = s(e.db_file);
      if (dbFile === null) continue;
      byFile.set(dbFile, {
        task_id: s(e.task_id),
        db_file: dbFile,
        task_short: s(e.task_short),
        task: s(e.task),
        status: s(e.status),
        verdict: s(e.verdict),
        started_at: s(e.started_at),
        ended_at: s(e.ended_at),
        archived_at: s(e.archived_at),
      });
    }
  }

  // Every snapshot on disk, reconciled against the index. A file the index
  // missed is peeked for its summary so it still appears.
  let files: string[] = [];
  try {
    files = readdirSync(historyDir).filter((f) => f.endsWith(".db"));
  } catch {
    files = [];
  }
  const tasks: HistoryTask[] = [];
  for (const file of files) {
    const indexed = byFile.get(file);
    if (indexed !== undefined) {
      tasks.push(indexed);
      continue;
    }
    let summary: TraceView["summary"] = null;
    try {
      summary = (await readTraceFile(join(historyDir, file))).summary;
    } catch {
      summary = null;
    }
    tasks.push({
      task_id: summary?.task_id ?? null,
      db_file: file,
      task_short: null,
      task: summary?.task ?? null,
      status: summary?.status ?? null,
      verdict: summary?.verdict ?? null,
      started_at: summary?.started_at ?? null,
      ended_at: summary?.ended_at ?? null,
      archived_at: null,
    });
  }

  // Most-recently-archived first (fall back to start time, then file name) so the
  // freshest finished task is at the top.
  tasks.sort((a, b) => {
    const ka = a.archived_at ?? a.started_at ?? a.db_file;
    const kb = b.archived_at ?? b.started_at ?? b.db_file;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  sendJson(res, 200, { tasks });
}

// ----- GET /projects/:id/artifacts ---------------------------------------

interface ArtifactInfo {
  path: string;
  size: number;
  modified_at: string | null;
}

// The sandbox root the work agents wrote into. A task runs in an isolated copy
// of the project (a worktree-style copy, or the container copy when the task ran
// in Docker), reused across its spawns; the per-task pref records which. A
// non-git project ran in place. Probe the pref-indicated copy first, then the
// other, then the project dir — the first that exists wins. Returns null when
// none carries a `.claude/` (nothing was written yet).
function sandboxRootFor(dir: string): string | null {
  const docker = readTaskExecPrefs(dir).docker === true;
  const ordered = docker
    ? [clonePathFor(dir), worktreePathFor(dir), dir]
    : [worktreePathFor(dir), clonePathFor(dir), dir];
  for (const root of ordered) {
    if (existsSync(join(root, ".claude"))) return root;
  }
  return null;
}

// List the prose `.md` documents a task's work agents wrote into its sandbox
// `.claude/` — domain-blind: it enumerates files and names none. A finished task
// whose sandbox was discarded simply lists nothing.
export function listArtifacts(res: ServerResponse, dir: string): void {
  const root = sandboxRootFor(dir);
  if (root === null) {
    sendJson(res, 200, { artifacts: [] });
    return;
  }
  const claudeDir = join(root, ".claude");
  let names: string[] = [];
  try {
    names = readdirSync(claudeDir).filter((f) => f.endsWith(".md"));
  } catch {
    names = [];
  }
  const artifacts: ArtifactInfo[] = [];
  for (const name of names) {
    const rel = `.claude/${name}`;
    try {
      const st = statSync(join(claudeDir, name));
      if (!st.isFile()) continue;
      artifacts.push({ path: rel, size: st.size, modified_at: st.mtime.toISOString() });
    } catch {
      /* a file that vanished between readdir and stat — skip it */
    }
  }
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  sendJson(res, 200, { artifacts });
}

// ----- GET /projects/:id/artifact?path=.claude/<name>.md -----------------

// Read ONE whitelisted prose artifact (read-only). Two guards stack: the path
// must match the `.claude/*.md` whitelist (no separators, no dot-dot), and the
// kernel's `resolveSafePath` then canonicalizes it against the sandbox root and
// refuses anything that escapes (a symlinked parent, a sensitive store). A read
// can never leave the sandbox.
export async function getArtifact(res: ServerResponse, dir: string, relPath: string): Promise<void> {
  if (!ARTIFACT_PATH.test(relPath)) {
    throw new ServerError("BAD_ARTIFACT_PATH", 400, "only .claude/*.md documents can be read");
  }
  const root = sandboxRootFor(dir);
  if (root === null) {
    throw new ServerError("ARTIFACT_NOT_FOUND", 404, `no artifact ${relPath}`);
  }
  const safe = await resolveSafePath(relPath, root);
  if (!safe.ok) {
    throw new ServerError("BAD_ARTIFACT_PATH", 400, `artifact path refused: ${safe.reason}`);
  }
  if (!existsSync(safe.path)) {
    throw new ServerError("ARTIFACT_NOT_FOUND", 404, `no artifact ${relPath}`);
  }
  let content: string;
  try {
    content = readFileSync(safe.path, "utf8");
  } catch (err) {
    throw new ServerError("ARTIFACT_UNREADABLE", 500, err instanceof Error ? err.message : String(err));
  }
  const truncated = content.length > MAX_ARTIFACT_BYTES;
  sendJson(res, 200, {
    path: relPath,
    content: truncated ? content.slice(0, MAX_ARTIFACT_BYTES) : content,
    truncated,
  });
}
