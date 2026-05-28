// Bundle-loader — assembles the Registry the kernel hot-path consults
// from a Bundle declaration, enforces every declarative-shape invariant
// the FSM relies on (stage kind / agent / phase / gate-role / step-
// effect / hook DAG / auto-policy safety floor), cross-checks the
// runtime structure against the manifest snapshot the prior layer
// committed to `installed_extensions`, and refuses bundles whose source
// imports the raw kernel `Transaction` type.
//
// Why a cross-check at load time: a bundle reaching for the kernel
// `Transaction` directly bypasses the `BundleScratchTx` façade and the
// invariant-rollback boundary that goes with it; an event-position
// `StepStage` without a manifest declaration is silent indirection;
// a Hook with side-effects but no manifest capability is an undeclared
// behavior. Each refusal here gives the operator a concrete remediation
// (declare the capability, drop the import, rename the stage) at
// kernel start — never at first fire.
//
// Refusal cascade order is fixed and first-failure-wins. The order is
// chosen so the operator's debugging path moves outward from the
// substrate-installed truth (manifest row exists) through the bundle's
// declarative shape (stage / agent / phase / role) toward the deeper
// graph properties (hook DAG, auto-policy safety floor, manifest cross-
// check, source-import discipline).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { topoSortHooks } from "./hook-topo.js";
import { buildPolicyFactoryRegistry } from "./policies/index.js";
import { KernelError, openDb } from "./state/db.js";
import { buildVocabularies } from "./vocabularies.js";
import type { Bundle } from "./types/bundle.js";
import type { ExtensionManifest } from "./types/extension.js";
import type { NowToken } from "./types/now.js";
import type {
  Agent,
  Hook,
  MCPClientPlugin,
  Stage,
  StepStage,
} from "./types/plugins.js";
import type { LLMProvider } from "./types/provider.js";
import type {
  ProviderRegistry,
  Registry,
} from "./types/registry.js";
import type { PipelineState } from "./types/state.js";
import type { KernelVocabularies } from "./types/vocabulary.js";

// ============================================================================
// Public entry
// ============================================================================

export interface LoadBundleOptions {
  bundle: Bundle;
  // Absolute path to the bundle package's source root. When omitted the
  // import-scope sweep and the migrations-directory probe are skipped —
  // production wiring always passes it; tests targeting other refusal
  // rules may leave it undefined.
  bundle_source_dir?: string;
  project_dir: string;
  providers: LLMProvider[];
  mcp_clients?: MCPClientPlugin[];
  now: NowToken;
}

export async function loadBundle(opts: LoadBundleOptions): Promise<Registry> {
  const { bundle, bundle_source_dir, project_dir, providers, mcp_clients } = opts;

  // 1. BUNDLE_NOT_INSTALLED — read installed_extensions and refuse if
  //    the bundle has not passed the reconciliation cascade.
  const manifest = readInstalledManifest(project_dir, bundle.name);

  // 2..8 — declarative-shape validation against the Stage union.
  validateStages(bundle);

  // 7 (continued) — gate-role lookup against bundle + extends_vocab.
  validateGateRoles(bundle);

  // 9 — hook DAG.
  const sortedHooks = validateHookGraph(bundle);

  // 10 — auto-policy demands a resolver AND a name-matching safety-
  //      floor invariant per role.
  validateAutoPolicy(bundle);

  // 11 — vocabulary build refuses sunset contradictions.
  const vocabularies = buildVocabularies(bundle);

  // 12 — manifest-vs-runtime capability cross-check.
  validateManifestCrossCheck(bundle, manifest, bundle_source_dir);

  // 13 — bundle source must not import the raw kernel Transaction.
  if (bundle_source_dir !== undefined) {
    validateImportScope(bundle_source_dir);
  }

  // ========================================================================
  // Registry assembly — only reached when every cascade rule passed.
  // ========================================================================

  const policyFactories = buildPolicyFactoryRegistry(bundle);
  const providerRegistry = buildProviderRegistry(providers, bundle);

  const agents = new Map<string, Agent>();
  for (const a of bundle.agents) agents.set(a.name, a);

  const stages = new Map<string, Stage>();
  for (const [key, stage] of Object.entries(bundle.stages)) stages.set(key, stage);

  const flows = new Map<string, string[]>();
  for (const [name, steps] of Object.entries(bundle.flows)) flows.set(name, steps);

  const mcpMap = new Map<string, MCPClientPlugin>();
  for (const c of mcp_clients ?? []) mcpMap.set(c.name, c);

  const registry: Registry = {
    bundle,
    agents,
    stages,
    flows,
    hooks: sortedHooks,
    invariants: bundle.invariants,
    mcp_clients: mcpMap,
    providers: providerRegistry,
    policyFactories,
    vocabularies,
  };
  return registry;
}

