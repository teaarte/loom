// Operational resilience knobs, read from the environment and shared by
// `loom run` / `loom daemon` / `loom serve`.
//
// Two tiers, both generic (by TIME), never by domain:
//   * per-SPAWN timeouts (`LOOM_SPAWN_SESSION_TIMEOUT_MS` / `_IDLE_TIMEOUT_MS`)
//     ride into both executors via the shared capture seam, so a wedged spawn
//     is killed where the child lives — both backends free;
//   * per-SUPERVISOR knobs (`LOOM_RATE_LIMIT_WAIT`, `LOOM_DRIVE_DEADLINE_MS`)
//     ride into the supervisor — wait out a sustained rate-limit window and
//     bound a whole drive.
//
// Env over flags: the daemon's argv parser is boolean-only (a value-flag would
// collide with the positional task string), and these match the established
// `LOOM_*` config posture.

// Parse a duration: a plain integer is MILLISECONDS (consistent with the `_MS`
// env names); an optional unit suffix `s`/`m`/`h` (or explicit `ms`) is also
// accepted so `LOOM_RATE_LIMIT_WAIT=1h` reads naturally. Returns ms, or
// undefined when unset/blank/malformed (the caller treats that as "no knob").
export function parseDurationMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (s.length === 0) return undefined;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s);
  if (m === null || m[1] === undefined) return undefined;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 0) return undefined;
  const unit = m[2] ?? "ms";
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return n * mult;
}

// Per-spawn timeout knobs threaded into both executors (worktree + container).
export interface SpawnTimeouts {
  session_timeout_ms?: number;
  idle_timeout_ms?: number;
}

export function resolveSpawnTimeouts(env: NodeJS.ProcessEnv): SpawnTimeouts {
  const out: SpawnTimeouts = {};
  const session = parseDurationMs(env["LOOM_SPAWN_SESSION_TIMEOUT_MS"]);
  if (session !== undefined && session > 0) out.session_timeout_ms = session;
  const idle = parseDurationMs(env["LOOM_SPAWN_IDLE_TIMEOUT_MS"]);
  if (idle !== undefined && idle > 0) out.idle_timeout_ms = idle;
  return out;
}

// Supervisor-level resilience knobs (daemon + serve).
export interface SupervisionKnobs {
  rate_limit_wait_ms?: number;
  drive_deadline_ms?: number;
}

export function resolveSupervisionKnobs(env: NodeJS.ProcessEnv): SupervisionKnobs {
  const out: SupervisionKnobs = {};
  const wait = parseDurationMs(env["LOOM_RATE_LIMIT_WAIT"]);
  if (wait !== undefined && wait > 0) out.rate_limit_wait_ms = wait;
  const deadline = parseDurationMs(env["LOOM_DRIVE_DEADLINE_MS"]);
  if (deadline !== undefined && deadline > 0) out.drive_deadline_ms = deadline;
  return out;
}
