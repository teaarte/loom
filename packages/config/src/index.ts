// Public surface of `@loomfsm/config` — loom's control layer. A leaf: it
// depends on nothing else in loom and names no domain. The CLI reads it today;
// a server config-API and a UI read the SAME resolver later.

export type {
  ModelRef,
  BundleModelConfig,
  NotifyConfig,
  ResilienceConfig,
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
} from "./schema.js";

export {
  isSecretRef,
  secretRefName,
  resolveSecret,
  resolveMaybeRef,
  maskSecret,
} from "./secrets.js";

export {
  AUTO_BACKEND,
  BACKEND_CAPABILITIES,
  knownBackends,
  parseModelRef,
  validatePair,
  type ParsedModelRef,
  type ValidatePairResult,
} from "./capabilities.js";

export {
  resolveConfig,
  mergeConfig,
  buildEnvOverlay,
  type ResolveConfigOptions,
} from "./resolve.js";

export {
  bundleAgentMap,
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
