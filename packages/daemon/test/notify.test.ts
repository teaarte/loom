// The notify core — generic webhook delivery, the combinators (fan-out,
// allowlist filter, project-id stamp), and the best-effort contract: a channel
// failure (non-ok HTTP, a throwing fetch, a timeout) is swallowed into
// `onError` and the promise still resolves. Offline: the HTTP channel runs over
// an injected fake `fetch`, never the network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMemoryNotifier,
  filterEvents,
  multiNotifier,
  nullNotifier,
  webhookNotifier,
  withProjectId,
  type FetchLike,
  type Notifier,
  type NotifyEvent,
} from "../src/index.js";

const TS = "2026-06-02T10:00:00.000Z";

function ev(over: Partial<NotifyEvent> = {}): NotifyEvent {
  return { event: "complete", task_id: "t1", ts: TS, ...over };
}

interface Captured {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function recordingFetch(into: Captured[], res = { ok: true, status: 200 }): FetchLike {
  return async (url, init) => {
    into.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    return res;
  };
}

describe("notify — webhook posts the generic event as JSON", () => {
  it("POSTs the whole event to the url with a json content-type", async () => {
    const calls: Captured[] = [];
    const n = webhookNotifier({ url: "https://hook.example/loom", fetchImpl: recordingFetch(calls) });
    const event = ev({ verdict: "accepted", branch: "loom/t1", message: "done" });
    await n.notify(event);

    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c?.url, "https://hook.example/loom");
    assert.equal(c?.method, "POST");
    assert.equal(c?.headers?.["content-type"], "application/json");
    assert.deepEqual(JSON.parse(c?.body ?? "{}"), event);
  });

  it("swallows a non-ok HTTP response (onError, never throws)", async () => {
    const errors: string[] = [];
    const n = webhookNotifier({
      url: "https://hook.example/loom",
      fetchImpl: recordingFetch([], { ok: false, status: 500 }),
      onError: (m) => errors.push(m),
    });
    await n.notify(ev()); // must resolve
    assert.deepEqual(errors, ["webhook: HTTP 500"]);
  });

  it("swallows a throwing fetch (onError, never throws)", async () => {
    const errors: string[] = [];
    const throwingFetch: FetchLike = async () => {
      throw new Error("connection refused");
    };
    const n = webhookNotifier({
      url: "https://hook.example/loom",
      fetchImpl: throwingFetch,
      onError: (m) => errors.push(m),
    });
    await n.notify(ev()); // must resolve
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /^webhook: connection refused$/);
  });

  it("times out a hung endpoint and resolves (does not block the loop)", async () => {
    const errors: string[] = [];
    // A fetch that never resolves on its own; only the abort signal ends it.
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const n = webhookNotifier({
      url: "https://hook.example/loom",
      fetchImpl: hangingFetch,
      timeout_ms: 10,
      onError: (m) => errors.push(m),
    });
    await n.notify(ev()); // resolves once the 10ms timeout aborts the fetch
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /^webhook: /);
  });
});

describe("notify — multiNotifier fans out best-effort", () => {
  it("delivers to every channel; a throwing one does not silence the others", async () => {
    const a = createMemoryNotifier();
    const b = createMemoryNotifier();
    const throwing: Notifier = {
      notify: async () => {
        throw new Error("boom");
      },
    };
    const multi = multiNotifier([throwing, a, b]);
    await multi.notify(ev()); // must not reject despite the throwing child
    assert.equal(a.events.length, 1);
    assert.equal(b.events.length, 1);
  });
});

describe("notify — filterEvents applies the allowlist", () => {
  it("passes only allowed events through to the inner sink", async () => {
    const mem = createMemoryNotifier();
    const filtered = filterEvents(mem, ["complete", "failed"]);
    await filtered.notify(ev({ event: "complete" }));
    await filtered.notify(ev({ event: "parked" }));
    await filtered.notify(ev({ event: "failed" }));
    await filtered.notify(ev({ event: "retry" }));
    assert.deepEqual(
      mem.events.map((e) => e.event),
      ["complete", "failed"],
    );
  });
});

describe("notify — withProjectId stamps the fleet id", () => {
  it("merges project_id onto every event without mutating the original", async () => {
    const mem = createMemoryNotifier();
    const stamped = withProjectId(mem, "proj-abc");
    const original = ev();
    await stamped.notify(original);
    assert.equal(mem.events[0]?.project_id, "proj-abc");
    assert.equal(original.project_id, undefined); // the caller's object is untouched
  });
});

describe("notify — nullNotifier / memory", () => {
  it("nullNotifier resolves and does nothing", async () => {
    await nullNotifier.notify(ev()); // no throw
  });
  it("memory notifier captures the stream", async () => {
    const mem = createMemoryNotifier();
    await mem.notify(ev({ event: "parked" }));
    assert.equal(mem.events.length, 1);
    assert.equal(mem.events[0]?.event, "parked");
  });
});
