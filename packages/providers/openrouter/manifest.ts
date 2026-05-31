import { defineManifest } from "@loomfsm/kernel";

export default defineManifest({
  manifest_version: "1.0",
  name: "openrouter",
  display_name: "OpenRouter unified-router provider",
  description:
    "Multi-model provider that proxies the OpenAI chat-completions API surface via OpenRouter, with usage reporting.",
  version: "0.0.0",
  kind: "provider",
  publisher: "@loom",
  capabilities: ["llm.spawn"],
  requires: { kernel_api: "^3.0" },
});