// ============================================================================
// 1. BUNDLE_NOT_INSTALLED
// ============================================================================

interface InstalledRow {
  manifest_json: string;
  status: string;
}

function readInstalledManifest(project_dir: string, bundle_name: string): ExtensionManifest {
  const id = `bundle:${bundle_name}`;
  const db = openDb(project_dir);
  const row = db
    .prepare("SELECT manifest_json, status FROM installed_extensions WHERE id = ?")
    .get(id) as InstalledRow | undefined;

  if (row === undefined) {
    throw new KernelError({
      code: "BUNDLE_NOT_INSTALLED",
      message: `bundle '${bundle_name}' has no installed_extensions row; run discoverExtensions first`,
      detail: { expected_id: id, actual_status: null },
    });
  }
  if (row.status !== "enabled") {
    throw new KernelError({
      code: "BUNDLE_NOT_INSTALLED",
      message: `bundle '${bundle_name}' is installed but status='${row.status}'`,
      detail: { expected_id: id, actual_status: row.status },
    });
  }
  // The reconciliation layer enforces shape validation before writing,
  // so the parse is trusted to land an ExtensionManifest.
  return JSON.parse(row.manifest_json) as ExtensionManifest;
}

// ============================================================================
// 2..6 + 8. Stage-union validation
// ============================================================================

const KNOWN_STAGE_KINDS: ReadonlySet<string> = new Set([
  "spawn",
  "fanout",
  "gate",
  "step",
  "finalize",
]);

