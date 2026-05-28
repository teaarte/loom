-- Installed-extension registry — what the kernel sees on disk after
-- enumerating packages at the workspace root.
--
-- Discipline encoded here mirrors 001-initial.sql:
--   id = `${kind}:${name}` PK   composite-via-concatenation matches the
--                               key shape every read site uses, so a
--                               lookup is one indexed seek not a
--                               (kind, name) range scan.
--   kind IN (...) CHECK         closed enum at the SQL layer — bundle /
--                               provider / mcp-client are the only
--                               shapes the loader knows.
--   json_valid(manifest_json)   manifest snapshot stored verbatim so a
--                               later read can re-validate against
--                               whatever the in-process types look like
--                               then; bad JSON cannot land on disk.
--   status IN (...) CHECK       closed enum — enabled / disabled /
--                               failed are the lifecycle states the
--                               loader writes; row deletion is reserved
--                               for the deferred daemon-mode uninstall
--                               flow, MVP only flips status.
--   timestamps as TEXT          ISO-8601 strings supplied by the
--                               caller; no datetime('now') /
--                               strftime(..., 'now') / julianday('now')
--                               — same replay-determinism rule as the
--                               aggregate tables.

CREATE TABLE installed_extensions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL
    CHECK (kind IN ('bundle', 'provider', 'mcp-client')),
  name TEXT NOT NULL,
  publisher TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL
    CHECK (json_valid(manifest_json)),
  status TEXT NOT NULL DEFAULT 'enabled'
    CHECK (status IN ('enabled', 'disabled', 'failed')),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  failure_reason TEXT
);

CREATE INDEX idx_installed_extensions_kind   ON installed_extensions(kind);
CREATE INDEX idx_installed_extensions_status ON installed_extensions(status);
