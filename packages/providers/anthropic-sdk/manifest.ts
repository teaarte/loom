import { defineManifest } from "@loomfsm/kernel";

export default defineManifest({
  manifest_version: "1.0",
  name: "anthropic-sdk",
  display_name: "Anthropic SDK provider",
  description:
    "Direct-API provider for Claude models, with prompt caching and idempotent spawn keys.",
  version: "0.0.0",
  kind: "provider",
  publisher: "@loom",
  capabilities: ["llm.spawn"],
  requires: { kernel_api: "^3.0" },
});
