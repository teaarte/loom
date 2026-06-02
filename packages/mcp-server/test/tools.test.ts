import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  closeDb,
  openDb,
  reconcileExtensions,
  type DiscoveredManifest,
  type NowToken,
} from "@loomfsm/kernel";

import { createServer } from "../src/index.js";

const FIXED_NOW = "2026-01-15T10:00:00.000Z" as NowToken;

function manifest(opts: {
  kind: "bundle" | "provider" | "mcp-client";
  name: string;
  version?: string;
}): DiscoveredManifest {
  return {
    path: `/fixture/${opts.kind}/${opts.name}`,
    raw: {
      manifest_version: "1.0",
      name: opts.name,
      display_name: opts.name,
      description: `fixture ${opts.kind}`,
      version: opts.version ?? "1.0.0",
      kind: opts.kind,
      publisher: "@loom",
      capabilities: [],
      requires: { kernel_api: "^3.0.0" },
    },
  };
}

async function freshProject(opts?: {
  manifests?: DiscoveredManifest[];
  seedAudit?: boolean;
  seedPipelineState?: boolean;
}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcp-server-"));
  // openDb runs migrations on first call; the call here ensures the
  // schema lands before any reconciliation or seeding writes a row.
  openDb(dir);
  const manifests = opts?.manifests ?? [
    manifest({ kind: "provider", name: "shuttle-fixture" }),
    manifest({ kind: "bundle", name: "code-fixture" }),
  ];
  await reconcileExtensions({ manifests, project_dir: dir, now: FIXED_NOW });

  if (opts?.seedAudit === true) {
    const db = openDb(dir);
    db.exec("DELETE FROM audit");
    const ins = db.prepare(
      "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, verdict, error_class) " +
        "VALUES (?, ?, NULL, NULL, NULL, 'ok', NULL)",
    );
    ins.run("2026-01-15T10:00:01.000Z", "event-one");
    ins.run("2026-01-15T10:00:02.000Z", "event-two");
    ins.run("2026-01-15T10:00:03.000Z", "event-three");
  }

  if (opts?.seedPipelineState === true) {
    const db = openDb(dir);
    db.prepare(
      "INSERT INTO pipeline_state " +
        "(id, schema_version, project_dir, bundle, task_id, task, task_short, driver_state_id, owner_id, " +
        " status, verdict, started_at, ended_at, gate_policies, decisions, bundle_state, " +
        " files_created, files_modified, pipeline_violation, force_used) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "3.0.0",
      dir,
      "code",
      "task-fixture",
      "fix the login bug",
      "fix login bug",
      "drv-fixture",
      "ops@example",
      "in_progress",
      null,
      FIXED_NOW,
      null,
      "{}",
      "{}",
      "{}",
      "[]",
      "[]",
      null,
      0,
    );
    db.prepare(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
        "VALUES (1, ?, 0, 0, NULL, '{}')",
    ).run("standard-flow");
    db.prepare(
      "INSERT INTO pipeline_counters (id, agents_count, total_tokens_in, total_tokens_out, total_tokens_cached) " +
        "VALUES (1, 0, 0, 0, 0)",
    ).run();
  }

  return dir;
}

