// The OpenRouter model-list filter — `/providers/openrouter/models` shows only
// tool-capable models (the dropdown feeds an agentic agent), keeping models whose
// capability the API does not expose. Pure parse, no network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseOpenRouterModels } from "../src/config-routes.js";

describe("parseOpenRouterModels — tool-capability filter", () => {
  it("drops models that declare supported_parameters WITHOUT tools", () => {
    const r = parseOpenRouterModels([
      { id: "vendor/tooled", supported_parameters: ["tools", "temperature"] },
      { id: "vendor/no-tools", supported_parameters: ["temperature"] },
    ]);
    assert.deepEqual(r.models, ["openrouter:vendor/tooled"]);
    assert.match(r.reason ?? "", /tool-capable of 2/);
  });

  it("keeps models whose capability is unknown (no supported_parameters field)", () => {
    const r = parseOpenRouterModels([
      { id: "vendor/unknown" },
      { id: "vendor/tooled", supported_parameters: ["tools"] },
    ]);
    assert.deepEqual(r.models, ["openrouter:vendor/unknown", "openrouter:vendor/tooled"]);
    // Nothing dropped → no reason annotation.
    assert.equal(r.reason, undefined);
  });

  it("ignores entries with no string id", () => {
    const r = parseOpenRouterModels([{ supported_parameters: ["tools"] }, { id: 42 } as never]);
    assert.deepEqual(r.models, []);
  });
});
