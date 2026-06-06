// Extension manifest layer — discover installed extensions on disk,
// validate their manifests, reconcile against the installed_extensions
// table, and emit lifecycle audit events.
//
// Two functions ship out of this file:
//
//   reconcileExtensions(opts) — the pure core. Takes already-loaded
//                               DiscoveredManifest records and performs
//                               UPSERT + removal sweep + audit emission
//                               against the supplied project's DB. No
//                               filesystem I/O; tests target this entry.
//
//   discoverExtensions(opts)  — thin filesystem wrapper. Globs known
//                               package layouts, loads each manifest,
//                               and delegates to reconcileExtensions.
//
// Validation failures DO NOT throw. The row lands with status='failed'
// plus a typed failure_reason string and an extension-load-failed audit
// row co-commits in the same transaction — operators see broken
// extensions via list / audit rather than a silent swallow.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { KERNEL_SCHEMA_VERSION, withConnection } from "@loomfsm/kernel/internal";
import { assertVocabKnown, kernelDefaultVocabularies } from "@loomfsm/kernel/internal";
import type { ExtensionKind, ExtensionManifest } from "@loomfsm/kernel";
import type { NowToken } from "@loomfsm/kernel";

// Reconciliation runs at start-up, before any bundle Registry exists,
// so the lifecycle audit rows validate against the kernel baseline.
// The values emitted here are all kernel-owned; the check is the
// self-consistency guard that a new emit-site was also added to the
// baseline set.
const KERNEL_VOCAB = kernelDefaultVocabularies();

// ============================================================================
// Public types
// ============================================================================

// `${kind}:${name}` — composite-via-concatenation matches the contract
// shape (e.g. "bundle:code", "provider:<name>").
export type ExtensionId = string;

export interface DiscoveredManifest {
  // Identifier for the manifest source; the filesystem wrapper uses the
  // absolute filesystem path, but the pure core treats this as an
  // opaque tag (used only to synthesize a fallback id when validation
  // fails before kind + name can be extracted).
  path: string;
  // Raw object as loaded — typed as `unknown` so the core narrows it
  // through validateManifest before touching any field.
  raw: unknown;
  // Set when the source could not be loaded at all (file unreadable,
  // default export missing). The core treats this as a load failure
  // with failure_reason `"manifest-load-failed: <message>"`.
  load_error?: string;
}

export interface ReconciliationReport {
  installed: ExtensionId[];
  changed: ExtensionId[];
  removed: ExtensionId[];
  failed: { id: ExtensionId; failure_reason: string }[];
}

// ============================================================================
// Internal helpers (not re-exported from the kernel barrel)
// ============================================================================

// Parse a strict "X.Y.Z" version triple. Pre-release tags, build
// metadata, and "v" prefixes all return null — the caller surfaces
// kernel-api-mismatch when this happens.
function parseTriple(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Parse the right-hand side of a caret range: accepts "X.Y" (patch = 0)
// or "X.Y.Z". Anything else returns null.
function parseCaretRhs(s: string): [number, number, number] | null {
  const m3 = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m3 !== null) return [Number(m3[1]), Number(m3[2]), Number(m3[3])];
  const m2 = /^(\d+)\.(\d+)$/.exec(s);
  if (m2 !== null) return [Number(m2[1]), Number(m2[2]), 0];
  return null;
}

// Micro-matcher: caret + exact forms only. Tilde / OR / hyphen ranges /
// pre-release tags all return false so the caller surfaces a
// kernel-api-mismatch — broader semver support is a future-loader
// concern; the kernel stays runtime-dep-free.
function satisfiesRange(version: string, range: string): boolean {
  const v = parseTriple(version);
  if (v === null) return false;

  if (range.startsWith("^")) {
    const r = parseCaretRhs(range.slice(1));
    if (r === null) return false;
    if (v[0] !== r[0]) return false;
    if (v[1] > r[1]) return true;
    if (v[1] === r[1] && v[2] >= r[2]) return true;
    return false;
  }

  return version === range;
}

// Recursive key-sorted JSON stringification. Manifest-diff detection
// runs through this so two manifests with the same content but
// different key ordering don't surface as a spurious manifest-change
// event. Output is stable: same input → same string.
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ":" + canonicalJson(v));
    }
    return "{" + parts.join(",") + "}";
  }
  // undefined / function / symbol — coerce to null so the result stays
  // JSON-parseable.
  return "null";
}

const VALID_KINDS: ReadonlySet<string> = new Set(["bundle", "provider", "mcp-client"]);

