// pipeline_issue_cross_owner_marker — mint a single-use, TTL-bounded
// cross-owner bypass marker.
//
// Composition: project-dir allowlist → mint inside one
// withStateTransaction (the bypass_markers row is written under the
// threaded NowToken; the TTL is tx.now + ttl_ms with no host-clock read)
// → return the full marker the caller passes verbatim to pipeline_recover.
//
// Possessing the signing key (env var or user-global key file, both
// OUTSIDE any project dir) IS the authorization to mint — there is no
// owner check here. Absent a key the mint refuses with BYPASS_KEY_MISSING.
//
// Refusals (allowlist, missing key, bad TTL) are error-shaped responses;
// only programmer errors throw.

import {
  assertProjectDirAllowed,
  captureNow,
  issueCrossOwnerMarker,
  withStateTransaction,
} from "@loomfsm/kernel";

import { kernelErrorOrThrow } from "../lib/refusal.js";
import type {
  IssueCrossOwnerMarkerInput,
  IssueCrossOwnerMarkerResponse,
  ToolHandler,
} from "../types.js";

export interface IssueMarkerDeps {
  allowlistPath?: string;
}

export function createIssueCrossOwnerMarkerTool(
  deps: IssueMarkerDeps = {},
): ToolHandler<IssueCrossOwnerMarkerInput, IssueCrossOwnerMarkerResponse> {
  return async (input) => {
    // 1. Project-dir allowlist.
    try {
      await assertProjectDirAllowed(
        input.project_dir,
        deps.allowlistPath !== undefined ? { allowlistPath: deps.allowlistPath } : undefined,
      );
    } catch (err) {
      return refusal(err);
    }

    // 2. Mint + persist the marker inside one tx.
    try {
      const marker = await withStateTransaction(
        input.project_dir,
        captureNow(),
        (tx) =>
          issueCrossOwnerMarker(tx, {
            driver_state_id: input.driver_state_id,
            ttl_ms: input.ttl_ms,
          }),
      );
      return {
        key_id: marker.key_id,
        hmac: marker.hmac,
        issued_at: marker.issued_at,
        expires_at: marker.expires_at,
        reason: marker.reason,
      };
    } catch (err) {
      return refusal(err);
    }
  };
}

function refusal(err: unknown): IssueCrossOwnerMarkerResponse {
  const ke = kernelErrorOrThrow(err);
  return {
    key_id: null,
    hmac: null,
    issued_at: null,
    expires_at: null,
    reason: null,
    error: { code: ke.code, message: ke.message },
  };
}
