// Public surface of `@loomfsm/config` — loom's control layer. A leaf: it
// depends on nothing else in loom and names no domain. The CLI reads it today;
// a server config-API and a UI read the SAME resolver later.

export type {
  ModelRef,
  BundleModelConfig,
  NotifyConfig,
  ResilienceConfig,
  BackendCredentialConfig,
  LoomConfig,
  SecretsFile,
  WorkspaceEntry,
  AgentRosterEntry,
  BundleRoster,
  ResolvedConfig,
} from "./types.js";

export {
  resolveLoomHome,
  configPath,
  secretsPath,
  workspacePath,
  projectConfigPath,
} from "./paths.js";

export {
  readGlobalConfig,
  writeGlobalConfig,
  readProjectConfig,
  writeProjectConfig,
  readSecrets,
  writeSecrets,
  readWorkspace,
  writeWorkspace,
} from "./stores.js";

export {
  LoomConfigSchema,
  SecretsFileSchema,
  WorkspaceFileSchema,
  parseLoomConfig,
  parseSecretsFile,
  parseWorkspaceFile,
  configJsonSchema,
} from "./schema.js";

export {
  isSecretRef,
  secretRefName,
  resolveSecret,
  resolveMaybeRef,
  maskSecret,
} from "./secrets.js";

export { maskConfig, reconcileMaskedConfig } from "./redact.js";

export {
  AUTO_BACKEND,
  BACKEND_CAPABILITIES,
  knownBackends,
  parseModelRef,
  validatePair,
  validateBackendFamily,
  type ParsedModelRef,
  type ValidatePairResult,
} from "./capabilities.js";

export {
  resolveBackend,
  type ResolveBackendInput,
  type ResolveBackendResult,
} from "./backend.js";

export {
  BACKEND_CREDENTIAL,
  resolveBackendCredential,
  type ResolvedCredential,
  type ResolveCredentialOptions,
} from "./credentials.js";

export {
  resolveConfig,
  mergeConfig,
  buildEnvOverlay,
  type ResolveConfigOptions,
} from "./resolve.js";

export {
  bundleAgentMap,
  bundleAgentFallbacks,
  resolveModelRef,
  resolveBundleModels,
  type ResolvedModel,
} from "./model-map.js";

export {
  listProjects,
  getProject,
  addProject,
  removeProject,
  touchProject,
  type RemoveResult,
} from "./workspace.js";
