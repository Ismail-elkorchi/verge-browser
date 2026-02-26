import assert from "node:assert/strict";
import test from "node:test";

import { getGuidedFuzzPolicy, runGuidedFuzz } from "../../scripts/eval/fuzz-guided-lib.mjs";

test("guided fuzz report is deterministic for fixed policy", () => {
  const policy = getGuidedFuzzPolicy({
    fuzzGuided: {
      profiles: {
        ci: {
          seed: 12345,
          initialCorpusSize: 4,
          maxDepth: 4,
          sectionCount: 5,
          maxIterations: 8,
          mutationsPerInput: 2,
          frontierLimit: 12,
          topSlowest: 5,
          minNovelSignatures: 3
        }
      }
    }
  }, "ci");

  const first = runGuidedFuzz(policy, "ci");
  const second = runGuidedFuzz(policy, "ci");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.totals.executedCases, second.totals.executedCases);
  assert.equal(first.totals.novelSignatures, second.totals.novelSignatures);
  assert.deepEqual(first.topNovelFindings, second.topNovelFindings);
  assert.deepEqual(first.deterministicMismatches, second.deterministicMismatches);
  assert.deepEqual(first.crashes, second.crashes);
});
