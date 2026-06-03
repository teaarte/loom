// Fleet-wide notify wiring: the control plane forwards a `makeNotifier` to every
// project's watcher, and the registry stamps each project's id onto its events
// (so a shared channel can tell the fleet apart). Real store, real control
// plane, an in-memory notifier captures the stream — submit a task over HTTP,
// drive it to complete, assert the complete event carries the project id.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { createMemoryNotifier } from "@loomfsm/daemon";
import type { Registry } from "@loomfsm/kernel";

import { startControlPlane } from "../src/index.js";
import { cleanup, freshProject, recordingExecutor, spawnRegistry, tempStateDir } from "./fixtures.js";

const FAST = { watch_idle_ms: 15, wake: { poll_base_ms: 15, poll_factor: 1, poll_ceiling_ms: 40 } };

async function until<T>(fn: () => Promise<T | null | undefined | false>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("notify wiring — fleet-wide, project_id stamped", () => {
  it("fires a complete event stamped with the project id", async () => {
    const stateDir = tempStateDir();
    const dir = await freshProject("loom-server-notify-");
    const registries = new Map<string, Registry>([[dir, spawnRegistry()]]);
    const resolveRegistry = (d: string): Registry =>
      registries.get(d) ?? registries.get(resolve(d)) ?? spawnRegistry();
    const notifier = createMemoryNotifier();

    const c = new AbortController();
    const cp = await startControlPlane({
      stateDir,
      host: "127.0.0.1",
      port: 0,
      projects: [dir],
      resolveRegistry,
      buildExecutor: () => recordingExecutor([]),
      makeNotifier: () => notifier,
      signal: c.signal,
      ...FAST,
    });
    const base = `http://127.0.0.1:${cp.port}`;
    const id = cp.attached[0]?.id as string;
    assert.ok(id);

    try {
      await fetch(`${base}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: id, task: "go" }),
      });
      await until(async () => {
        const r = (await (await fetch(`${base}/projects/${id}`)).json()) as {
          status?: { status?: string };
        };
        return r.status?.status === "completed" ? r : null;
      }, "task to complete");

      const completes = notifier.events.filter((e) => e.event === "complete");
      assert.ok(completes.length >= 1, "a complete event was fired");
      assert.equal(completes[0]?.project_id, id, "the event is stamped with the project id");
    } finally {
      c.abort();
      await cp.closed;
      cleanup(dir);
    }
  });
});