interface PartialIdentity {
  kind: ExtensionKind | null;
  name: string | null;
  publisher: string | null;
  version: string | null;
}

function extractPartial(raw: unknown): PartialIdentity {
  if (typeof raw !== "object" || raw === null) {
    return { kind: null, name: null, publisher: null, version: null };
  }
  const r = raw as Record<string, unknown>;
  const kRaw = r["kind"];
  const nRaw = r["name"];
  const pRaw = r["publisher"];
  const vRaw = r["version"];
  return {
    kind: typeof kRaw === "string" && VALID_KINDS.has(kRaw) ? (kRaw as ExtensionKind) : null,
    name: typeof nRaw === "string" && nRaw.length > 0 ? nRaw : null,
    publisher: typeof pRaw === "string" ? pRaw : null,
    version: typeof vRaw === "string" ? vRaw : null,
  };
}

type ValidationResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; failure_reason: string };

// Manifest validation cascade. Each check independently produces a
// failure_reason; first failure wins. Capability allowlist is NOT
// checked here — verbs stay open-string at the manifest layer; bundle-
// runtime verb enforcement is a separate concern.
function validateManifest(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, failure_reason: "manifest-shape-invalid: not an object" };
  }
  const r = raw as Record<string, unknown>;

  if (r["manifest_version"] !== "1.0") {
    return { ok: false, failure_reason: "manifest-shape-invalid: manifest_version" };
  }
  if (typeof r["name"] !== "string" || (r["name"] as string).length === 0) {
    return { ok: false, failure_reason: "manifest-shape-invalid: name" };
  }
  const kind = r["kind"];
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    return { ok: false, failure_reason: "manifest-shape-invalid: kind" };
  }
  if (typeof r["publisher"] !== "string" || (r["publisher"] as string).length === 0) {
    return { ok: false, failure_reason: "manifest-shape-invalid: publisher" };
  }
  if (typeof r["version"] !== "string" || (r["version"] as string).length === 0) {
    return { ok: false, failure_reason: "manifest-shape-invalid: version" };
  }
  const requires = r["requires"];
  if (typeof requires !== "object" || requires === null) {
    return { ok: false, failure_reason: "manifest-shape-invalid: requires" };
  }
  const reqKernelApi = (requires as Record<string, unknown>)["kernel_api"];
  if (typeof reqKernelApi !== "string" || reqKernelApi.length === 0) {
    return { ok: false, failure_reason: "manifest-shape-invalid: requires.kernel_api" };
  }

  if (r["publisher"] !== "@loom") {
    return { ok: false, failure_reason: "publisher-not-curated" };
  }

  if (!satisfiesRange(KERNEL_SCHEMA_VERSION, reqKernelApi)) {
    return {
      ok: false,
      failure_reason: `kernel-api-mismatch: ${reqKernelApi} vs ${KERNEL_SCHEMA_VERSION}`,
    };
  }

  return { ok: true, manifest: raw as ExtensionManifest };
}

function idFromKindName(kind: string, name: string): ExtensionId {
  return `${kind}:${name}`;
}

interface AuditPayload {
  id: ExtensionId;
  kind: string | null;
  name: string | null;
  publisher: string | null;
  version: string | null;
  failure_reason?: string;
}

function insertAudit(
  db: DatabaseSync,
  now: NowToken,
  type:
    | "extension-installed"
    | "extension-manifest-changed"
    | "extension-removed"
    | "extension-load-failed",
  payload: AuditPayload,
): void {
  const errorClass = type === "extension-load-failed" ? "extension-load-failed" : null;
  assertVocabKnown(KERNEL_VOCAB.audit_types, type, "audit_types");
  if (errorClass !== null) {
    assertVocabKnown(KERNEL_VOCAB.error_classes, errorClass, "error_class");
  }
  db.prepare(
    "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, verdict, error_class) " +
      "VALUES (?, ?, NULL, NULL, ?, 'ok', ?)",
  ).run(now, type, JSON.stringify(payload), errorClass);
}

// ============================================================================
// reconcileExtensions — pure core
// ============================================================================

// withStateTransaction is NOT used here: it runs the kernel invariant
// suite on commit, which materializes PipelineState via loadState. At
// kernel start (when reconciliation runs) no pipeline_state row exists
// yet, so loadState would throw STATE_NOT_INITIALIZED. The atomicity
// contract the wrapper provides is preserved by the direct
// BEGIN IMMEDIATE / COMMIT pattern, mirroring the migration runner.
export async function reconcileExtensions(opts: {
  manifests: DiscoveredManifest[];
  project_dir: string;
  now: NowToken;
}): Promise<ReconciliationReport> {
  const { manifests, project_dir, now } = opts;
  return await withConnection(project_dir, async (db) =>
    reconcileOnConnection(db, manifests, now),
  );
}

