import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  segmentGraphemeClusters,
  UNICODE_VERSION
} from "../../dist/presentation/text/index.js";

const FIXTURE = new globalThis.URL("../fixtures/unicode/17.0.0/GraphemeBreakTest.txt", import.meta.url);

function conformanceCase(line) {
  const source = line.replace(/#.*/u, "").trim();
  if (!source.startsWith("÷")) return null;
  const tokens = source.split(/\s+/u);
  let value = "";
  let offset = 0;
  const boundaries = [0];
  for (let index = 1; index < tokens.length; index += 2) {
    const point = tokens[index];
    const following = tokens[index + 1];
    if (point === undefined || following === undefined) break;
    const character = String.fromCodePoint(Number.parseInt(point, 16));
    value += character;
    offset += character.length;
    if (following === "÷") boundaries.push(offset);
  }
  return { value, boundaries };
}

test("Unicode 17.0.0 UAX #29 extended grapheme conformance", async () => {
  assert.equal(UNICODE_VERSION, "17.0.0");
  const fixture = await readFile(FIXTURE, "utf8");
  let cases = 0;
  for (const line of fixture.split(/\r?\n/u)) {
    const entry = conformanceCase(line);
    if (entry === null) continue;
    const stream = segmentGraphemeClusters(entry.value);
    assert.equal(stream.outcome.status, "complete");
    assert.deepEqual(
      [0, ...stream.clusters.map((cluster) => cluster.endCodeUnit)],
      entry.boundaries,
      line
    );
    cases += 1;
  }
  assert.ok(cases > 700, `expected the complete GraphemeBreakTest suite, received ${String(cases)} cases`);
});

test("grapheme budgets retain complete cluster prefixes and cancellation is observed", () => {
  const value = "a👩🏽‍🚀ב";
  const full = segmentGraphemeClusters(value);
  const prefix = segmentGraphemeClusters(value, { maxGraphemeClusters: 2 });
  assert.equal(full.outcome.status, "complete");
  assert.deepEqual(prefix.clusters, full.clusters.slice(0, 2));
  assert.deepEqual(prefix.outcome, {
    status: "truncated",
    clusters: 2,
    budget: "maxGraphemeClusters",
    limit: 2
  });
  assert.equal(segmentGraphemeClusters(value, { maxGraphemeClusters: -1 }).outcome.status, "rejected");
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.throws(() => segmentGraphemeClusters(value, {}, controller.signal), { name: "AbortError" });
});
