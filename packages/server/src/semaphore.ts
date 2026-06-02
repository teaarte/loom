// A tiny async counting semaphore — the fleet's shared concurrency ceiling.
//
// The control plane supervises N projects from one process, each driving its
// own task. Without a shared bound, N projects fanning out at once would spawn
// an unbounded number of concurrent backend children (`claude -p`) and blow
// the subscription's rate limits. This semaphore is injected into every
// project's executor (see `executor-gate.ts`) so the TOTAL number of in-flight
// spawns across the whole fleet never exceeds `permits`.
//
// It is a transport-layer primitive — counts only, no domain meaning, no
// kernel surface. Fair (FIFO): waiters are released in arrival order so no
// project starves behind a busier one.

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore needs a positive integer permit count, got ${permits}`);
    }
    this.available = permits;
  }

  // Acquire one permit, waiting (FIFO) until one frees. Resolves once held.
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // Release one permit — hand it straight to the next waiter if any, else
  // return it to the pool.
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.available += 1;
  }

  // Run `fn` while holding one permit; always release, even on throw.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
