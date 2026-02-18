import { resolve } from "node:path";

import { parse } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";
import { hashInt, readJson, writeJsonReport } from "../eval/render-eval-lib.mjs";

const WIDTHS = [80, 120];
const SAMPLE_CASES = 300;

function pickCases(cases, count) {
  return [...cases]
    .sort((left, right) => {
      const leftHash = hashInt(left.id);
      const rightHash = hashInt(right.id);
      if (leftHash !== rightHash) return leftHash - rightHash;
      return left.id.localeCompare(right.id);
    })
    .slice(0, Math.min(count, cases.length));
}

function nowNs() {
  return process.hrtime.bigint();
}

function nsToMs(nsValue) {
  return Number(nsValue) / 1_000_000;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sortedValues = [...values].sort((left, right) => left - right);
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * ratio));
  return sortedValues[index] ?? 0;
}

async function main() {
  const corpus = await readJson(resolve("scripts/oracles/corpus/render-v3.json"));
  if (!Array.isArray(corpus?.cases) || corpus.cases.length === 0) {
    throw new Error("render-v3 corpus is missing or empty");
  }

  const selectedCases = pickCases(corpus.cases, SAMPLE_CASES);
  const benchmarks = [];

  for (const width of WIDTHS) {
    const perCaseMs = [];
    const startedAt = nowNs();

    for (const caseItem of selectedCases) {
      const caseStart = nowNs();
      const tree = parse(caseItem.html, {
        captureSpans: false,
        trace: false
      });
      renderDocumentToTerminal({
        tree,
        requestUrl: `https://bench.example/${caseItem.id}`,
        finalUrl: `https://bench.example/${caseItem.id}`,
        status: 200,
        statusText: "OK",
        fetchedAtIso: "1970-01-01T00:00:00.000Z",
        width
      });
      const caseDurationMs = nsToMs(nowNs() - caseStart);
      perCaseMs.push(caseDurationMs);
    }

    const durationMs = nsToMs(nowNs() - startedAt);
    const casesPerSecond = durationMs <= 0 ? 0 : (selectedCases.length / durationMs) * 1000;

    benchmarks.push({
      name: `render-width-${String(width)}`,
      width,
      cases: selectedCases.length,
      durationMs,
      casesPerSecond,
      p95CaseMs: percentile(perCaseMs, 0.95)
    });
  }

  const report = {
    suite: "bench",
    timestamp: new Date().toISOString(),
    sampleCases: selectedCases.length,
    benchmarks
  };

  const reportPath = resolve("reports/bench.json");
  await writeJsonReport(reportPath, report);
  process.stdout.write(`bench report written: ${reportPath}\n`);
}

await main();
