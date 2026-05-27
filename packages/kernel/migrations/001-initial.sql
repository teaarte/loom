-- Kernel-owned schema, applied once on first DB open.
--
-- Discipline this file encodes:
--   id = 1 CHECK on aggregates  single-row tables (pipeline_state /
--                               pipeline_counters / driver_state) — any
--                               second INSERT trips the PK + CHECK pair
--                               and rolls the tx back.
--   json_valid(<col>) CHECK     every JSON column trips before commit.
--                               This is the schema-meta invariant: bad
--                               JSON cannot land on disk, and a buggy
--                               writer surfaces at the tx boundary,
--                               not later as a parse blow-up.
--   status / verdict IN-list    explicit enum at the SQL layer. Open
--                               vocabularies (decided_by, output_kind,
--                               audit.type, error_class) stay plain
--                               TEXT — runtime validation against the
--                               registered vocabulary set is what
--                               keeps them honest, so adding a value
--                               does not need a schema migration.
--   timestamps as TEXT          ISO-8601 strings supplied by the
--                               caller; the SQL layer never reads the
--                               host clock (no datetime('now'),
--                               strftime(..., 'now'), julianday('now')).
--                               That keeps tx-internal computation
--                               bit-identical across the original
--                               commit and any later replay.
--
-- Hot-path counters are split out of pipeline_state so that touching a
-- single INTEGER on each agent-result tick rewrites a tiny WAL frame,
-- not the JSON-heavy aggregate row.

-- ============================================================
-- Aggregate state (single-row tables)
-- ============================================================

CREATE TABLE pipeline_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  bundle TEXT NOT NULL,
  task_id TEXT,
  task TEXT NOT NULL,
  task_short TEXT,
  driver_state_id TEXT NOT NULL,
  owner_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  verdict TEXT
    CHECK (verdict IS NULL OR verdict IN (
      'accepted', 'rejected', 'failed_force_closed'
    )),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  -- Wire-form policy map; values are policy-name strings the kernel
  -- dispatcher resolves to closures at registry-load time. Storing
  -- strings keeps the row structurally comparable and serializable.
  gate_policies TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(gate_policies)),
  decisions TEXT
    CHECK (decisions IS NULL OR json_valid(decisions)),
  bundle_state TEXT
    CHECK (bundle_state IS NULL OR json_valid(bundle_state)),
  files_created TEXT
    CHECK (files_created IS NULL OR json_valid(files_created)),
  files_modified TEXT
    CHECK (files_modified IS NULL OR json_valid(files_modified)),
  stack TEXT
    CHECK (stack IS NULL OR json_valid(stack)),
  pipeline_violation TEXT,
  force_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pipeline_counters (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  agents_count INTEGER NOT NULL DEFAULT 0,
  -- Token roll-ups stay 0 when the resolved provider declares
  -- reports_usage=false. Cost calculation is downstream — kernel only
  -- accumulates raw counts.
  total_tokens_in INTEGER NOT NULL DEFAULT 0,
  total_tokens_out INTEGER NOT NULL DEFAULT 0,
  total_tokens_cached INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pipeline_gate_counters (
  -- Per-role counters; role names come from the active bundle's
  -- gate_roles vocabulary. Rows are seeded on first decision per role
  -- and reset only by a fresh task_id (atomic DELETE + INSERT inside
  -- the task-create tx).
  role TEXT PRIMARY KEY,
  -- Bumped when a human-decided gate of this role is rejected with
  -- intent=revise.
  human_revisions INTEGER NOT NULL DEFAULT 0,
  -- Bumped on every gate decision where the resolved policy returns
  -- auto-reject; the auto-replan ceiling sums this column.
  auto_rejections INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE driver_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  flow_name TEXT NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  pending_user_answer TEXT
    CHECK (pending_user_answer IS NULL OR json_valid(pending_user_answer)),
  scratch TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(scratch))
);

-- ============================================================
-- Multi-row tables (phases, agents, findings, gates, audit)
-- ============================================================

