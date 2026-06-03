// Outbound notifications — an opt-in push sink the supervisor fires on the
// events a human cares about while away from the terminal: a task reaching
// terminal (`complete`), parking on a human gate (`parked`), or escalating
// (`failed`), plus opt-in operational signals (`rate-limit-wait`,
// `watch-park`, `retry`). It is the OUTBOUND mirror of the inbound intake
// adapters: intake feeds work IN, notify tells you what happened.
//
// It is a TRANSPORT-layer sink, wired alongside the audit `DaemonLogger` and
// fired off the same lifecycle transitions the supervisor already observes —
// NO kernel surface, NO new hard runtime dep. It is generic by EVENT and
// domain-BLIND: the payload carries a verdict / gate name / error code / branch
// but never what a bundle's flow MEANS (the daemon-leak gate stays green).
//
// Every channel is BEST-EFFORT: a delivery failure or timeout is swallowed
// (surfaced through an optional `onError`), never thrown — a flaky webhook must
// never take the supervisor down. The same discipline the intake adapter takes
// when a `getUpdates` blip just retries on the next loop.

// The generic, domain-blind event the supervisor emits. `task_id` is always
// present (may be null on a slot with no id yet); the rest are per-event:
// `verdict`+`branch` on complete, `gate` on parked, `code` on the error/wait
// signals, `message` a human-ish line, `project_id` stamped fleet-wide by the
// multi-project registry. `ts` is an ambient-clock stamp (transport, outside
// the kernel's replay graph).
export type NotifyEventName =
  | "complete"
  | "parked"
  | "failed"
  | "rate-limit-wait"
  | "watch-park"
  | "retry";

export interface NotifyEvent {
  event: NotifyEventName;
  task_id: string | null;
  project_id?: string;
  verdict?: string;
  gate?: string;
  code?: string;
  branch?: string;
  message?: string;
  ts: string;
}

// The injectable sink. One method, returns a promise that NEVER rejects for the
// stock channels (a custom impl that throws is caught at the supervisor's
// `safeNotify` boundary).
export interface Notifier {
  notify(event: NotifyEvent): Promise<void>;
}

// The events delivered by default (the rest are opt-in via an allowlist). The
// three a walk-away operator must learn about: a task finished, parked for a
// decision, or gave up.
export const DEFAULT_NOTIFY_EVENTS: readonly NotifyEventName[] = ["complete", "parked", "failed"];

// Default per-delivery timeout. Long enough for a slow webhook, short enough
// that a black-holed endpoint never wedges the loop for long.
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

// A minimal structural `fetch` so the HTTP channels stay dependency-free and a
// test injects a fake (no live network). Node's global `fetch` satisfies it.
// Narrowed to what notify needs (a POST + a `signal` for the timeout, and only
// `ok`/`status` off the response) — deliberately distinct from the inbound
// intake adapter's `FetchLike`, which reads the response body.
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

// Node's global fetch, adapted to `FetchLike`. A thin wrapper (not a cast) so
// the structural narrowing is checked by the compiler.
const nodeFetch: FetchLike = (url, init) => fetch(url, init);

// ----- core channels ------------------------------------------------------

export interface WebhookNotifierOptions {
  url: string;
  fetchImpl?: FetchLike;
  timeout_ms?: number;
  onError?: (message: string) => void;
}

// The universal channel: POST the whole generic `NotifyEvent` as JSON. One impl
// downstream consumers (a serverless function, an n8n hook, a homegrown bot)
// can shape however they like — loom stays domain-blind on the wire.
export function webhookNotifier(opts: WebhookNotifierOptions): Notifier {
  const fetchImpl = opts.fetchImpl ?? nodeFetch;
  const timeout = opts.timeout_ms ?? DEFAULT_NOTIFY_TIMEOUT_MS;
  return {
    notify: (event) =>
      postBestEffort(fetchImpl, opts.url, JSON.stringify(event), timeout, "webhook", opts.onError),
  };
}

// A no-op sink — the default when nothing is configured (all channels off).
export const nullNotifier: Notifier = {
  notify: async () => {},
};

// An in-memory sink — tests assert on the captured event stream.
export function createMemoryNotifier(): Notifier & { events: NotifyEvent[] } {
  const events: NotifyEvent[] = [];
  return {
    events,
    notify: async (event) => {
      events.push(event);
    },
  };
}

// ----- combinators --------------------------------------------------------

// Fan-out across channels — each delivered INDEPENDENTLY and best-effort:
// `allSettled` so one channel's failure (or a throwing custom notifier) never
// silences the others, and the combined promise never rejects.
export function multiNotifier(children: Notifier[]): Notifier {
  if (children.length === 1 && children[0] !== undefined) return children[0];
  return {
    notify: async (event) => {
      await Promise.allSettled(children.map((c) => c.notify(event)));
    },
  };
}

// The allowlist filter — drops events not in `allowed` before they reach the
// inner sink. This is where default-vs-opt-in lives: the supervisor emits EVERY
// transition unconditionally, the filter decides what actually ships, so the
// supervisor needs no taxonomy knowledge.
export function filterEvents(inner: Notifier, allowed: Iterable<NotifyEventName>): Notifier {
  const set = new Set(allowed);
  return {
    notify: async (event) => {
      if (set.has(event.event)) await inner.notify(event);
    },
  };
}

// Stamp a `project_id` onto every event — the multi-project control plane wraps
// each project's notifier with this so a fleet-wide channel can tell projects
// apart. A single-project daemon omits it (the field stays absent).
export function withProjectId(inner: Notifier, project_id: string): Notifier {
  return {
    notify: (event) => inner.notify({ ...event, project_id }),
  };
}

// ----- internals (shared by notify-channels.ts; not part of the public barrel)

// POST a JSON body, swallowing every failure into `onError`. A per-delivery
// timeout via AbortController so a hung endpoint cannot block the loop past
// `timeoutMs`. Never throws.
export async function postBestEffort(
  fetchImpl: FetchLike,
  url: string,
  body: string,
  timeoutMs: number,
  channel: string,
  onError?: (message: string) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) onError?.(`${channel}: HTTP ${res.status}`);
  } catch (err) {
    onError?.(`${channel}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
