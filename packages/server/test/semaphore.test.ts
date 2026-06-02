// The fleet concurrency primitive — bounds the number of concurrent holders
// and hands permits to waiters in FIFO order.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Semaphore } from "../src/index.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("Semaphore", () => {
  it("never lets more than `permits` run at once", async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = (): Promise<void> =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        active -= 1;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    assert.equal(peak, 2, "the ceiling was exceeded");
    assert.equal(active, 0, "every permit was released");
  });

  it("releases a permit even when the body throws", async () => {
    const gate = new Semaphore(1);
    await assert.rejects(gate.run(async () => {
      throw new Error("boom");
    }));
    // If the failing run leaked its permit, this would deadlock.
    let ran = false;
    await gate.run(async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it("hands a freed permit to the next waiter (FIFO)", async () => {
    const gate = new Semaphore(1);
    const order: number[] = [];
    await gate.acquire(); // hold the only permit
    const w1 = gate.acquire().then(() => order.push(1));
    const w2 = gate.acquire().then(() => order.push(2));
    gate.release(); // → waiter 1
    await w1;
    gate.release(); // → waiter 2
    await w2;
    assert.deepEqual(order, [1, 2]);
  });

  it("rejects a non-positive permit count", () => {
    assert.throws(() => new Semaphore(0));
  });
});
