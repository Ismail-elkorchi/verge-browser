import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";
import { evaluateWptDeltaCase, normalizeExpectedById, readWptDeltaCorpus } from "./wpt-delta-lib.mjs";

async function main() {
  const corpusPath = resolve("scripts/oracles/corpus/wpt-delta-v1.json");
  const expectedPath = resolve("scripts/oracles/corpus/wpt-delta-v1.expected.json");
  const reportPath = resolve("reports/wpt-delta.json");

  const [corpus, expectedPayload] = await Promise.all([
    readWptDeltaCorpus(corpusPath),
    readJson(expectedPath)
  ]);

  if (!Array.isArray(expectedPayload?.cases) || expectedPayload.cases.length === 0) {
    throw new Error("invalid wpt delta expected file");
  }

  const expectedById = normalizeExpectedById(expectedPayload.cases);
  const expectedCasePlan = Array.isArray(corpus.casePlan) ? corpus.casePlan : [];
  const mismatches = [];
  const missingExpected = [];
  const extraExpected = [];
  const categoryCounts = new Map();

  for (const caseEntry of corpus.cases) {
    const actual = evaluateWptDeltaCase(caseEntry);
    const category = typeof caseEntry.category === "string" ? caseEntry.category : "unknown";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    const expected = expectedById.get(caseEntry.id);
    if (!expected) {
      missingExpected.push(caseEntry.id);
      continue;
    }
    const fields = [
      "sha256",
      "parseErrorCount",
      "visibleTextSha256",
      "render80Sha256",
      "render120Sha256",
      "linkCount80",
      "lineCount80"
    ];
    for (const field of fields) {
      if (actual[field] !== expected[field]) {
        mismatches.push({
          id: caseEntry.id,
          field,
          expected: expected[field],
          actual: actual[field]
        });
      }
    }
  }

  const corpusIds = new Set(corpus.cases.map((entry) => entry.id));
  for (const expected of expectedPayload.cases) {
    if (!corpusIds.has(expected.id)) {
      extraExpected.push(expected.id);
    }
  }

  const report = {
    suite: "wpt-delta",
    timestamp: new Date().toISOString(),
    corpus: {
      path: corpusPath,
      expectedPath,
      sourceRepository: corpus.source?.repository ?? null,
      sourceCommit: corpus.source?.commit ?? null,
      caseCount: corpus.cases.length,
      categories: Object.fromEntries([...categoryCounts.entries()].sort((left, right) => left[0].localeCompare(right[0]))),
      snapshotIds: [...new Set(corpus.cases.map((entry) => entry.snapshotId))].sort()
    },
    checks: {
      minimumCaseCount: {
        required: 100,
        observed: corpus.cases.length,
        ok: corpus.cases.length >= 100
      },
      categoryCoverage: {
        requiredCategories: expectedCasePlan.map((entry) => entry.category),
        observedCategories: [...categoryCounts.keys()].sort(),
        missingCategories: expectedCasePlan
          .map((entry) => entry.category)
          .filter((category) => !categoryCounts.has(category)),
        ok: expectedCasePlan
          .map((entry) => entry.category)
          .every((category) => categoryCounts.has(category))
      },
      missingExpected: {
        count: missingExpected.length,
        ids: missingExpected,
        ok: missingExpected.length === 0
      },
      extraExpected: {
        count: extraExpected.length,
        ids: extraExpected,
        ok: extraExpected.length === 0
      },
      mismatches: {
        count: mismatches.length,
        items: mismatches,
        ok: mismatches.length === 0
      }
    },
    ok: false
  };

  report.ok =
    report.checks.minimumCaseCount.ok
    && report.checks.categoryCoverage.ok
    && report.checks.missingExpected.ok
    && report.checks.extraExpected.ok
    && report.checks.mismatches.ok;

  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("wpt delta check failed");
  }

  process.stdout.write(`wpt delta check ok: ${reportPath}\n`);
}

await main();