function validateStages(bundle: Bundle): void {
  const stageEntries = Object.entries(bundle.stages);
  const agentNames = new Set(bundle.agents.map((a) => a.name));
  const phaseSet = new Set<string>(bundle.phases);
  const stageKeys = new Set(stageEntries.map(([k]) => k));

  // 2. BUNDLE_STAGE_UNKNOWN_KIND
  for (const [key, stage] of stageEntries) {
    const kind = (stage as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !KNOWN_STAGE_KINDS.has(kind)) {
      throw new KernelError({
        code: "BUNDLE_STAGE_UNKNOWN_KIND",
        message: `stage '${key}' has unknown kind '${String(kind)}'`,
        detail: { stage: key, kind },
      });
    }
  }

  // 3. BUNDLE_STAGE_NAME_MISMATCH
  for (const [key, stage] of stageEntries) {
    if (stage.name !== key) {
      throw new KernelError({
        code: "BUNDLE_STAGE_NAME_MISMATCH",
        message: `stage map key '${key}' disagrees with stage.name '${stage.name}'`,
        detail: { key, name: stage.name },
      });
    }
  }

  // 4. BUNDLE_AGENT_UNKNOWN
  for (const [key, stage] of stageEntries) {
    if (stage.kind === "spawn") {
      if (!agentNames.has(stage.agent)) {
        throw new KernelError({
          code: "BUNDLE_AGENT_UNKNOWN",
          message: `spawn stage '${key}' references unknown agent '${stage.agent}'`,
          detail: { stage: key, agent: stage.agent },
        });
      }
    } else if (stage.kind === "fanout") {
      for (const a of stage.agents) {
        if (!agentNames.has(a)) {
          throw new KernelError({
            code: "BUNDLE_AGENT_UNKNOWN",
            message: `fanout stage '${key}' references unknown agent '${a}'`,
            detail: { stage: key, agent: a },
          });
        }
      }
    }
  }

  // 5. BUNDLE_FLOW_UNKNOWN_STAGE
  for (const [flowName, flowEntries] of Object.entries(bundle.flows)) {
    for (const entry of flowEntries) {
      if (!stageKeys.has(entry)) {
        throw new KernelError({
          code: "BUNDLE_FLOW_UNKNOWN_STAGE",
          message: `flow '${flowName}' references unknown stage '${entry}'`,
          detail: { flow: flowName, missing_stage: entry },
        });
      }
    }
  }
  if (!Object.prototype.hasOwnProperty.call(bundle.flows, bundle.default_flow)) {
    throw new KernelError({
      code: "BUNDLE_FLOW_UNKNOWN_STAGE",
      message: `default_flow '${bundle.default_flow}' is not a registered flow`,
      detail: { default_flow: bundle.default_flow },
    });
  }

  // 6. BUNDLE_PHASE_UNKNOWN — non-finalize stages with a phase declared
  //    must name a phase the bundle ships. FinalizeStage has no phase
  //    field; StepStage.phase is optional and is checked only when set.
  for (const [key, stage] of stageEntries) {
    if (stage.kind === "finalize") continue;
    const phase = (stage as { phase?: string }).phase;
    if (phase === undefined) continue;
    if (!phaseSet.has(phase)) {
      throw new KernelError({
        code: "BUNDLE_PHASE_UNKNOWN",
        message: `stage '${key}' declares phase '${phase}' which is not in bundle.phases`,
        detail: { stage: key, phase },
      });
    }
  }

  // 8. STEP_EFFECT_COLLISION — two distinct StepStages cannot declare
  //    the same effect target (kind + discriminant value).
  validateStepEffectCollisions(stageEntries);
}

function effectKey(eff: StepStage["effects"][number]): string {
  switch (eff.kind) {
    case "state.write":
      return `state.write:${eff.field}`;
    case "decisions.set":
      return `decisions.set:${eff.key}`;
    case "bundle_state.set":
      return `bundle_state.set:${eff.path}`;
    case "finding.insert":
      return `finding.insert:${eff.phase}`;
    case "audit.emit":
      return `audit.emit:${eff.type}`;
  }
}

function validateStepEffectCollisions(stageEntries: [string, Stage][]): void {
  const seen = new Map<string, string>();
  for (const [key, stage] of stageEntries) {
    if (stage.kind !== "step") continue;
    for (const eff of stage.effects) {
      const ek = effectKey(eff);
      const prior = seen.get(ek);
      if (prior !== undefined && prior !== key) {
        throw new KernelError({
          code: "STEP_EFFECT_COLLISION",
          message: `step '${key}' and step '${prior}' both declare effect '${ek}'`,
          detail: { effect: ek, stages: [prior, key] },
        });
      }
      seen.set(ek, key);
    }
  }
}

// ============================================================================
// 7. GATE_ROLE_UNKNOWN
// ============================================================================

const KERNEL_GATE_ROLES: ReadonlySet<string> = new Set(["classify", "plan", "final"]);

