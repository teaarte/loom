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

// Default per-spawn wall-time cap. A single agent spawn that runs longer than
// this is wedged — the live failure was a planner that looped ~30 min on failing
// tool calls and never returned a result, with NO cap to stop it. A generous
// default bounds a runaway (killed → re-driven → eventually parked) without
// false-killing a heavy-but-legit spawn. Override with
// LOOM_SPAWN_SESSION_TIMEOUT_MS; set it to 0 to disable the cap.
export const DEFAULT_SPAWN_SESSION_TIMEOUT_MS = 1_800_000; // 30m

// There is deliberately NO default IDLE cap. `claude -p --output-format json`
// (the primary backend) does not stream — it prints one JSON object at the END,
// so its stdout is silent for the whole run, and a default idle cap would
// false-kill every legitimate long spawn. Idle stays env-only
// (LOOM_SPAWN_IDLE_TIMEOUT_MS), useful for a streaming harness (aider/opencode).

// Resolve an env duration with a default: unset/blank/malformed → the default
// (so a cap is always in force); an explicit 0 → no cap (opt-out); an explicit
// positive value → that value.
function resolveWithDefault(raw: string | undefined, def: number): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return def;
  const ms = parseDurationMs(raw);
  if (ms === undefined) return def;
  if (ms === 0) return undefined;
  return ms;
}

export function resolveSpawnTimeouts(env: NodeJS.ProcessEnv): SpawnTimeouts {
  const out: SpawnTimeouts = {};
  const session = resolveWithDefault(env["LOOM_SPAWN_SESSION_TIMEOUT_MS"], DEFAULT_SPAWN_SESSION_TIMEOUT_MS);
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
