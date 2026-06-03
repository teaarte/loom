import { defineManifest } from "@loomfsm/kernel";

// The installed manifest the loader reconciles before this bundle loads.
// Same curated-publisher + kernel-api discipline the first bundle uses;
// the capability list declares exactly the observable behaviors this
// bundle's runtime shape demands, so the loader refuses any surface the
// manifest does not name. `invariant.bundle` covers the auto-approval
// safety floor; `hook.side_effect` covers the one post-commit observer.
// No event-position steps and no migrations directory ship, so
// `stage.event` and `migration.bundle` are intentionally absent.
export default defineManifest({
  manifest_version: "1.0",
  name: "spec",
  display_name: "Research & specification bundle",
  description:
    "Idea → research → draft → review → finalize authoring flow. A second domain whose phases, gate roles, and output shapes differ from the code bundle on purpose.",
  version: "0.0.0",
  kind: "bundle",
  publisher: "@loom",
  capabilities: [
    "state.read",
    "state.write.decisions",
    "state.write.bundle_state",
    "state.write.findings",
    "state.write.gates",
    "state.write.agent_verdicts",
    "hook.side_effect",
    "invariant.bundle",
  ],
  requires: { kernel_api: "^3.0" },
});
