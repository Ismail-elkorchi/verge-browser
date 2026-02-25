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
  const mismatches = [];
  const missingExpected = [];
  const extraExpected = [];
  const evaluated = [];

  for (const caseEntry of corpus.cases) {
    const actual = evaluateWptDeltaCase(caseEntry);
    evaluated.push(actual);
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
      snapshotIds: [...new Set(corpus.cases.map((entry) => entry.snapshotId))].sort()
    },
    checks: {
      minimumCaseCount: {
        required: 12,
        observed: corpus.cases.length,
        ok: corpus.cases.length >= 12
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
