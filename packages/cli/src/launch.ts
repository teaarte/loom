// The process launcher shared by every `loom` entry — the CLI's own bin and the
// meta-package's bin shim both call `launch()`, so the two cannot drift (a past
// drift left the shim calling `run` directly: it neither awaited the async
// commands nor re-exec'd for SQLite, so `loom serve` crashed).
//
// A few commands — `reset`, `status`, `run`, `daemon`, `serve`, `models`,
// `projects` — open the project's SQLite store, which on the pinned Node line is
// gated behind --experimental-sqlite. The flag rides only where SQLite is
// actually used: the install commands (setup / allowlist / init) and the pure
// config/secrets verbs never open the store and keep a clean, flag-free
// launcher, so the store-touching commands re-exec the launcher ONCE with the
// flag. A guard env var prevents an infinite re-exec loop, and a probe import
// skips the re-exec entirely on a Node where node:sqlite is already stable.
//
// `run` stays the testable seam (pure dispatch → status); this module owns only
// the process-level concerns (re-exec, await, exit) a unit test does not drive.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { run } from "./cli.js";

const SQLITE_COMMANDS = new Set(["up", "reset", "status", "run", "resume", "daemon", "serve", "models", "projects"]);
const REEXEC_GUARD = "LOOM_SQLITE_REEXEC";

function nodeSqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function reexecWithSqliteFlag(): number {
  const entry = process.argv[1];
  if (entry === undefined) return 1;
  const res = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", entry, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [REEXEC_GUARD]: "1" } },
  );
  if (typeof res.status === "number") return res.status;
  return 1;
}

// Dispatch `argv` and exit with the command's status. Re-execs once with the
// SQLite flag first when a store-touching command needs it. Never returns —
// it owns the process exit (and turns a thrown/rejected command into a clean
// `loom: <message>` + exit 1, so an async command can no longer leak a Promise
// to `process.exit`).
export async function launch(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    // A bare `loom` dispatches to `up`, which opens the project store — so it
    // needs the SQLite flag too. Treat an empty argv as `up` for the re-exec
    // decision (the child re-runs the same bare argv and dispatches to `up`).
    const command = argv[0] ?? "up";
    if (
      SQLITE_COMMANDS.has(command) &&
      process.env[REEXEC_GUARD] !== "1" &&
      !nodeSqliteAvailable()
    ) {
      process.exit(reexecWithSqliteFlag());
    }
    process.exit(await run(argv));
  } catch (err) {
    process.stderr.write(`loom: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
