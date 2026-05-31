import { defineManifest } from "@loomfsm/kernel";

export default defineManifest({
  manifest_version: "1.0",
  name: "claude-code-shuttle",
  display_name: "Claude Code shuttle provider",
  description:
    "Shuttle-pattern provider that hands the spawn back to the host so the running Claude Code session executes the agent.",
  version: "0.0.0",
  kind: "provider",
  publisher: "@loom",
  capabilities: ["llm.spawn"],
  requires: { kernel_api: "^3.0" },
});
