// Bypass-marker key custody + HMAC + minting.
//
// A bypass marker is the forge-resistant escape hatch a cross-owner
// recovery presents instead of a naked boolean override. Forge
// resistance rests on ONE property: the signing key lives outside both
// `state.db` and any project directory, so a writer that can reach the
// `bypass_markers` row still cannot produce a valid signature for it.
//
// Key custody cascade (first hit wins):
//   1. `PIPELINE_BYPASS_HMAC_KEY` env var — base64, ≥32 bytes decoded.
//      key_id = "env:" + sha256(key).slice(0,8). For CI / containers.
//   2. `~/.loom/bypass-hmac.key` — a user-global file (NOT project-
//      local), mode 0600, owned by the running euid. key_id =
//      "file:" + sha256(bytes).slice(0,8). The kernel only READS this
//      file; it never creates it.
//   3. Neither configured → `loadBypassKey` returns null and the caller
//      refuses the marker operation (`BYPASS_KEY_MISSING`).
//
// A project-local key is deliberately unreachable: a bundle holding
// project write access could read it and forge markers, so the cascade
// never looks under a project dir. Rotation (swapping the env value or
// the file) changes `key_id`, which invalidates every previously-issued
// marker — intentional, since markers are TTL'd escape hatches.
//
// Wall-clock discipline: the marker TTL is `tx.now + ttl_ms` computed by
// parsing the NowToken string only (`markerExpiresAt`); no host clock is
// read. `node:crypto` randomness is mint-time, like the id generators.

import { createHash, createHmac } from "node:crypto";
import { readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

import { KernelError } from "../state/db.js";
import { userFootprintDir } from "./footprint.js";
import { offsetNowToken } from "./now-arith.js";
import type { NowToken } from "../types/now.js";
import type { Transaction } from "../types/transaction.js";

const ENV_VAR = "PIPELINE_BYPASS_HMAC_KEY";
const KEY_FILE_NAME = "bypass-hmac.key";
const MIN_KEY_BYTES = 32;

export interface BypassKey {
  key: Buffer;
  key_id: string;
  source: "env" | "file";
}

// The full marker the kernel mints and the recover handler echoes back.
// Every field feeds the signature except `key_id`, which names the
// signing key so a rotation mismatch is legible without re-deriving it.
export interface IssuedMarker {
  key_id: string;
  hmac: string;
  issued_at: NowToken;
  expires_at: NowToken;
  reason: string;
}

export interface LoadBypassKeyOptions {
  // Overrides the user-global home directory the file branch reads from.
  // Production passes nothing (the real home); tests inject a tempdir to
  // exercise the file / missing branches without touching the real
  // `~/.loom/bypass-hmac.key`. It is NOT an env-controlled value — an
  // attacker who could set it could already set the key itself.
  homeDir?: string;
}

// Resolve the active signing key, or null when none is configured. The
// caller decides whether a null is fatal (a marker write) — `loadBypassKey`
// itself never refuses, it only reports custody.
export function loadBypassKey(opts?: LoadBypassKeyOptions): BypassKey | null {
  const env = process.env[ENV_VAR];
  if (env !== undefined && env.length > 0) {
    const key = Buffer.from(env, "base64");
    if (key.length < MIN_KEY_BYTES) {
      throw new KernelError({
        code: "BYPASS_KEY_TOO_SHORT",
        message: `${ENV_VAR} decodes to ${key.length} bytes; ≥${MIN_KEY_BYTES} required`,
      });
    }
    return { key, key_id: `env:${sha256Hex(key).slice(0, 8)}`, source: "env" };
  }

  const filePath = join(userFootprintDir(opts?.homeDir), KEY_FILE_NAME);
  const stat = statSyncOrNull(filePath);
  if (stat === null) return null;

  // Mode 0600 (owner-only). Any group/other bit makes the key readable by
  // a second principal, which defeats forge resistance.
  if ((stat.mode & 0o077) !== 0) {
    throw new KernelError({
      code: "BYPASS_KEY_BAD_PERMISSIONS",
      message: `${filePath} must be mode 0600 (owner-only); got ${(stat.mode & 0o777).toString(8)}`,
    });
  }
  // Owner check (shared-home / NFS scenarios): mode 0600 alone does not
  // prove the kernel reads its OWN key. Refuse a file owned by another uid.
  if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
    throw new KernelError({
      code: "BYPASS_KEY_WRONG_OWNER",
      message: `${filePath} is owned by uid=${stat.uid}; expected euid=${process.geteuid()}`,
    });
  }
  const key = readFileSync(filePath);
  if (key.length < MIN_KEY_BYTES) {
    throw new KernelError({
      code: "BYPASS_KEY_TOO_SHORT",
      message: `${filePath} holds ${key.length} bytes; ≥${MIN_KEY_BYTES} required`,
    });
  }
  return { key, key_id: `file:${sha256Hex(key).slice(0, 8)}`, source: "file" };
}

