-- Single-row bypass-marker table — the forge-resistant escape hatch a
-- cross-owner recovery (or a future direct state.db write) presents
-- instead of a naked boolean override.
--
-- Discipline mirrors 001-initial.sql:
--   id = 1 CHECK             single-row table — a second INSERT trips the
--                            PK + CHECK pair. The marker is overwritten in
--                            place on each issue and deleted on consume,
--                            so at most one marker is live at a time.
--   HMAC-SHA256 over         the signature covers (issued_at || expires_at
--   (issued_at||expires_at   || reason). The signing key lives OUTSIDE
--   ||reason)                state.db and outside any project dir (user-
--                            global env var or ~/.claude key file), so a
--                            writer that can reach this row still cannot
--                            forge a valid marker. Key custody + rotation
--                            rules are a kernel-runtime concern, not a SQL
--                            one. Rotation invalidates every marker (its
--                            key_id no longer matches the active key) —
--                            intentional, since markers are TTL'd escape
--                            hatches, not durable state.
--   reason encodes the       a cross-owner marker's reason carries the
--   target                   target driver_state_id so it cannot be
--                            replayed against a different task.
--   timestamps as TEXT       ISO-8601 strings supplied by the caller; no
--                            datetime('now') — same replay-determinism
--                            rule as every other table.
--   key_id surfaces in the   the validator names which key signed a marker
--   refusal                  so a rotation mismatch is legible.

CREATE TABLE bypass_markers (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  hmac TEXT NOT NULL,
  key_id TEXT NOT NULL
);
