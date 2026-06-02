// Package surface for the code bundle.
//
// The default export is the bundle the loader registers; the named
// exports let a host wire the sandbox path-rules into the tool context
// and let tests reach the invariant + resolver internals.

export { default } from "./bundle.js";
// The installed manifest, re-exported so a host can reconcile it into a
// project's extension table before loading the bundle (the loader refuses
// a bundle whose manifest row is absent).
export { default as codeManifest } from "../manifest.js";
export { CODE_BUNDLE_SENSITIVE_PATH_RULES } from "./sandbox-rules.js";
export { codePolicyResolver } from "./policy-resolver.js";
// The bundle-owned build-stack descriptor. Held here, not in the kernel, so
// the substrate names no code-domain field; downstream consumers (and the
// sandboxed executor ahead) read it from `bundle_state.stack`.
export { isStackInfo, type StackInfo } from "./stack.js";
export {
  codeBundleInvariants,
  invCode101,
  invCode102,
  invCode103,
  invCode104,
  invLintClean,
  invTestsPass,
  invTypecheckClean,
  invSafetyFloorFinal,
} from "./invariants.js";
