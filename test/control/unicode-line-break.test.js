import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildLineBreakMap } from "../../dist/unicode/index.js";

const FIXTURE = new globalThis.URL("../fixtures/unicode/17.0.0/LineBreakTest.txt", import.meta.url);

function conformanceCase(line) {
  const source = line.replace(/#.*/u, "").trim();
  if (!source.startsWith("×")) return null;
  const tokens = source.split(/\s+/u);
  const breaks = [tokens[0] === "÷"];
  const points = [];
  for (let index = 1; index < tokens.length; index += 2) {
    const point = tokens[index];
    const marker = tokens[index + 1];
    if (point === undefined || marker === undefined) break;
    points.push(Number.parseInt(point, 16));
    breaks.push(marker === "÷");
  }
  return { value: String.fromCodePoint(...points), breaks };
}

test("Unicode 17.0.0 UAX #14 default line-break conformance", async () => {
  const fixture = await readFile(FIXTURE, "utf8");
  let cases = 0;
  for (const line of fixture.split(/\r?\n/u)) {
    const entry = conformanceCase(line);
    if (entry === null) continue;
    const map = buildLineBreakMap(entry.value);
    assert.equal(map.outcome.status, "complete", line);
    assert.deepEqual(
      map.opportunities.map((opportunity) => opportunity.kind !== "prohibited"),
      entry.breaks,
      line
    );
    cases += 1;
  }
  assert.ok(cases > 19_000, `expected the complete LineBreakTest suite, received ${String(cases)} cases`);
});

test("CSS line-breaking tailoring remains cluster-safe and resource bounded", () => {
  const value = "a👩🏽‍🚀b";
  const map = buildLineBreakMap(value, {
    lineBreak: "anywhere",
    preserveGraphemeClusters: true
  });
  const offsets = map.opportunities
    .filter((opportunity) => opportunity.kind !== "prohibited")
    .map((opportunity) => opportunity.codeUnitOffset);
  assert.deepEqual(offsets, [1, 8, 9]);
  const truncated = buildLineBreakMap(value, {}, { maxBreakOpportunities: 2 });
  assert.deepEqual(truncated.outcome, {
    status: "truncated",
    opportunities: 2,
    budget: "maxBreakOpportunities",
    limit: 2
  });
  assert.equal(buildLineBreakMap(value, {}, { maxBreakOpportunities: -1 }).outcome.status, "rejected");
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.throws(() => buildLineBreakMap(value, {}, {}, controller.signal), { name: "AbortError" });
});

test("CSS line-break, word-break, overflow-wrap, and hyphens tailor Unicode opportunities", () => {
  const allowedOffsets = (value, tailoring) => buildLineBreakMap(value, tailoring).opportunities
    .filter((opportunity) => opportunity.kind !== "prohibited")
    .map((opportunity) => opportunity.codeUnitOffset);

  assert.deepEqual(allowedOffsets("abcd", { lineBreak: "normal" }), [4]);
  assert.deepEqual(allowedOffsets("abcd", { lineBreak: "anywhere" }), [1, 2, 3, 4]);
  assert.deepEqual(allowedOffsets("abcd", { wordBreak: "break-all" }), [1, 2, 3, 4]);
  assert.deepEqual(allowedOffsets("漢字", { wordBreak: "normal" }), [1, 2]);
  assert.deepEqual(allowedOffsets("漢字", { wordBreak: "keep-all" }), [2]);
  assert.deepEqual(allowedOffsets("abcd", { overflowWrap: "normal" }), [4]);
  assert.deepEqual(allowedOffsets("abcd", { overflowWrap: "anywhere" }), [1, 2, 3, 4]);
  assert.deepEqual(allowedOffsets("abcd", { overflowWrap: "break-word" }), [1, 2, 3, 4]);
  assert.deepEqual(allowedOffsets("ab\u00adcd", { hyphens: "manual" }), [3, 5]);
  assert.deepEqual(allowedOffsets("ab\u00adcd", { hyphens: "none" }), [5]);
});