// HMAC-SHA256 over (issued_at || expires_at || reason). The three inputs
// are fixed-format ISO-8601 timestamps followed by the reason string, so
// the concatenation is unambiguous. Returned as lowercase hex.
export function computeMarkerHmac(
  key: Buffer,
  issued_at: string,
  expires_at: string,
  reason: string,
): string {
  return createHmac("sha256", key)
    .update(`${issued_at}${expires_at}${reason}`)
    .digest("hex");
}

// Canonical reason for a cross-owner recovery marker. Encoding the target
// driver_state_id is what binds the marker to one task — the validator
// refuses a marker whose reason does not match the recovery target, so a
// captured marker cannot be replayed against a different task.
export function crossOwnerReason(driverStateId: string): string {
  return `cross-owner-recover:${driverStateId}`;
}

export function reasonEncodesDriver(reason: string, driverStateId: string): boolean {
  return reason === crossOwnerReason(driverStateId);
}

// `tx.now + ttl_ms`, delegating to the single NowToken-arithmetic home — the
// `Date` use is on a supplied ISO-8601 string, never the host clock.
export function markerExpiresAt(now: NowToken, ttlMs: number): NowToken {
  return offsetNowToken(now, ttlMs);
}

export interface IssueCrossOwnerMarkerArgs {
  driver_state_id: string;
  ttl_ms: number;
}

// Mint a cross-owner bypass marker and persist it as the single
// `bypass_markers` row inside the caller's tx. Refuses with
// `BYPASS_KEY_MISSING` when no signing key is configured. A second issue
// overwrites the prior (unconsumed) marker — the table is single-row by
// design.
export async function issueCrossOwnerMarker(
  tx: Transaction,
  args: IssueCrossOwnerMarkerArgs,
): Promise<IssuedMarker> {
  const loaded = loadBypassKey();
  if (loaded === null) {
    throw new KernelError({
      code: "BYPASS_KEY_MISSING",
      message:
        "no bypass-HMAC key is configured — set PIPELINE_BYPASS_HMAC_KEY or install a user-global ~/.loom/bypass-hmac.key",
    });
  }
  if (!Number.isFinite(args.ttl_ms) || args.ttl_ms <= 0) {
    throw new KernelError({
      code: "MARKER_TTL_INVALID",
      message: `ttl_ms must be a positive number; got ${String(args.ttl_ms)}`,
      detail: { ttl_ms: args.ttl_ms },
    });
  }
  const issued_at = tx.now;
  const expires_at = markerExpiresAt(tx.now, args.ttl_ms);
  const reason = crossOwnerReason(args.driver_state_id);
  const hmac = computeMarkerHmac(loaded.key, issued_at, expires_at, reason);

  await tx.exec(
    "INSERT INTO bypass_markers (id, issued_at, expires_at, reason, hmac, key_id) " +
      "VALUES (1, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "issued_at = excluded.issued_at, expires_at = excluded.expires_at, " +
      "reason = excluded.reason, hmac = excluded.hmac, key_id = excluded.key_id",
    [issued_at, expires_at, reason, hmac, loaded.key_id],
  );

  return { key_id: loaded.key_id, hmac, issued_at, expires_at, reason };
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function statSyncOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
