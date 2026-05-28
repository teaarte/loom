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

db="$cwd/.claude/state.db"

note() { printf 'pipeline: %s\n' "$1"; exit 0; }

# Soft-dependency + existence guards → generic note, never a failure.
command -v sqlite3 >/dev/null 2>&1 || note "state hint unavailable (sqlite3 CLI not on PATH)."
[ -f "$db" ]                       || note "no task state for this project."

# Best-effort single read. Any failure degrades to the generic note.
row="$(sqlite3 "$db" \
  "SELECT COALESCE(p.owner_id,''), p.status,
          COALESCE((SELECT COUNT(*) FROM pending_agents), 0),
          COALESCE((SELECT pending_user_answer FROM driver_state WHERE id = 1), '')
   FROM pipeline_state p WHERE p.id = 1;" 2>/dev/null || true)"
[ -n "$row" ] || note "no task state for this project."

owner="$(printf '%s' "$row"  | cut -d'|' -f1)"
status="$(printf '%s' "$row" | cut -d'|' -f2)"
pending_agents="$(printf '%s' "$row" | cut -d'|' -f3)"
pending_answer="$(printf '%s' "$row" | cut -d'|' -f4)"

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
  note "in-flight — $pending_agents agent(s) still executing$owner_hint."
else
  note "accept-pending — task in progress, nothing dispatched$owner_hint."
fi
