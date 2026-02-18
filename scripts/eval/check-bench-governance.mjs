import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";

async function main() {
  const [config, benchReport] = await Promise.all([
    readJson(resolve("evaluation.config.json")),
    readJson(resolve("reports/bench.json"))
  ]);

  const requiredBenchmarks = Array.isArray(config?.benchmarks?.required)
    ? config.benchmarks.required
    : [];
  const minimumSampleCases = Number.isInteger(config?.benchmarks?.minSampleCases)
    ? config.benchmarks.minSampleCases
    : 1;

  const benchmarkRecords = Array.isArray(benchReport?.benchmarks) ? benchReport.benchmarks : [];
  const emittedNames = benchmarkRecords
    .map((record) => (record && typeof record.name === "string" ? record.name : null))
    .filter((record) => record !== null);
  const missingBenchmarks = requiredBenchmarks.filter((name) => !emittedNames.includes(name));
  const invalidBenchmarks = benchmarkRecords.filter((record) =>
    !record ||
    typeof record.name !== "string" ||
    typeof record.cases !== "number" ||
    typeof record.durationMs !== "number" ||
    typeof record.casesPerSecond !== "number" ||
    typeof record.p95CaseMs !== "number"
  );

  const sampleCasesOk = typeof benchReport?.sampleCases === "number" && benchReport.sampleCases >= minimumSampleCases;

  const report = {
    suite: "bench-governance",
    timestamp: new Date().toISOString(),
    requiredBenchmarks,
    emittedBenchmarks: emittedNames,
    missingBenchmarks,
    invalidBenchmarkCount: invalidBenchmarks.length,
    minimumSampleCases,
    sampleCases: benchReport?.sampleCases ?? null,
    benchmarksCompared: benchmarkRecords.length,
    ok: missingBenchmarks.length === 0 && invalidBenchmarks.length === 0 && sampleCasesOk
  };

  const reportPath = resolve("reports/bench-governance.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("bench governance check failed");
  }

  process.stdout.write(`bench governance ok: ${reportPath}\n`);
}

await main();
