import { defineManifest } from "@loom/kernel";

export default defineManifest({
  manifest_version: "1.0",
  name: "code",
  display_name: "Code review & implementation bundle",
  description:
    "Multi-agent code-review / implementation flow — classifier, planner, reviewer fanout, gate, and finalize.",
  version: "0.0.0",
  kind: "bundle",
  publisher: "@loom",
  // Minimum the bundle's current structure demands at load time. As
  // event-position Steps, Hooks, Invariants, or a migrations/ directory
  // land in the bundle, this list grows in lockstep — the loader
  // refuses any runtime artifact the manifest does not declare.
  capabilities: ["state.read"],
  requires: { kernel_api: "^3.0" },
});
