#!/usr/bin/env bash
# pipeline-guard.sh — Claude Code PreToolUse hook (ADVISORY ONLY).
#
# Blocks the obvious accidental shell mutations of the pipeline state DB
# (`.loom/state.db`): a direct `rm`, `mv`, output-redirect (`>`), or
# in-place `sed -i`. It is belt-and-suspenders for fat-fingered keystrokes
# — NOT a security boundary. It is trivially bypassed by any non-shell
# write path (a Python/Node one-liner, a symlink, a wrapper script). The
# real integrity boundary is the kernel's atomic transactions plus its
# on-commit invariants: a write that does not go through them leaves the
# DB failing invariant checks on the next kernel touch, which recovery
# rolls back. Treat this script accordingly.
#
# Contract: reads Claude Code's PreToolUse JSON on stdin, inspects only the
# Bash tool's command string, and denies the four mutations above when the
# target path ends in `.loom/state.db`. Everything else passes through.
# Parsing is defensive — a missing/unknown field falls back to allow.

set -u

payload="$(cat 2>/dev/null || true)"

# Extract the shell command. Prefer jq; fall back to a minimal extractor so
# the hook still functions if jq is absent. Either failure → empty → allow.
command_str=""
if command -v jq >/dev/null 2>&1; then
  command_str="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
else
  command_str="$(printf '%s' "$payload" \
    | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' \
    | head -n1)"
fi

# Only the state DB is in scope. No mention → allow.
case "$command_str" in
  *".loom/state.db"*) : ;;
  *) exit 0 ;;
esac

# Match the four accidental-mutation shapes against the state DB path.
is_mutation=0
case "$command_str" in
  *"rm "*".loom/state.db"*)     is_mutation=1 ;;
  *"mv "*".loom/state.db"*)     is_mutation=1 ;;
  *">"*".loom/state.db"*)       is_mutation=1 ;;
  *"sed -i"*".loom/state.db"*)  is_mutation=1 ;;
esac

if [ "$is_mutation" -eq 1 ]; then
  reason="refused: direct shell mutation of .loom/state.db — use pipeline_recover. (advisory guard; the real boundary is the kernel's transactional invariants)"
  # Emit Claude Code's structured deny decision on stdout AND exit non-zero,
  # so either contract interpretation treats this as a block.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  printf '%s\n' "$reason" >&2
  exit 2
fi

exit 0
