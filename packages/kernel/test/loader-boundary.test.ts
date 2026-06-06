// Loader boundary guard — the tick-vs-build split's durable assertion.
//
// The build-time registry-assembly machinery (loadBundle, reconcileExtensions,
// discoverExtensions, createProviderRouter) lives in @loomfsm/loader, NOT the
// kernel. The substrate keeps only resolveSpawnModel — the replay-critical
// tick-time reader both spawn paths call. If any moved symbol reappears on the
// kernel barrel, the runtime story's auditable surface has silently regrown the
// build-time machinery and this test fails.
//
// The fact this whole kernel suite runs and replays with NO @loomfsm/loader
// built is the live proof the tick path needs none of it — the kernel package
// declares no dependency (or devDependency) on the loader.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as kernel from "../src/index.js";

describe("loader boundary — the kernel barrel carries no build-time assembly", () => {
  const moved = [
    "loadBundle",
    "reconcileExtensions",
    "discoverExtensions",
    "createProviderRouter",
  ];
  for (const name of moved) {
    it(`does not re-export ${name} (moved to @loomfsm/loader)`, () => {
      assert.equal(
        (kernel as Record<string, unknown>)[name],
        undefined,
        `${name} must not ride on the kernel barrel — it belongs to the build-time loader`,
      );
    });
  }

  it("keeps resolveSpawnModel — the replay-critical tick-time reader stays in the substrate", () => {
    assert.equal(typeof (kernel as Record<string, unknown>)["resolveSpawnModel"], "function");
  });
});