// Body of the reconcile pass, run on a connection borrowed from the
// project pool so it never pins the shared maintenance handle. Each
// per-extension reconcile + audit pair runs in its own BEGIN IMMEDIATE /
// COMMIT block so the installed_extensions row and its lifecycle audit
// row co-commit atomically — a crash mid-sweep cannot leave one without
// the other.
function reconcileOnConnection(
  db: DatabaseSync,
  manifests: DiscoveredManifest[],
  now: NowToken,
): ReconciliationReport {
  const report: ReconciliationReport = {
    installed: [],
    changed: [],
    removed: [],
    failed: [],
  };

  const discoveredIds = new Set<ExtensionId>();

  for (const d of manifests) {
    if (d.load_error !== undefined) {
      const partial = extractPartial(d.raw);
      handleFailed(db, now, d, partial, `manifest-load-failed: ${d.load_error}`, report, discoveredIds);
      continue;
    }

    const v = validateManifest(d.raw);
    if (!v.ok) {
      const partial = extractPartial(d.raw);
      handleFailed(db, now, d, partial, v.failure_reason, report, discoveredIds);
      continue;
    }

    const m = v.manifest;
    const id = idFromKindName(m.kind, m.name);
    discoveredIds.add(id);
    const canonicalManifest = canonicalJson(m);

    const existing = db
      .prepare("SELECT manifest_json, status FROM installed_extensions WHERE id = ?")
      .get(id) as { manifest_json: string; status: string } | undefined;

    db.exec("BEGIN IMMEDIATE");
    try {
      if (existing === undefined) {
        db.prepare(
          "INSERT INTO installed_extensions (id, kind, name, publisher, version, manifest_json, status, installed_at, updated_at, failure_reason) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'enabled', ?, ?, NULL)",
        ).run(id, m.kind, m.name, m.publisher, m.version, canonicalManifest, now, now);
        insertAudit(db, now, "extension-installed", {
          id,
          kind: m.kind,
          name: m.name,
          publisher: m.publisher,
          version: m.version,
        });
        report.installed.push(id);
      } else {
        // Re-canonicalize the stored snapshot so a row written with a
        // different stringification routine still compares stably.
        const storedCanonical = canonicalJson(JSON.parse(existing.manifest_json));
        const changed = storedCanonical !== canonicalManifest || existing.status !== "enabled";
        if (changed) {
          db.prepare(
            "UPDATE installed_extensions SET kind = ?, name = ?, publisher = ?, version = ?, manifest_json = ?, status = 'enabled', updated_at = ?, failure_reason = NULL WHERE id = ?",
          ).run(m.kind, m.name, m.publisher, m.version, canonicalManifest, now, id);
          insertAudit(db, now, "extension-manifest-changed", {
            id,
            kind: m.kind,
            name: m.name,
            publisher: m.publisher,
            version: m.version,
          });
          report.changed.push(id);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* tx may already be terminated */ }
      throw err;
    }
  }

  // Removal sweep — one tx for the whole batch. Empty toRemove set is a
  // no-op (no tx opened, no audit fan-out).
  const enabledRows = db
    .prepare("SELECT id, kind, name, publisher, version FROM installed_extensions WHERE status = 'enabled'")
    .all() as { id: string; kind: string; name: string; publisher: string; version: string }[];
  const toRemove = enabledRows.filter((r) => !discoveredIds.has(r.id));
  if (toRemove.length > 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of toRemove) {
        db.prepare(
          "UPDATE installed_extensions SET status = 'disabled', failure_reason = 'removed', updated_at = ? WHERE id = ?",
        ).run(now, r.id);
        insertAudit(db, now, "extension-removed", {
          id: r.id,
          kind: r.kind,
          name: r.name,
          publisher: r.publisher,
          version: r.version,
          failure_reason: "removed",
        });
        report.removed.push(r.id);
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* tx may already be terminated */ }
      throw err;
    }
  }

  return report;
}

