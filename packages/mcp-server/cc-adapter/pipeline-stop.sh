#!/usr/bin/env bash
# pipeline-stop.sh — Claude Code Stop hook (ADVISORY, NON-BLOCKING).
#
# Prints a short human-readable hint about the pipeline's state when a
# session stops — never blocks the stop, never writes the DB. It is a
# courtesy note, not enforcement: the kernel owns task lifecycle and
# integrity through its transactions and invariants.
#
# `sqlite3` is a SOFT dependency: if the CLI is missing, the DB does not
# exist, or any read fails, the hook degrades to a generic note and exits
# 0. Parsing of Claude Code's Stop payload is defensive — a missing field
# never aborts the hook.

set -u

payload="$(cat 2>/dev/null || true)"

# Working dir from the payload if present, else the current directory.
cwd=""
session_id=""
if command -v jq >/dev/null 2>&1; then
  cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)"
  session_id="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi
[ -n "$cwd" ] || cwd="$(pwd)"

db="$cwd/.loom/state.db"

note() { printf 'pipeline: %s\n' "$1"; exit 0; }

# Soft-dependency + existence guards → generic note, never a failure.
command -v sqlite3 >/dev/null 2>&1 || note "state hint unavailable (sqlite3 CLI not on PATH)."
[ -f "$db" ]                       || note "no task state for this project."

# Best-effort single read. Any failure degrades to the generic note.
row="$(sqlite3 "$db" \
  "SELECT COALESCE(p.owner_id,''), p.status,
          COALESCE((SELECT COUNT(*) FROM pending_agents), 0),
          COALESCE((SELECT pending_user_answer FROM driver_state WHERE id = 1), ''),
          COALESCE((SELECT MIN(started_at) FROM pending_agents), '')
   FROM pipeline_state p WHERE p.id = 1;" 2>/dev/null || true)"
[ -n "$row" ] || note "no task state for this project."

owner="$(printf '%s' "$row"  | cut -d'|' -f1)"
status="$(printf '%s' "$row" | cut -d'|' -f2)"
pending_agents="$(printf '%s' "$row" | cut -d'|' -f3)"
pending_answer="$(printf '%s' "$row" | cut -d'|' -f4)"
oldest_pending="$(printf '%s' "$row" | cut -d'|' -f5)"

# Staleness threshold — mirrors the kernel zombie-pending window (50 min).
# A pending agent idle longer than this is the signature of a dropped
# transport (a slept laptop, a closed socket), not active work.
STALE_PENDING_SEC=3000

# ISO-8601 UTC → unix seconds; GNU `date -d` then BSD/macOS `date -j`.
# Empty on failure, which simply skips the staleness check.
iso_to_epoch() {
  local iso="$1" epoch=""
  epoch="$(date -u -d "$iso" +%s 2>/dev/null || true)"
  if [ -z "$epoch" ]; then
    local trimmed="${iso%.*}"; trimmed="${trimmed%Z}"
    epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%S" "$trimmed" +%s 2>/dev/null || true)"
  fi
  printf '%s' "$epoch"
}

owner_hint=""
if [ -n "$owner" ] && [ -n "$session_id" ] && [ "$owner" != "$session_id" ]; then
  owner_hint=" (owned by another session)"
fi

# Tri-state hint, derived top-down. Terminal states short-circuit first.
case "$status" in
  completed|abandoned)
    note "task is finalized (status=$status)$owner_hint." ;;
esac

if [ -n "$pending_answer" ]; then
  note "gate-paused — a checkpoint is awaiting your answer$owner_hint."
elif [ "${pending_agents:-0}" -gt 0 ]; then
  # Stale pending → likely a dropped transport, not live work. Best-effort:
  # any failure to compute the age falls through to the in-flight note.
  if [ -n "$oldest_pending" ]; then
    started_epoch="$(iso_to_epoch "$oldest_pending")"
    now_epoch="$(date -u +%s 2>/dev/null || true)"
    if [ -n "$started_epoch" ] && [ -n "$now_epoch" ] && [ "$now_epoch" -ge "$started_epoch" ]; then
      age_sec=$(( now_epoch - started_epoch ))
      if [ "$age_sec" -ge "$STALE_PENDING_SEC" ]; then
        note "paused mid-flight ~$(( age_sec / 60 )) min — likely a dropped transport; resume with /proceed or 'loom resume'$owner_hint."
      fi
    fi
  fi
  note "in-flight — $pending_agents agent(s) still executing$owner_hint."
else
  note "accept-pending — task in progress, nothing dispatched$owner_hint."
fi
