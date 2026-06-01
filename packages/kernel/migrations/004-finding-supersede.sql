-- Finding provenance: the iteration that retired a finding.
--
-- A finding is LIVE iff `superseded_by_iteration IS NULL`. When a phase
-- is re-entered (a gate rejection walks the flow back), the prior round's
-- findings for every re-run phase are linked to the new iteration that
-- replaces them — so a stale open blocker from a superseded round can no
-- longer be counted against the live record or block a final acceptance.
--
-- Discipline mirrors 001-initial.sql:
--   additive column          a new NULLable INTEGER — the migration is a
--                            pure ADD COLUMN, so the status CHECK on
--                            findings is untouched (SQLite cannot ALTER a
--                            CHECK in place) and existing rows default to
--                            NULL = live. No table rebuild, no data copy.
--   value is an iteration    the column holds the iteration number that
--   number, not a flag        superseded the row (always GREATER than the
--                            row's own `iteration`), so the provenance is
--                            self-describing: which round retired it.
--   no datetime('now')       supersede carries no timestamp of its own —
--                            the linkage is the iteration, and `recorded_at`
--                            already pins the row's mint time.

ALTER TABLE findings ADD COLUMN superseded_by_iteration INTEGER;

-- The live-blocker hot path filters `superseded_by_iteration IS NULL`;
-- the partial index keeps that scan cheap as the findings table grows
-- across a long-running task's many review rounds.
CREATE INDEX idx_findings_live ON findings(phase, severity)
  WHERE superseded_by_iteration IS NULL;
