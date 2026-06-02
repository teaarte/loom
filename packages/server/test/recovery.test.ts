// Crash/restart recovery, fleet-wide: a control plane re-reads the durable
// registered-project set on start and re-attaches each project, and each
// watcher's own restart-head finishes whatever was in flight. Here a task is
// left PARKED on a gate when the first control plane stops; a second control
// plane over the same state dir re-attaches it and an answer drives it home.
// Real store, no mocked DB.

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { startControlPlane, readRegisteredProjects } from "../src/index.js";
import { cleanup, freshProject, gateRegistry, recordingExecutor, tempStateDir } from "./fixtures.js";
import type { Registry } from "@loomfsm/kernel";

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

describe("recovery — restart re-attaches the fleet from the durable set", () => {
  it("re-attaches a parked project and an answer drives it to complete", async () => {
    const stateDir = tempStateDir();
    const dir = await freshProject("loom-server-recover-");
    const registries = new Map<string, Registry>([[dir, gateRegistry()]]);
    const resolveRegistry = (d: string): Registry =>
      registries.get(d) ?? registries.get(resolve(d)) ?? gateRegistry();
    const buildExecutor = (): ReturnType<typeof recordingExecutor> => recordingExecutor([]);

    try {
      // ----- control plane #1: register the project, submit, let it park -----
      const c1 = new AbortController();
      const cp1 = await startControlPlane({
        stateDir,
        host: "127.0.0.1",
        port: 0,
        projects: [dir],
        resolveRegistry,
        buildExecutor,
        signal: c1.signal,
        ...FAST,
      });
      const base1 = `http://127.0.0.1:${cp1.port}`;
      const id = cp1.attached[0]?.id as string;
      assert.ok(id);

      await fetch(`${base1}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: id, task: "needs a human" }),
      });
      await until(async () => {
        const r = (await (await fetch(`${base1}/projects/${id}`)).json()) as any;
        return r?.status?.parked_gate ?? null;
      }, "task to park before shutdown");

      // The durable set recorded the project.
      assert.deepEqual(readRegisteredProjects(stateDir), [dir]);

      // ----- kill control plane #1 -----
      c1.abort();
      await cp1.closed;

      // ----- control plane #2: same state dir, NO explicit projects -----
      const c2 = new AbortController();
      const cp2 = await startControlPlane({
        stateDir,
        host: "127.0.0.1",
        port: 0,
        resolveRegistry,
        buildExecutor,
        signal: c2.signal,
        ...FAST,
      });
      const base2 = `http://127.0.0.1:${cp2.port}`;
      try {
        // It re-attached the project purely from the durable set.
        assert.equal(cp2.attached.length, 1);
        assert.equal(cp2.attached[0]?.id, id);

        const parked = await until(async () => {
          const r = (await (await fetch(`${base2}/projects/${id}`)).json()) as any;
          return r?.status?.parked_gate ?? null;
        }, "re-attached task to be parked");

        await fetch(`${base2}/projects/${id}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ gate_event_id: parked.gate_event_id, decision: "accept" }),
        });

        const done = await until(async () => {
          const r = (await (await fetch(`${base2}/projects/${id}`)).json()) as any;
          return r?.status?.status === "completed" ? r : null;
        }, "re-attached task to complete");
        assert.ok(done);
      } finally {
        c2.abort();
        await cp2.closed;
      }
    } finally {
      cleanup(dir);
    }
  });
});
