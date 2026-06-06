// Build-time loader support surface — NOT the plugin API.
//
// These are kernel internals the build-time assembly layer (`@loomfsm/loader`)
// needs to reconcile extensions and assemble a Registry: the raw pooled
// connection borrow + schema version the reconcile pass runs against, and the
// vocabulary helpers its lifecycle-audit writes validate through. They sit
// behind a dedicated subpath so the main `@loomfsm/kernel` barrel stays the
// narrow plugin surface bundles see — a bundle reaching for `withConnection`
// here is as out-of-bounds as reaching for the raw `Transaction`.

export { KERNEL_SCHEMA_VERSION, withConnection } from "./state/db.js";
export { assertVocabKnown, kernelDefaultVocabularies } from "./vocabularies.js";
