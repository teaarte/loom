// Pure splitter that shapes a spawn request into the API payload.
//
// cache_control is stamped on the LAST system block only — the prompt
// cache treats the marker as "cache everything up to and including this
// block", so per-block markers would shred the stable prefix into
// uncacheable fragments. One marker on a single system block means
// "cache the entire system prefix and reuse it across spawns whose
// system_prompt is byte-identical".
//
// The user message is the dynamic suffix; cache_control is never stamped
// on user content (the cache key is built from the prefix, not per-turn
// input).

import type { ProviderSpawnRequest } from "@loomfsm/kernel";

export interface CacheShapedPayload {
  system?: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }>;
  messages: Array<{
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  }>;
}

export function splitForCache(req: ProviderSpawnRequest): CacheShapedPayload {
  const payload: CacheShapedPayload = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: req.prompt }],
      },
    ],
  };
  if (req.system_prompt !== undefined && req.system_prompt !== "") {
    payload.system = [
      {
        type: "text",
        text: req.system_prompt,
        cache_control: { type: "ephemeral" },
      },
    ];
  }
  return payload;
}
