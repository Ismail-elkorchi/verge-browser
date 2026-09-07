import assert from "node:assert/strict";
import test from "node:test";
import { TabRestorationScheduler } from "../../dist/ui/tab-restoration.js";

function barrier() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("fifty selections promote queued restoration without exceeding total capacity", async () => {
  const scheduler = new TabRestorationScheduler();
  const started = [];
  const gates = Array.from({ length: 50 }, barrier);
  scheduler.configure("tab-0", false);
  const promises = gates.map((gate, index) => scheduler.schedule(`tab-${index}`, async () => {
    started.push(index);
    return gate.promise;
  }));
  const settled = Promise.allSettled(promises);
  for (let index = 0; index < 50; index += 1) {
    scheduler.configure(`tab-${index}`, false);
    assert.ok(scheduler.metrics().live <= 3);
  }
  assert.deepEqual(scheduler.metrics(), { live: 3, queued: 47, capacity: 3 });
  scheduler.close();
  for (const gate of gates) gate.resolve();
  await settled;
  assert.ok(started.length <= 3);
});

test("closing queued and live placeholders preserves allocation and cleanup ownership", async () => {
  const scheduler = new TabRestorationScheduler();
  const gate = barrier();
  const entered = barrier();
  const active = new globalThis.AbortController();
  const queued = new globalThis.AbortController();
  let allocations = 0;
  scheduler.configure("A", false);
  const a = scheduler.schedule("A", async (signal) => {
    allocations += 1;
    entered.resolve(signal);
    return gate.promise;
  }, active.signal);
  const b = scheduler.schedule("B", async () => { allocations += 1; }, queued.signal);
  const outcomes = Promise.allSettled([a, b]);
  const signal = await entered.promise;
  queued.abort();
  active.abort();
  assert.equal(signal.aborted, true);
  assert.equal(allocations, 1);
  assert.equal(scheduler.metrics().live, 1, "a cancelled load owns capacity until cleanup finishes");
  assert.equal(scheduler.metrics().queued, 0);
  gate.resolve();
  await outcomes;
  scheduler.close();
});

test("a failed active render permits two eligible background restorations", async () => {
  const scheduler = new TabRestorationScheduler();
  const gate = barrier();
  scheduler.configure("active", false);
  const promises = ["B", "C", "D"].map((id) => scheduler.schedule(id, () => gate.promise));
  assert.equal(scheduler.metrics().live, 0);
  scheduler.configure("active", true);
  assert.equal(scheduler.metrics().live, 2);
  const outcomes = Promise.allSettled(promises);
  scheduler.close();
  gate.resolve();
  await outcomes;
});
