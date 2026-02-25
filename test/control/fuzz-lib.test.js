import test from "node:test";
import assert from "node:assert/strict";

import { evaluateFuzzCase, generateFuzzHtml } from "../../scripts/eval/fuzz-lib.mjs";

test("fuzz generator is deterministic by seed", () => {
  const htmlA = generateFuzzHtml(20260226, { maxDepth: 4, sectionCount: 6 });
  const htmlB = generateFuzzHtml(20260226, { maxDepth: 4, sectionCount: 6 });
  assert.equal(htmlB, htmlA);
});

test("fuzz case evaluation is deterministic", () => {
  const html = generateFuzzHtml(20260227, { maxDepth: 4, sectionCount: 6 });
  const first = evaluateFuzzCase({ caseId: "fuzz-test", seed: 20260227, html });
  const second = evaluateFuzzCase({ caseId: "fuzz-test", seed: 20260227, html });
  assert.deepEqual(second, first);
});
