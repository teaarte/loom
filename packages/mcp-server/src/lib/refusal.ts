// Shared refusal / error-shaping helpers for the MCP tool handlers.
//
// Every tool turns a thrown KernelError into its own typed refusal response and
// rethrows anything else — a non-KernelError reaching a tool boundary is a real
// fault, not a clean refusal. The "narrow-or-rethrow" head, the standard
// TransportResponse error envelope, and the unverified-identifier coalescing
// were copied across the tool files; they live here once. Each tool still
// builds its OWN response SHAPE — only these primitives are lifted.

import { KernelError } from "@loomfsm/kernel";
import type { TransportResponse } from "@loomfsm/transport-types";

// Narrow a caught value to a KernelError, or rethrow it. A non-KernelError at a
// tool boundary is an unexpected fault, so it propagates unchanged.
export function kernelErrorOrThrow(err: unknown): KernelError {
  if (err instanceof KernelError) return err;
  throw err;
}

// The standard error envelope returned inside a TransportResponse-shaped
// refusal (run-task / continue-task / recover / resume).
export function transportError(
  driverStateId: string,
  code: string,
  message: string,
): TransportResponse {
  return {
    status: "error",
    driver_state_id: driverStateId,
    code,
    message,
    recovery_options: [],
  };
}

// The `{ response }` refusal for the tools whose refusal is exactly a
// TransportResponse error envelope (run-task / continue-task / resume). The
// KernelError is narrowed here; anything else rethrows.
export function refuseTransport(
  err: unknown,
  driverStateId: string,
): { response: TransportResponse } {
  const ke = kernelErrorOrThrow(err);
  return { response: transportError(driverStateId, ke.code, ke.message) };
}

// The host-supplied client identifier, coalesced to "unknown" when absent or
// empty. It is unverified (the name says so) — used only for audit / labelling.
export function identifierOf(input: { client_identifier_unverified?: string }): string {
  return typeof input.client_identifier_unverified === "string" &&
    input.client_identifier_unverified.length > 0
    ? input.client_identifier_unverified
    : "unknown";
}
