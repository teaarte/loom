// The control plane's typed error. Submit / answer / the registry throw it;
// the HTTP layer has one catch that shapes it into a `{ error: { code,
// message } }` envelope with the carried status code. A thrown `KernelError`
// (a task-active refusal, a stale gate id) is mapped to one of these by
// `fromKernelError` so the transport vocabulary stays the kernel's, never a
// re-invented parallel set.

import { KernelError } from "@loomfsm/kernel";

export class ServerError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

// Kernel refusal codes that are a client conflict rather than a bad request:
// the single-task slot is already live, or the delivered gate id is stale.
const CONFLICT_CODES = new Set<string>([
  "PROJECT_TASK_ACTIVE",
  "GATE_EVENT_STALE",
  "STALE_GATE_EVENT",
  "NO_PENDING_GATE",
]);

// Map a thrown error into a `ServerError`. A `KernelError` becomes a typed
// 4xx (its code preserved verbatim); anything else is a programmer error and
// is rethrown so the HTTP layer logs it as a 500.
export function fromKernelError(err: unknown): ServerError {
  if (err instanceof ServerError) return err;
  if (err instanceof KernelError) {
    const status = CONFLICT_CODES.has(err.code) ? 409 : 400;
    return new ServerError(err.code, status, err.message);
  }
  throw err;
}