// Handle a failed discovery. Two cases:
//   1. partial.kind + partial.name extracted → write a real
//      installed_extensions row with status='failed' + the audit row
//      in one tx (operator can find the broken extension via list).
//   2. otherwise → emit audit only (the table's kind CHECK constraint
//      refuses unknown kind; the failure is still visible in the audit
//      timeline + the ReconciliationReport).
// Either way the failure lands in report.failed and discoveredIds gains
// the id so the removal sweep does not also sweep this failure.
function handleFailed(
  db: DatabaseSync,
  now: NowToken,
  d: DiscoveredManifest,
  partial: PartialIdentity,
  failure_reason: string,
  report: ReconciliationReport,
  discoveredIds: Set<ExtensionId>,
): void {
  const writable = partial.kind !== null && partial.name !== null;
  const id: ExtensionId = writable
    ? idFromKindName(partial.kind as string, partial.name as string)
    : `unknown:${d.path}`;
  discoveredIds.add(id);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (writable) {
      const kind = partial.kind as ExtensionKind;
      const name = partial.name as string;
      const publisher = partial.publisher ?? "";
      const version = partial.version ?? "";
      const manifestJson = typeof d.raw === "object" && d.raw !== null
        ? canonicalJson(d.raw)
        : "{}";
      const existing = db
        .prepare("SELECT id FROM installed_extensions WHERE id = ?")
        .get(id) as { id: string } | undefined;
      if (existing === undefined) {
        db.prepare(
          "INSERT INTO installed_extensions (id, kind, name, publisher, version, manifest_json, status, installed_at, updated_at, failure_reason) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)",
        ).run(id, kind, name, publisher, version, manifestJson, now, now, failure_reason);
      } else {
        db.prepare(
          "UPDATE installed_extensions SET kind = ?, name = ?, publisher = ?, version = ?, manifest_json = ?, status = 'failed', updated_at = ?, failure_reason = ? WHERE id = ?",
        ).run(kind, name, publisher, version, manifestJson, now, failure_reason, id);
      }
    }
    insertAudit(db, now, "extension-load-failed", {
      id,
      kind: partial.kind,
      name: partial.name,
      publisher: partial.publisher,
      version: partial.version,
      failure_reason,
    });
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* tx may already be terminated */ }
    throw err;
  }
  report.failed.push({ id, failure_reason });
}

// ============================================================================
// discoverExtensions — filesystem wrapper
// ============================================================================

const SUBDIRS: readonly string[] = ["bundles", "providers", "mcp-clients"];
const MANIFEST_PREFERENCES: readonly string[] = ["manifest.js", "manifest.json", "manifest.ts"];

// Glob `<workspace_root>/packages/{bundles,providers,mcp-clients}/*/
// manifest.{js,json,ts}` and load each match. Preference order is
// compiled .js → declarative .json → .ts source (the last form
// requires a TS-aware Node loader; without one, dynamic import fails
// and the entry surfaces as a load_error which the core treats as a
// load failure).
export async function discoverExtensions(opts: {
  workspace_root: string;
  project_dir: string;
  now: NowToken;
}): Promise<ReconciliationReport> {
  const { workspace_root, project_dir, now } = opts;
  const manifests: DiscoveredManifest[] = [];
  const packagesRoot = join(workspace_root, "packages");
  if (existsSync(packagesRoot)) {
    for (const sub of SUBDIRS) {
      const subDir = join(packagesRoot, sub);
      if (!existsSync(subDir)) continue;
      let entries: string[];
      try {
        entries = readdirSync(subDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const pkgDir = join(subDir, entry);
        let isDir = false;
        try { isDir = statSync(pkgDir).isDirectory(); } catch { /* skip */ }
        if (!isDir) continue;
        const found = findManifestFile(pkgDir);
        if (found === null) continue;
        manifests.push(await loadManifest(found));
      }
    }
  }
  return reconcileExtensions({ manifests, project_dir, now });
}

function findManifestFile(pkgDir: string): string | null {
  for (const candidate of MANIFEST_PREFERENCES) {
    const p = join(pkgDir, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

async function loadManifest(path: string): Promise<DiscoveredManifest> {
  const lower = basename(path).toLowerCase();
  if (lower.endsWith(".json")) {
    try {
      const text = readFileSync(path, "utf8");
      const raw = JSON.parse(text);
      return { path, raw };
    } catch (err) {
      return { path, raw: undefined, load_error: (err as Error).message };
    }
  }
  try {
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    if (mod.default === undefined) {
      return { path, raw: mod, load_error: "default export missing" };
    }
    return { path, raw: mod.default };
  } catch (err) {
    return { path, raw: undefined, load_error: (err as Error).message };
  }
}
