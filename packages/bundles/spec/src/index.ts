// Package surface for the research / specification bundle.
//
// The default export is the bundle the loader registers; the named
// exports re-export the installed manifest (so a host can reconcile it
// into a project before loading) and let tests reach the invariant +
// resolver internals.

export { default } from "./bundle.js";
export { default as specManifest } from "../manifest.js";
export { specPolicyResolver } from "./policy-resolver.js";
export {
  specBundleInvariants,
  invSpec201,
  invSafetyFloorApproval,
} from "./invariants.js";
