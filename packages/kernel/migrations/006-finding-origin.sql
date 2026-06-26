-- Finding provenance: code vs harness.
--
-- A finding is either a fact ABOUT the work under review (`code`, the
-- default — a fixer can act on it) or a failure of the orchestration
-- plumbing itself (`harness` — an unparseable agent output, a transport
-- fault). The two must gate differently: a code blocker drives the rework
-- loop; a harness blocker routes to a human, because re-running the
-- implementer cannot fix a parse error. Before this column the two were
-- indistinguishable, so a synthesized harness blocker spun the implement →
-- review loop until the replan cap escalated it.
--
-- Default 'code' so every pre-existing row keeps its prior meaning and any
-- writer that does not yet set the column lands a code finding (the common
-- case). Only the kernel mints 'harness'.

ALTER TABLE findings
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'code'
  CHECK (origin IN ('code', 'harness'));

-- The gate's harness-vs-code split queries blocking findings by origin;
-- a partial index keeps that lookup off a full scan as the table grows.
CREATE INDEX idx_findings_origin ON findings(origin);
