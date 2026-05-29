import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  computeMarkerHmac,
  crossOwnerReason,
  issueCrossOwnerMarker,
  loadBypassKey,
} from "../src/lib/bypass-marker.js";
import { KernelError, captureNow, closeDb, withStateTransaction } from "../src/state.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import type { NowToken } from "../src/types/now.js";

const ENV_VAR = "PIPELINE_BYPASS_HMAC_KEY";
const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);

const tmpDirs: string[] = [];

function freshHome(withKey: Buffer | null, mode = 0o600): string {
  const home = mkdtempSync(join(tmpdir(), "loom-bk-home-"));
  tmpDirs.push(home);
  if (withKey !== null) {
    const claude = join(home, ".claude");
    mkdirSync(claude, { recursive: true });
    const keyPath = join(claude, "bypass-hmac.key");
    writeFileSync(keyPath, withKey);
    chmodSync(keyPath, mode);
  }
  return home;
}

let prevEnv: string | undefined;
beforeEach(() => {
  prevEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = prevEnv;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadBypassKey — key custody cascade", () => {
  it("resolves the env var first (source=env, key_id env:…)", () => {
    process.env[ENV_VAR] = KEY_A.toString("base64");
    const loaded = loadBypassKey();
    assert.ok(loaded !== null);
    assert.equal(loaded.source, "env");
    assert.match(loaded.key_id, /^env:[0-9a-f]{8}$/);
    assert.ok(loaded.key.equals(KEY_A));
  });

  it("refuses an env key under 32 bytes (BYPASS_KEY_TOO_SHORT)", () => {
    process.env[ENV_VAR] = Buffer.alloc(16, 1).toString("base64");
    assert.throws(
      () => loadBypassKey(),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_KEY_TOO_SHORT",
    );
  });

  it("falls through to the user-global file when no env (source=file)", () => {
    const home = freshHome(KEY_A);
    const loaded = loadBypassKey({ homeDir: home });
    assert.ok(loaded !== null);
    assert.equal(loaded.source, "file");
    assert.match(loaded.key_id, /^file:[0-9a-f]{8}$/);
  });

  it("refuses a key file that is not mode 0600 (BYPASS_KEY_BAD_PERMISSIONS)", () => {
    const home = freshHome(KEY_A, 0o644);
    assert.throws(
      () => loadBypassKey({ homeDir: home }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_KEY_BAD_PERMISSIONS",
    );
  });

  it("returns null when neither env nor file is configured", () => {
    const home = freshHome(null);
    assert.equal(loadBypassKey({ homeDir: home }), null);
  });

  it("forge resistance: a key file inside the PROJECT dir is never honored", () => {
    // Plant a key under a project's .claude/ (where a bundle with project
    // write access could reach it). With no env and an empty user-global
    // home, the load returns null — the project-local key is ignored, so a
    // marker cannot be forged from data the project can write.
    const project = mkdtempSync(join(tmpdir(), "loom-bk-proj-"));
    tmpDirs.push(project);
    const projClaude = join(project, ".claude");
    mkdirSync(projClaude, { recursive: true });
    const projKey = join(projClaude, "bypass-hmac.key");
    writeFileSync(projKey, KEY_A);
    chmodSync(projKey, 0o600);

    const emptyHome = freshHome(null);
    assert.equal(loadBypassKey({ homeDir: emptyHome }), null);
  });
});

describe("computeMarkerHmac", () => {
  it("is deterministic for the same key + inputs", () => {
    const a = computeMarkerHmac(KEY_A, "i", "e", "r");
    const b = computeMarkerHmac(KEY_A, "i", "e", "r");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("differs under a different key (forge resistance rests on the key)", () => {
    const a = computeMarkerHmac(KEY_A, "i", "e", "r");
    const b = computeMarkerHmac(KEY_B, "i", "e", "r");
    assert.notEqual(a, b);
  });

  it("locks the message construction to issued_at || expires_at || reason (known-answer)", () => {
    // A frozen reference digest. Every other marker test computes its
    // expected HMAC with this same function on both sides, so a change to
    // the message construction (a separator, a reordering) would stay
    // invisible to them — mint and verify would simply agree on the wrong
    // bytes. This KAT is the one assertion that pins the actual byte
    // layout: it breaks if the concatenation changes, even though the
    // change is internally consistent.
    const hmac = computeMarkerHmac(
      KEY_A, // Buffer.alloc(32, 0xa1)
      "2026-05-29T12:00:00.000Z",
      "2026-05-29T13:00:00.000Z",
      "cross-owner-recover:d-x",
    );
    assert.equal(
      hmac,
      "e876bd65cd6aa8f1a51e678cdb7ed3cd089a241185295e0ec955cd12288948ab",
    );
  });
});

describe("issueCrossOwnerMarker", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = mkdtempSync(join(tmpdir(), "loom-bk-issue-"));
  });
  afterEach(() => {
    _resetInvariantsForTest();
    try {
      closeDb(dir);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedState(now: NowToken): Promise<void> {
    await withStateTransaction(dir, now, async (tx) => {
      await tx.exec(
        "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
          "task, driver_state_id, owner_id, status, started_at) " +
          "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["3.0.0", dir, "code", "build a thing", "d-fixture", "alice", "in_progress", now],
      );
      await tx.exec(
        "INSERT INTO driver_state (id, flow_name, step_index, complete) VALUES (1, 'simple', 0, 0)",
      );
      await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    });
  }

  it("mints + persists a marker whose signature verifies", async () => {
    process.env[ENV_VAR] = KEY_A.toString("base64");
    const now = captureNow();
    await seedState(now);

    const marker = await withStateTransaction(dir, now, (tx) =>
      issueCrossOwnerMarker(tx, { driver_state_id: "d-fixture", ttl_ms: 60_000 }),
    );

    assert.equal(marker.reason, crossOwnerReason("d-fixture"));
    assert.equal(marker.issued_at, now);
    // The persisted row matches the returned marker.
    const row = await withStateTransaction(dir, now, (tx) =>
      tx.queryRow<{ hmac: string; key_id: string; reason: string }>(
        "SELECT hmac, key_id, reason FROM bypass_markers WHERE id = 1",
      ),
    );
    assert.ok(row !== null);
    assert.equal(row.hmac, marker.hmac);
    assert.equal(row.key_id, marker.key_id);
    // The signature verifies under the active key.
    const expected = computeMarkerHmac(KEY_A, marker.issued_at, marker.expires_at, marker.reason);
    assert.equal(marker.hmac, expected);
  });

  it("refuses to mint with no signing key (BYPASS_KEY_MISSING)", async () => {
    // No env key; point HOME at an empty dir so the file branch misses too.
    const prevHome = process.env["HOME"];
    process.env["HOME"] = freshHome(null);
    try {
      const now = captureNow();
      await seedState(now);
      await assert.rejects(
        withStateTransaction(dir, now, (tx) =>
          issueCrossOwnerMarker(tx, { driver_state_id: "d-fixture", ttl_ms: 60_000 }),
        ),
        (err: unknown) =>
          err instanceof KernelError && err.code === "BYPASS_KEY_MISSING",
      );
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
    }
  });
});
