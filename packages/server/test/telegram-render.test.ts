// The pure render layer of the bot — keyboards, the callback codec, the text
// views, and chunking. No network, no state: input -> string / keyboard. These
// also pin the DOMAIN-BLINDNESS property: a made-up gate / agent / model name
// flows through verbatim, proving the renderers switch on no known vocabulary.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectStatusView } from "../src/read-model.js";
import type { ShipWire, TraceWire } from "../src/intake/loom-client.js";
import {
  chunk,
  completionText,
  elapsed,
  encodeCallback,
  gateKeyboard,
  parseCallback,
  pickerKeyboard,
  projectTitle,
  shipResultText,
  statusText,
} from "../src/intake/telegram-render.js";

function status(over: Partial<ProjectStatusView> = {}): ProjectStatusView {
  return {
    project_dir: "/repos/demo",
    has_task: true,
    task_id: "t1",
    task_label: "do the thing",
    task: "do the thing",
    status: "in_progress",
    verdict: null,
    flow: { name: "main", step_index: 2 },
    active_phase: "build",
    parked_gate: null,
    pending_agents: [],
    stalled: false,
    started_at: null,
    ended_at: null,
    ...over,
  };
}

describe("telegram-render — callback codec", () => {
  it("round-trips an action with an argument", () => {
    const data = encodeCallback("ga", "gev-abc-123");
    assert.equal(data, "ga|gev-abc-123");
    assert.deepEqual(parseCallback(data), { action: "ga", arg: "gev-abc-123" });
  });

  it("round-trips a bare action and tolerates empty data", () => {
    assert.equal(encodeCallback("pl"), "pl");
    assert.deepEqual(parseCallback("pl"), { action: "pl" });
    assert.deepEqual(parseCallback(undefined), { action: "" });
  });

  it("keeps callback_data within the 64-byte Bot API limit for a real gate id", () => {
    const data = encodeCallback("gr", "gev-123e4567-e89b-12d3-a456-426614174000");
    assert.ok(Buffer.byteLength(data, "utf8") <= 64, `callback_data too long: ${data.length}`);
  });
});

describe("telegram-render — keyboards", () => {
  it("gate keyboard carries the gate_event_id on the answer buttons", () => {
    const kb = gateKeyboard("gev-9");
    const flat = kb.flat();
    assert.ok(flat.some((b) => b.callback_data === "ga|gev-9"));
    assert.ok(flat.some((b) => b.callback_data === "gr|gev-9"));
    assert.ok(flat.some((b) => b.callback_data === "gx|gev-9"));
  });

  it("picker maps each project to a select-by-index callback, titled by label/dir", () => {
    const kb = pickerKeyboard([
      { id: "a", dir: "/x/alpha" },
      { id: "b", label: "Beta", dir: "/x/b" },
    ]);
    assert.equal(kb[0]?.[0]?.text, "alpha");
    assert.equal(kb[0]?.[0]?.callback_data, "sp|0");
    assert.equal(kb[1]?.[0]?.text, "Beta");
    assert.equal(kb[1]?.[0]?.callback_data, "sp|1");
  });

  it("projectTitle prefers a label, falls back to the dir basename, then the id", () => {
    assert.equal(projectTitle({ id: "i", label: "L", dir: "/p/d" }), "L");
    assert.equal(projectTitle({ id: "i", dir: "/p/myrepo" }), "myrepo");
    assert.equal(projectTitle({ id: "i", dir: "" }), "i");
  });
});

describe("telegram-render — text views are domain-blind", () => {
  it("status echoes arbitrary gate / agent / model names as data", () => {
    const trace: TraceWire = {
      archived: false,
      summary: null,
      agents: [
        { agent: "wibble-agent", phase: "zorp", model: "vendor/x-1", tokens_in: 10, tokens_out: 5, recorded_at: "" },
      ],
    };
    const text = statusText("Demo", status({ active_phase: "zorp", parked_gate: { gate: "made-up-gate", message: "m", gate_event_id: "g" } }), trace, 0);
    // Each value the read-model supplied appears verbatim — no switch on a known
    // vocabulary, no rename.
    assert.match(text, /made-up-gate/);
    assert.match(text, /wibble-agent\/zorp/);
    assert.match(text, /vendor\/x-1/);
    assert.match(text, /15 tok/);
  });

  it("completion uses the supplied summary verbatim, else derives from agents", () => {
    const withSummary = completionText("Demo", status({ status: "completed", verdict: "accepted" }), null, "Shipped the parser rewrite.", 0);
    assert.match(withSummary, /✅/);
    assert.match(withSummary, /Shipped the parser rewrite\./);

    const derived = completionText(
      "Demo",
      status({ status: "completed", verdict: "accepted" }),
      { archived: false, summary: null, agents: [{ agent: "qq", phase: "pp", model: null, tokens_in: null, tokens_out: null, recorded_at: "" }] },
      null,
      0,
    );
    assert.match(derived, /recent work/);
    assert.match(derived, /qq\/pp/);
  });
});

describe("telegram-render — elapsed + ship result + chunk", () => {
  it("elapsed renders to the live clock while running, to the end once ended", () => {
    assert.equal(elapsed("2026-01-01T00:00:00.000Z", null, Date.parse("2026-01-01T00:01:30.000Z")), "1m 30s");
    assert.equal(elapsed("2026-01-01T00:00:00.000Z", "2026-01-01T02:05:00.000Z", 0), "2h 5m");
    assert.equal(elapsed("not-a-date", null, 0), "?");
  });

  it("ship result surfaces a clean refusal reason rather than a silent done", () => {
    const dirty: ShipWire = { id: "i", dir: "/d", merged: false, into: "main", reason: "dirty-tree" };
    const out = shipResultText("merge", dirty);
    assert.match(out, /not merged/);
    assert.match(out, /dirty/);

    const ok: ShipWire = { id: "i", dir: "/d", merged: true, branch: "loom/t1", into: "main", files_changed: ["a", "b"] };
    assert.match(shipResultText("merge", ok), /squash-merged loom\/t1 → main · 2 file/);

    const noRemote: ShipWire = { id: "i", dir: "/d", pushed: false, reason: "no-remote" };
    assert.match(shipResultText("push", noRemote), /no remote/);
  });

  it("chunk splits past the limit on newline boundaries, keeps short text whole", () => {
    assert.deepEqual(chunk("short"), ["short"]);
    const body = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    const parts = chunk(body, 4000);
    assert.equal(parts.length, 2);
    assert.ok(parts.every((p) => p.length <= 4000));
    assert.ok(parts[0]?.startsWith("a"));
    assert.ok(parts[1]?.startsWith("b"));
  });
});
