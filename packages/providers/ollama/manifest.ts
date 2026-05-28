import { defineManifest } from "@loom/kernel";

export default defineManifest({
  manifest_version: "1.0",
  name: "ollama",
  display_name: "Ollama local-model provider",
  description:
    "Local-model provider that speaks to a running Ollama instance via the official ollama npm client.",
  version: "0.0.0",
  kind: "provider",
  publisher: "@loom",
  capabilities: ["llm.spawn"],
  requires: { kernel_api: "^3.0" },
});