function validateGateRoles(bundle: Bundle): void {
  const extraRoles = new Set<string>(bundle.extends_vocab?.gate_roles_extra ?? []);
  for (const [key, stage] of Object.entries(bundle.stages)) {
    if (stage.kind !== "gate") continue;
    const role = bundle.gate_roles[key];
    if (role === undefined) {
      throw new KernelError({
        code: "GATE_ROLE_UNKNOWN",
        message: `gate stage '${key}' has no entry in bundle.gate_roles`,
        detail: { gate: key },
      });
    }
    if (!KERNEL_GATE_ROLES.has(role) && !extraRoles.has(role)) {
      throw new KernelError({
        code: "GATE_ROLE_UNKNOWN",
        message: `gate '${key}' uses role '${role}' which is neither a kernel role nor declared in extends_vocab.gate_roles_extra`,
        detail: { gate: key, role },
      });
    }
  }
}

// ============================================================================
// 9. HOOK_CYCLE
// ============================================================================

function validateHookGraph(bundle: Bundle): Hook[] {
  const result = topoSortHooks(bundle.hooks);
  if ("cycle" in result) {
    throw new KernelError({
      code: "HOOK_CYCLE",
      message: `hook dependency cycle: ${result.cycle.join(", ")}`,
      detail: { cycle: result.cycle },
    });
  }
  return result.sorted;
}

// ============================================================================
// 10. AUTO_POLICY_INCOMPLETE
// ============================================================================

function validateAutoPolicy(bundle: Bundle): void {
  for (const role of Object.keys(bundle.default_gate_policies)) {
    if (bundle.default_gate_policies[role] !== "auto") continue;

    const missing: string[] = [];
    if (bundle.policyResolver === undefined) missing.push("policyResolver");

    const expectedName = `INV_safety_floor_${role}`;
    const hasSafetyFloor = bundle.invariants.some(
      (inv) => (inv as { name?: unknown }).name === expectedName,
    );
    if (!hasSafetyFloor) missing.push("safety_floor_invariant");

    if (missing.length > 0) {
      throw new KernelError({
        code: "AUTO_POLICY_INCOMPLETE",
        message: `role '${role}' resolves to 'auto' but the bundle is missing: ${missing.join(", ")}`,
        detail: { role, missing, expected_invariant: expectedName },
      });
    }
  }
}

// ============================================================================
// 12. MANIFEST_CAPABILITY_MISSING
// ============================================================================

function validateManifestCrossCheck(
  bundle: Bundle,
  manifest: ExtensionManifest,
  bundle_source_dir: string | undefined,
): void {
  const caps = new Set<string>(manifest.capabilities);

  // Event-position StepStage → stage.event
  for (const [key, stage] of Object.entries(bundle.stages)) {
    if (stage.kind !== "step") continue;
    if (stage.position !== "event") continue;
    if (!caps.has("stage.event")) {
      throw new KernelError({
        code: "MANIFEST_CAPABILITY_MISSING",
        message: `bundle declares event-position step '${key}' but manifest omits capability 'stage.event'`,
        detail: { capability: "stage.event", source: { stage: key } },
      });
    }
  }

  // Hooks → hook.side_effect
  if (bundle.hooks.length > 0 && !caps.has("hook.side_effect")) {
    const example = bundle.hooks[0];
    throw new KernelError({
      code: "MANIFEST_CAPABILITY_MISSING",
      message: `bundle registers hooks but manifest omits capability 'hook.side_effect'`,
      detail: {
        capability: "hook.side_effect",
        source: { hook: example?.name },
      },
    });
  }

  // Invariants → invariant.bundle
  if (bundle.invariants.length > 0 && !caps.has("invariant.bundle")) {
    const example = bundle.invariants[0];
    throw new KernelError({
      code: "MANIFEST_CAPABILITY_MISSING",
      message: `bundle registers invariants but manifest omits capability 'invariant.bundle'`,
      detail: {
        capability: "invariant.bundle",
        source: { invariant: (example as { name?: string } | undefined)?.name ?? null },
      },
    });
  }

  // migrations/ directory → migration.bundle (only when source dir given)
  if (bundle_source_dir !== undefined) {
    const migrationsDir = join(bundle_source_dir, "migrations");
    if (existsSync(migrationsDir) && statSync(migrationsDir).isDirectory()) {
      if (!caps.has("migration.bundle")) {
        throw new KernelError({
          code: "MANIFEST_CAPABILITY_MISSING",
          message: `bundle ships a migrations/ directory but manifest omits capability 'migration.bundle'`,
          detail: {
            capability: "migration.bundle",
            source: { path: migrationsDir },
          },
        });
      }
    }
  }
}