function cleanup(dir: string): void {
  try { closeDb(dir); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
}

describe("createServer", () => {
  it("exposes the SDK server and the direct-callable tool map", () => {
    const handle = createServer();
    assert.ok(handle.server, "createServer must return an SDK Server");
    assert.equal(typeof handle.tools.pipeline_meta, "function");
    assert.equal(typeof handle.tools.pipeline_state_get, "function");
    assert.equal(typeof handle.tools.pipeline_extensions_list, "function");
  });
});

describe("pipeline_meta", () => {
  it("returns the v3 MVP envelope with versions, transports, providers", async () => {
    const dir = await freshProject();
    try {
      const { tools } = createServer();
      const meta = await tools.pipeline_meta({ project_dir: dir });

      assert.equal(meta.protocol_version, "3.0.0");
      assert.equal(meta.plugin_api_version, "3.0.0");
      assert.equal(meta.kernel_version, "3.0.0");
      assert.equal(meta.transports.active, "mcp-server");
      assert.deepEqual(meta.transports.available, ["mcp-server"]);
      assert.equal(meta.providers.active_default, "claude-code-shuttle");
      assert.ok(meta.providers.enabled.includes("shuttle-fixture"));
      assert.deepEqual(
        meta.providers.compatible_with_client.slice().sort(),
        meta.providers.enabled.slice().sort(),
      );
      assert.equal(meta.sandbox.kind, "passthrough");
      assert.deepEqual(
        meta.bundles_available,
        [{ name: "code-fixture", version: "1.0.0" }],
      );
    } finally {
      cleanup(dir);
    }
  });

  it("providers.enabled excludes bundles AND non-enabled providers", async () => {
    // Three fixtures: one enabled provider, one bundle, one broken provider
    // (invalid manifest_version surfaces as status='failed'). The
    // enabled list must contain exactly the first; the bundle must not
    // leak in (kind filter), and the broken provider must not leak in
    // (status filter).
    const dir = await freshProject({
      manifests: [
        manifest({ kind: "provider", name: "good-provider" }),
        manifest({ kind: "bundle", name: "some-bundle" }),
        {
          path: "/fixture/provider/broken",
          raw: {
            manifest_version: "2.0",
            name: "broken-provider",
            kind: "provider",
            publisher: "@loom",
            version: "0.0.1",
            requires: { kernel_api: "^3.0.0" },
            capabilities: [],
          },
        },
      ],
    });
    try {
      const { tools } = createServer();
      const meta = await tools.pipeline_meta({ project_dir: dir });
      assert.deepEqual(meta.providers.enabled, ["good-provider"]);
      assert.ok(!meta.providers.enabled.includes("some-bundle"));
      assert.ok(!meta.providers.enabled.includes("broken-provider"));
      assert.deepEqual(
        meta.bundles_available,
        [{ name: "some-bundle", version: "1.0.0" }],
      );
    } finally {
      cleanup(dir);
    }
  });

  it("flag_vocabulary matches the spec-pinned five-flag list verbatim", async () => {
    // Hard-coded list rather than Object.keys(FLAG_TO_PRESET) — the
    // single-source-of-truth contract is verified separately in
    // parse-task-args.test.ts (the FLAG_TO_PRESET key-pin). If meta
    // hardcoded a divergent list OR FLAG_TO_PRESET silently grew an
    // entry, this test catches the drift.
    const dir = await freshProject();
    try {
      const { tools } = createServer();
      const meta = await tools.pipeline_meta({ project_dir: dir });
      assert.deepEqual(meta.flag_vocabulary, [
        "--supervised",
        "--auto",
        "--review-plan",
        "--review-final",
        "--gates-on-blockers",
      ]);
    } finally {
      cleanup(dir);
    }
  });

  it("echoes a supplied client_identifier_unverified, defaults to 'unknown'", async () => {
    const dir = await freshProject();
    try {
      const { tools } = createServer();

      const echoed = await tools.pipeline_meta({
        project_dir: dir,
        client_identifier_unverified: "claude-code",
      });
      assert.equal(echoed.client_identifier_unverified, "claude-code");

      const defaulted = await tools.pipeline_meta({ project_dir: dir });
      assert.equal(defaulted.client_identifier_unverified, "unknown");
    } finally {
      cleanup(dir);
    }
  });
});

describe("pipeline_state_get", () => {
  it("summary returns the documented compact record", async () => {
    const dir = await freshProject({ seedPipelineState: true, seedAudit: true });
    try {
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({ project_dir: dir });
      assert.equal(view.format, "summary");
      if (view.format !== "summary") return;
      assert.equal(view.summary["task_id"], "task-fixture");
      assert.equal(view.summary["status"], "in_progress");
      assert.equal(view.summary["owner_id"], "ops@example");
      assert.equal(view.summary["pending_agent_count"], 0);
      assert.equal(view.summary["gate_count"], 0);
      assert.equal(view.summary["audit_row_count"], 3);
      assert.equal(view.summary["finding_count"], 0);
    } finally {
      cleanup(dir);
    }
  });

  it("json returns a full PipelineState aggregate", async () => {
    const dir = await freshProject({ seedPipelineState: true });
    try {
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({
        project_dir: dir,
        format: "json",
      });
      assert.equal(view.format, "json");
      if (view.format !== "json") return;
      assert.equal(view.state.task_id, "task-fixture");
      assert.equal(view.state.bundle, "code");
      assert.equal(view.state.status, "in_progress");
      assert.equal(view.state.driver_state_id, "drv-fixture");
      assert.equal(view.state.driver.flow_name, "standard-flow");
      assert.equal(view.state.agents_count, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("jsonl returns one JSON-parseable line per row (default table = audit)", async () => {
    const dir = await freshProject({ seedAudit: true });
    try {
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({
        project_dir: dir,
        format: "jsonl",
      });
      assert.equal(view.format, "jsonl");
      if (view.format !== "jsonl") return;
      assert.equal(view.lines.length, 3);
      const types = view.lines.map((l) => (JSON.parse(l) as { type: string }).type);
      assert.deepEqual(types, ["event-one", "event-two", "event-three"]);
    } finally {
      cleanup(dir);
    }
  });

  it("summary returns null/zero counters against an uninitialized project", async () => {
    // No pipeline_state row was seeded — the inspection tool must
    // still answer. The summary branch deliberately avoids loadState
    // so it works pre-task-creation.
    const dir = await freshProject();
    try {
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({ project_dir: dir });
      assert.equal(view.format, "summary");
      if (view.format !== "summary") return;
      assert.equal(view.summary["task_id"], null);
      assert.equal(view.summary["status"], null);
      assert.equal(view.summary["owner_id"], null);
      assert.equal(view.summary["pending_agent_count"], 0);
      assert.equal(view.summary["gate_count"], 0);
      assert.equal(view.summary["finding_count"], 0);
    } finally {
      cleanup(dir);
    }
  });

  it("jsonl honors `limit` and clamps it before SELECT", async () => {
    const dir = await freshProject({ seedAudit: true });
    try {
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({
        project_dir: dir,
        format: "jsonl",
        limit: 2,
      });
      assert.equal(view.format, "jsonl");
      if (view.format !== "jsonl") return;
      assert.equal(view.lines.length, 2);
    } finally {
      cleanup(dir);
    }
  });

  it("jsonl falls back to the default table when given an unknown name", async () => {
    // 'kernel_idempotency_ledger' is deliberately excluded from the
    // inspectable-table allowlist. The handler must fall back to the
    // default ('audit') rather than reading from the ledger.
    const dir = await freshProject({ seedAudit: true });
    try {
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({
        project_dir: dir,
        format: "jsonl",
        table: "kernel_idempotency_ledger",
      });
      assert.equal(view.format, "jsonl");
      if (view.format !== "jsonl") return;
      // Three audit rows, not zero ledger rows — proves fallback.
      assert.equal(view.lines.length, 3);
      const first = JSON.parse(view.lines[0] as string) as Record<string, unknown>;
      // Audit row carries a 'ts' column; ledger row would carry 'key'.
      assert.ok("ts" in first);
      assert.ok(!("key" in first));
    } finally {
      cleanup(dir);
    }
  });

  it("jsonl honors the `since` filter on audit rows", async () => {
    const dir = await freshProject({ seedAudit: true });
    try {
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({
        project_dir: dir,
        format: "jsonl",
        since: "2026-01-15T10:00:02.500Z",
      });
      assert.equal(view.format, "jsonl");
      if (view.format !== "jsonl") return;
      assert.equal(view.lines.length, 1);
      const parsed = JSON.parse(view.lines[0] as string) as { type: string };
      assert.equal(parsed.type, "event-three");
    } finally {
      cleanup(dir);
    }
  });

  it("pretty-table renders '(empty)' for a table with no rows", async () => {
    // Reconciliation seeds audit with extension-installed rows; clear
    // the table so the empty-result branch is exercised cleanly.
    const dir = await freshProject();
    try {
      openDb(dir).exec("DELETE FROM audit");
      const { tools } = createServer();
      const view = await tools.pipeline_state_get({
        project_dir: dir,
        format: "pretty-table",
        table: "audit",
      });
      assert.equal(view.format, "pretty-table");
      if (view.format !== "pretty-table") return;
      assert.equal(view.tables["audit"], "(empty)");
    } finally {
      cleanup(dir);
    }
  });

  it("pretty-table has stable column widths (exact-string assertion)", async () => {
    const dir = await freshProject({ seedAudit: true });
    try {
      const { tools } = createServer();
      // Reduce to a single deterministic row so the exact-string
      // assertion below stays small and the width contract is precise.
      const db = openDb(dir);
      db.exec("DELETE FROM audit");
      db.prepare(
        "INSERT INTO audit (id, ts, type, task_id, driver_state_id, payload, verdict, error_class, force_used) " +
          "VALUES (1, '2026-01-15T10:00:01.000Z', 'event-one', NULL, NULL, NULL, 'ok', NULL, 0)",
      ).run();

      const view = await tools.pipeline_state_get({
        project_dir: dir,
        format: "pretty-table",
        table: "audit",
      });
      assert.equal(view.format, "pretty-table");
      if (view.format !== "pretty-table") return;

      const expected = [
        "id | ts                       | type      | task_id | driver_state_id | payload | verdict | error_class | force_used",
        "---+--------------------------+-----------+---------+-----------------+---------+---------+-------------+-----------",
        "1  | 2026-01-15T10:00:01.000Z | event-one |         |                 |         | ok      |             | 0         ",
      ].join("\n");
      assert.equal(view.tables["audit"], expected);
    } finally {
      cleanup(dir);
    }
  });
});

describe("pipeline_extensions_list", () => {
  it("returns every installed extension when no filter is supplied", async () => {
    const dir = await freshProject();
    try {
      const { tools } = createServer();
      const res = await tools.pipeline_extensions_list({ project_dir: dir });
      assert.equal(res.extensions.length, 2);
      const ids = res.extensions.map((e) => e.id).sort();
      assert.deepEqual(ids, ["bundle:code-fixture", "provider:shuttle-fixture"]);
    } finally {
      cleanup(dir);
    }
  });

  it("kind filter narrows to a single extension kind", async () => {
    const dir = await freshProject();
    try {
      const { tools } = createServer();
      const res = await tools.pipeline_extensions_list({
        project_dir: dir,
        kind: "provider",
      });
      assert.equal(res.extensions.length, 1);
      assert.equal(res.extensions[0]?.kind, "provider");
      assert.equal(res.extensions[0]?.name, "shuttle-fixture");
    } finally {
      cleanup(dir);
    }
  });

  it("include_manifest toggles the parsed manifest field on / off", async () => {
    const dir = await freshProject();
    try {
      const { tools } = createServer();

      const without = await tools.pipeline_extensions_list({ project_dir: dir });
      for (const entry of without.extensions) {
        assert.equal(entry.manifest, undefined);
      }

      const withMan = await tools.pipeline_extensions_list({
        project_dir: dir,
        include_manifest: true,
      });
      for (const entry of withMan.extensions) {
        assert.ok(entry.manifest, "expected manifest field when include_manifest=true");
        assert.equal(entry.manifest?.manifest_version, "1.0");
      }
    } finally {
      cleanup(dir);
    }
  });

  it("status filter narrows to failed-only when broken fixtures are present", async () => {
    // Fixture with an invalid manifest_version surfaces as a failed row;
    // the healthy fixture sits at status='enabled'. status='failed'
    // filter must return only the broken one.
    const dir = await freshProject({
      manifests: [
        manifest({ kind: "provider", name: "good-fixture" }),
        {
          path: "/fixture/provider/broken",
          raw: {
            manifest_version: "2.0",
            name: "broken-fixture",
            kind: "provider",
            publisher: "@loom",
            version: "0.0.1",
            requires: { kernel_api: "^3.0.0" },
            capabilities: [],
          },
        },
      ],
    });
    try {
      const { tools } = createServer();
      const res = await tools.pipeline_extensions_list({
        project_dir: dir,
        status: "failed",
      });
      assert.equal(res.extensions.length, 1);
      assert.equal(res.extensions[0]?.status, "failed");
      assert.equal(res.extensions[0]?.name, "broken-fixture");
      assert.ok(res.extensions[0]?.failure_reason);
    } finally {
      cleanup(dir);
    }
  });

  it("failure_reason is omitted on healthy entries (negative assertion)", async () => {
    const dir = await freshProject();
    try {
      const { tools } = createServer();
      const res = await tools.pipeline_extensions_list({ project_dir: dir });
      assert.ok(res.extensions.length > 0);
      for (const entry of res.extensions) {
        assert.equal(entry.status, "enabled");
        assert.equal(
          entry.failure_reason,
          undefined,
          `healthy ${entry.id} must not carry a failure_reason field`,
        );
      }
    } finally {
      cleanup(dir);
    }
  });

  it("kind + status filters combine (both WHERE clauses apply)", async () => {
    // One broken bundle + one broken provider + one healthy provider.
    // kind='provider' AND status='failed' must isolate the broken
    // provider — neither the broken bundle nor the healthy provider.
    const dir = await freshProject({
      manifests: [
        manifest({ kind: "provider", name: "healthy-provider" }),
        {
          path: "/fixture/provider/broken-prov",
          raw: {
            manifest_version: "2.0",
            name: "broken-prov",
            kind: "provider",
            publisher: "@loom",
            version: "0.0.1",
            requires: { kernel_api: "^3.0.0" },
            capabilities: [],
          },
        },
        {
          path: "/fixture/bundle/broken-bundle",
          raw: {
            manifest_version: "2.0",
            name: "broken-bundle",
            kind: "bundle",
            publisher: "@loom",
            version: "0.0.1",
            requires: { kernel_api: "^3.0.0" },
            capabilities: [],
          },
        },
      ],
    });
    try {
      const { tools } = createServer();
      const res = await tools.pipeline_extensions_list({
        project_dir: dir,
        kind: "provider",
        status: "failed",
      });
      assert.equal(res.extensions.length, 1);
      assert.equal(res.extensions[0]?.name, "broken-prov");
      assert.equal(res.extensions[0]?.kind, "provider");
      assert.equal(res.extensions[0]?.status, "failed");
    } finally {
      cleanup(dir);
    }
  });
});
