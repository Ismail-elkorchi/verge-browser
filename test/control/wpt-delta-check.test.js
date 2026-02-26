import test from "node:test";
import assert from "node:assert/strict";

import { readJson } from "../../scripts/eval/render-eval-lib.mjs";

test("wpt delta corpus and expected have aligned IDs with >=100 cases", async () => {
  const [corpus, expected] = await Promise.all([
    readJson("scripts/oracles/corpus/wpt-delta-v1.json"),
    readJson("scripts/oracles/corpus/wpt-delta-v1.expected.json")
  ]);

  assert.ok(Array.isArray(corpus.cases));
  assert.ok(Array.isArray(expected.cases));
  assert.ok(corpus.cases.length >= 100);
  assert.equal(corpus.cases.length, expected.cases.length);

  const corpusIds = corpus.cases.map((entry) => entry.id).sort();
  const expectedIds = expected.cases.map((entry) => entry.id).sort();
  assert.deepEqual(expectedIds, corpusIds);

  const categories = new Set(corpus.cases.map((entry) => entry.category));
  const plannedCategories = new Set((corpus.casePlan ?? []).map((entry) => entry.category));
  for (const category of plannedCategories) {
    assert.ok(categories.has(category));
  }
});