// ============================================================================
// 13. BUNDLE_IMPORT_SCOPE_VIOLATION
// ============================================================================

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".claude",
  ".turbo",
  "coverage",
]);

// Matches `import { ... Transaction ... } from "@loom/kernel..."` and
// the more direct `from "@loom/kernel/.../transaction"` path import.
// The check covers the first 200 source lines so a `Transaction` mention
// inside a long docstring or test-fixture string lower in the file does
// not surface as a false positive.
const TRANSACTION_BINDING_RE =
  /import\s+(?:type\s+)?\{[^}]*\bTransaction\b[^}]*\}\s+from\s+["']@loom\/kernel(?:\/[^"']*)?["']/;
const TRANSACTION_PATH_RE =
  /from\s+["']@loom\/kernel\/(?:[^"']*\/)?(?:transaction|state\/transaction)(?:\.[a-z]+)?["']/;

interface ImportViolation {
  path: string;
  line: number;
  match: string;
}

function validateImportScope(dir: string): void {
  const violations: ImportViolation[] = [];
  scanDir(dir, violations);
  if (violations.length > 0) {
    throw new KernelError({
      code: "BUNDLE_IMPORT_SCOPE_VIOLATION",
      message: `bundle source imports the raw kernel Transaction type — bundle code must mutate through BundleScratchTx`,
      detail: { violations },
    });
  }
}

function scanDir(dir: string, out: ImportViolation[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SCAN_SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(full);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) {
      scanDir(full, out);
      continue;
    }
    if (!isFile) continue;
    const ext = extname(entry).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    scanFile(full, out);
  }
}

function scanFile(path: string, out: ImportViolation[]): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/, 200);
  // Walk lines from the top; the import block of a source file is
  // conventionally at the head, so a top-bounded sweep avoids matches
  // inside large fixture strings further down.
  let buffer = "";
  for (let i = 0; i < lines.length; i++) {
    buffer += (lines[i] ?? "") + "\n";
  }
  if (!TRANSACTION_BINDING_RE.test(buffer) && !TRANSACTION_PATH_RE.test(buffer)) {
    return;
  }
  // Locate the first matching line for the operator's debugging note.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (TRANSACTION_BINDING_RE.test(line) || TRANSACTION_PATH_RE.test(line)) {
      out.push({ path, line: i + 1, match: line.trim() });
      return;
    }
  }
  // Multi-line import — fall back to first line that mentions Transaction.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("Transaction")) {
      out.push({ path, line: i + 1, match: line.trim() });
      return;
    }
  }
}

// ============================================================================
// ProviderRegistry — MVP minimum
// ============================================================================

function buildProviderRegistry(providers: LLMProvider[], bundle: Bundle): ProviderRegistry {
  const byName = new Map<string, LLMProvider>();
  for (const p of providers) byName.set(p.name, p);

  const defaultName = bundle.default_provider;
  const fallback = providers[0];

  function resolve(agent: string, _state: PipelineState): LLMProvider {
    if (defaultName !== undefined) {
      const picked = byName.get(defaultName);
      if (picked !== undefined) return picked;
    }
    if (fallback !== undefined) return fallback;
    throw new KernelError({
      code: "PROVIDER_NOT_FOUND",
      message: `no provider configured for agent '${agent}'`,
      detail: { agent },
    });
  }

  return {
    all: providers,
    resolve,
    health_check_all: Promise.resolve([] as { name: string; healthy: boolean; reason?: string }[]),
  };
}

// Type re-export so the barrel can surface it for external callers.
export type { KernelVocabularies };