CREATE TABLE phases (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
  skipped_reason TEXT,
  phase_extension TEXT
    CHECK (phase_extension IS NULL OR json_valid(phase_extension)),
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL REFERENCES phases(name),
  agent TEXT NOT NULL,
  agent_run_id TEXT NOT NULL UNIQUE,
  model TEXT,
  -- output_kind is open TEXT validated at insert time against the
  -- merged kernel-default + bundle-extension vocabulary; adding a kind
  -- does not need a schema migration.
  output_kind TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_agent_records_phase ON agent_records(phase);
CREATE INDEX idx_agent_records_agent ON agent_records(agent);

CREATE TABLE pending_agents (
  agent_run_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  phase TEXT NOT NULL,
  model TEXT,
  -- ISO-8601 captured at the inserting FSM tick. The duplicate-window
  -- and zombie-window invariants read this against the same tick's
  -- now token so replay verdicts match the original commit.
  started_at TEXT NOT NULL
);

CREATE TABLE agent_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL,
  agent TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  summary_line TEXT,
  blocking_issues INTEGER NOT NULL DEFAULT 0,
  warn_issues INTEGER NOT NULL DEFAULT 0,
  info_issues INTEGER NOT NULL DEFAULT 0,
  categories_seen TEXT
    CHECK (categories_seen IS NULL OR json_valid(categories_seen)),
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_agent_verdicts_phase_agent_iter
  ON agent_verdicts(phase, agent, iteration);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  agent TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  phase TEXT NOT NULL,
  file TEXT,
  line_start INTEGER,
  line_end INTEGER,
  severity TEXT NOT NULL
    CHECK (severity IN ('blocking','warn','info')),
  category TEXT NOT NULL,
  proposed_new_category TEXT,
  pattern_id TEXT,
  summary TEXT NOT NULL,
  evidence_excerpt TEXT,
  suggested_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','fixed','accepted_by_human','dismissed')),
  ref_rule_id TEXT,
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_findings_status      ON findings(status);
CREATE INDEX idx_findings_severity    ON findings(severity);
CREATE INDEX idx_findings_agent       ON findings(agent);
CREATE INDEX idx_findings_file        ON findings(file);
CREATE INDEX idx_findings_recorded_at ON findings(recorded_at);

CREATE TABLE gates (
  -- Gate names are bundle-declared; the kernel resolver decides by
  -- role (gate_policies map), not by literal name.
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL
    CHECK (status IN ('pending','approved','rejected',
                       'auto-approved','auto-rejected','skipped')),
  -- decided_by is open TEXT validated against the registered decider
  -- vocabulary at insert time; future deciders register additively.
  decided_by TEXT NOT NULL,
  feedback TEXT,
  decided_at TEXT
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  -- type is open TEXT validated against the registered audit-type set
  -- at insert time; subsystems extend the vocabulary without a schema
  -- migration.
  type TEXT NOT NULL,
  task_id TEXT,
  driver_state_id TEXT,
  payload TEXT
    CHECK (payload IS NULL OR json_valid(payload)),
  verdict TEXT NOT NULL DEFAULT 'ok'
    CHECK (verdict IN ('ok','error','force_bypass')),
  error_class TEXT,
  force_used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_audit_type_ts     ON audit(type, ts);
CREATE INDEX idx_audit_ts          ON audit(ts);
-- Partial index — error rows are the forensic hot set; non-error rows
-- never need this lookup path.
CREATE INDEX idx_audit_error_class ON audit(error_class)
  WHERE error_class IS NOT NULL;

-- ============================================================
-- Idempotency ledger
-- ============================================================

CREATE TABLE kernel_idempotency_ledger (
  key TEXT PRIMARY KEY,
  first_seen_ts TEXT NOT NULL,
  last_seen_ts TEXT NOT NULL,
  -- Null while the persistence tx has committed but the cached
  -- response has not yet been materialized (crash-recovery window).
  response_blob TEXT,
  hook_results_json TEXT,
  driver_state_id TEXT NOT NULL,
  -- Null only for the task-create entry that mints the task_id. Every
  -- later op binds its ledger row to a task_id so a replay against a
  -- fresh task is refused.
  task_id TEXT,
  now_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_idempotency_ledger_expires_at
  ON kernel_idempotency_ledger(expires_at);
CREATE INDEX idx_idempotency_ledger_driver
  ON kernel_idempotency_ledger(driver_state_id);
CREATE INDEX idx_idempotency_ledger_task
  ON kernel_idempotency_ledger(task_id);
