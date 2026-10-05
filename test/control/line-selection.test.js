import assert from "node:assert/strict";
import test from "node:test";

import { cssPx, selectLogicalLines } from "../../dist/presentation/layout/index.js";
import { buildLineBreakMap, segmentGraphemeClusters } from "../../dist/unicode/index.js";

function selectText(value, width, tailoring = {}, options = {}) {
  const map = buildLineBreakMap(value, { ...tailoring, preserveGraphemeClusters: true });
  const clusters = segmentGraphemeClusters(value).clusters;
  const items = clusters.map((cluster, logicalIndex) => ({
    logicalIndex,
    advance: cssPx(cluster.text === "\n" ? 0 : 1),
    tabInterval: cluster.text === "\t" ? cssPx(4) : null,
    breakBefore: map.atCodeUnit(cluster.startCodeUnit).kind,
    forcedBreak: cluster.text === "\n",
    collapsibleSpace: cluster.text === " ",
    wrappingAllowed: options.wrappingAllowed ?? true
  }));
  const selection = selectLogicalLines(items, cssPx(width), cssPx(width), options.budgets, options.signal);
  const lines = [""];
  for (const [index, cluster] of clusters.entries()) {
    if (index >= selection.retainedItems) break;
    if (selection.breaksBefore.has(index) || cluster.text === "\n") lines.push("");
    if (!selection.suppressed.has(index) && cluster.text !== "\n") lines[lines.length - 1] += cluster.text;
  }
  return { lines, selection };
}

for (const overflowWrap of ["break-word", "anywhere"]) {
  test(`${overflowWrap} prefers ordinary word boundaries before emergency breaks`, () => {
    assert.deepEqual(selectText("alpha beta gamma", 8, { overflowWrap }).lines, ["alpha", "beta", "gamma"]);
    assert.deepEqual(selectText("alpha beta gamma", 10, { overflowWrap }).lines, ["alpha beta", "gamma"]);
    assert.deepEqual(selectText("a abcdefghij z", 4, { overflowWrap }).lines, ["a", "abcd", "efgh", "ij z"]);
    assert.deepEqual(selectText("abcde", 1, { overflowWrap }).lines, ["a", "b", "c", "d", "e"]);
    assert.deepEqual(selectText("abcde", 0, { overflowWrap }).lines, ["a", "b", "c", "d", "e"]);
    assert.deepEqual(selectText("a   b\nc d", 3, { overflowWrap }).lines, ["a", "b", "c d"]);
  });

  test(`${overflowWrap} preserves whole graphemes, CJK opportunities, nowrap, and resource limits`, () => {
    const value = "a\u0301👩🏽‍🚀🇯🇵z";
    assert.deepEqual(selectText(value, 1, { overflowWrap }).lines, ["a\u0301", "👩🏽‍🚀", "🇯🇵", "z"]);
    assert.deepEqual(selectText("漢字仮名", 2, { overflowWrap }).lines, ["漢字", "仮名"]);
    assert.deepEqual(selectText("漢字仮名", 2, { overflowWrap, wordBreak: "keep-all" }).lines, ["漢字", "仮名"]);
    assert.deepEqual(selectText("alpha beta gamma", 8, { overflowWrap }, { wrappingAllowed: false }).lines, ["alpha beta gamma"]);
    const limited = selectText("abcdefghij", 3, { overflowWrap }, { budgets: { maxSelectedLines: 2 } });
    assert.deepEqual(limited.lines, ["abc", "def"]);
    assert.deepEqual(limited.selection.outcome, { status: "truncated", lines: 2, budget: "maxSelectedLines", limit: 2 });
    const controller = new globalThis.AbortController();
    controller.abort();
    assert.throws(() => selectText("abc", 2, { overflowWrap }, { signal: controller.signal }), { name: "AbortError" });
  });
}

test("ordinary break-all and line-break:anywhere remain greedy rather than emergency-only", () => {
  for (const tailoring of [{ wordBreak: "break-all" }, { lineBreak: "anywhere" }]) {
    assert.deepEqual(selectText("alpha beta gamma", 8, tailoring).lines, ["alpha be", "ta gamma"]);
  }
});

test("emergency line selection retains tab-stop advances after an ordinary wrap", () => {
  const result = selectText("a abc\tdefg", 6, { overflowWrap: "break-word" });
  assert.deepEqual(result.lines, ["a", "abc\t", "defg"]);
  assert.equal(result.selection.usedAdvances.get(5), cssPx(1));
});


test("line selection preserves signed inline edge advances and tab stops before the origin", () => {
  const items = [-4, 0, 4].map((advance, logicalIndex) => ({ logicalIndex, advance: cssPx(advance),
    tabInterval: logicalIndex === 1 ? cssPx(8) : null, breakBefore: "prohibited", forcedBreak: false,
    collapsibleSpace: false, wrappingAllowed: true }));
  const selection = selectLogicalLines(items, cssPx(4), cssPx(4));
  assert.equal(selection.outcome.status, "complete");
  assert.equal(selection.outcome.lines, 1);
  assert.equal(selection.usedAdvances.get(0), cssPx(-4));
  assert.equal(selection.usedAdvances.get(1), cssPx(4));
});
