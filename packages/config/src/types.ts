// The shapes of loom's control layer — the data a face reads/writes, and the
// data the resolver hands back. Pure types; no behavior, no I/O, no domain.
//
// Genericity note: nothing here names an agent, a tier, or a bundle. The model
// map is OPEN-keyed by bundle name → agent name → a model reference. The names
// come from whatever roster the caller loaded; this leaf invents none.

// A per-agent model assignment, written `provider:model` (e.g.
// `anthropic:claude-sonnet`, `openrouter:deepseek`) or a bare tier / concrete
// model name (e.g. `premium`, `haiku`). The `provider:` prefix is the provider
// FAMILY used for backend-compatibility validation (see capabilities.ts); a
// bare value has no family and is resolved within the chosen backend.
export type ModelRef = string;

// The model bindings for one bundle, keyed by agent name (from the bundle's
// roster). Open-keyed — no fixed agent names.
export interface BundleModelConfig {
  agents?: Record<string, ModelRef>;
}

// Outbound-notify settings, mirroring the existing `LOOM_NOTIFY_*` env knobs so
// config can act as a lower-priority layer under the environment. Any string
// value may be a secret reference of the form `secret:<name>` (resolved from
// secrets.json at use) instead of a literal, so a token never lands in
// config.json. See secrets.ts / resolveSecret.
export interface NotifyConfig {
  webhook_url?: string;
  slack_url?: string;
  telegram_token?: string;
  telegram_chat?: string;
  script?: string;
  events?: string[];
  timeout_ms?: number;
}

// Operational resilience knobs, mirroring `LOOM_*` env (lib/resilience.ts).
// Durations accept the same `1h`/`30m`/`90s`/`<ms>` forms `parseDurationMs`
// already understands; config just supplies the string and the existing
// env-reader parses it.
export interface ResilienceConfig {
  rate_limit_wait?: string;
  drive_deadline_ms?: number;
  spawn_session_timeout_ms?: number;
  spawn_idle_timeout_ms?: number;
}

// Optional per-backend credential OVERRIDE. The DEFAULT is a documented
// convention (a backend resolves its key from a conventionally-named secret —
// see credentials.ts); this lets a deployment point a backend at a differently-
// named secret or a base-URL ref instead. Both are secret references
// (`secret:<name>`) or literals, resolved at the point the executor is built —
// never stored as a literal value here. Keyed by backend name.
export interface BackendCredentialConfig {
  key_ref?: string;
  base_url_ref?: string;
}

// The global / project config document (config.json and <repo>/.claude/loom.json
// share this shape). All fields optional — an absent file is the empty config.
export interface LoomConfig {
  // `auto` (default) | a backend name. Stored here and validated against the
  // capability table; resolved to a concrete backend per spawn at dispatch.
  backend?: string;
  // Which agentic CLI HARNESS drives a work-agent (one that edits files) on a
  // non-Claude backend — the adapter to shell out to. Absent → the first shipped
  // adapter. Claude Code carries its own loop and ignores this. An infra name
  // (the adapter), never a bundle's domain. Overridable per run via LOOM_HARNESS.
  harness?: string;
  // Bundle-namespaced per-agent model map: bundles[<bundle>].agents[<agent>].
  bundles?: Record<string, BundleModelConfig>;
  notify?: NotifyConfig;
  resilience?: ResilienceConfig;
  // Per-backend credential overrides (optional — the convention covers the
  // common case). Keyed by backend name.
  credentials?: Record<string, BackendCredentialConfig>;
}

// secrets.json: a flat name → value map, machine-local, chmod 600. Never in a
// repo, never committed, masked on read.
export type SecretsFile = Record<string, string>;

// One project in the catalog (workspace.json). `id` is supplied by the caller
// (the CLI computes it from the project dir) so this leaf needs no hashing /
// server dependency. The catalog is the KNOWN-projects list — distinct from the
// server's live supervised set (projects.json).
export interface WorkspaceEntry {
  id: string;
  dir: string;
  label?: string;
  bundle?: string;
  added_at?: string;
  last_opened_at?: string;
  pinned?: boolean;
}

// A bundle's roster as plain data — the structural subset of a loaded bundle
// the resolver/adapter needs. The caller (which already loaded the registry)
// passes this in; the leaf never imports a bundle or the kernel.
export interface AgentRosterEntry {
  name: string;
  default_model?: string;
}
export interface BundleRoster {
  name: string;
  agents: AgentRosterEntry[];
  default_model_tiers?: Record<string, string>;
  default_provider?: string;
}

// What `resolveConfig` returns. `merged` is global ← project (for reads, and for
// the non-model settings). `layers` keeps the two model-map sources SEPARATE so
// the caller can slot the legacy `.claude/providers.json` between them at the
// project rung (built-in ← bundle ← global ← [providers.json ← loom.json] ← env).
// `envOverlay` is a `LOOM_*` map derived from merged notify+resilience, to be
// merged UNDER the real environment so existing env readers see config as
// defaults and the environment still wins.
export interface ResolvedConfig {
  merged: LoomConfig;
  layers: {
    global: LoomConfig;
    project: LoomConfig;
  };
  envOverlay: Record<string, string>;
  // Resolved global home ($LOOM_HOME), where the four stores live.
  home: string;
  backend: string;
}
