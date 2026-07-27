import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { evaluateRenderGates, readJson, runRenderEvaluation, writeJsonReport } from "./render-eval-lib.mjs";

function parseProfile(argv) {
  const profileArg = argv.find((argument) => argument.startsWith("--profile="));
  if (!profileArg) {
    return "ci";
  }
  const value = profileArg.slice("--profile=".length).trim();
  if (value !== "ci" && value !== "release") {
    throw new Error(`invalid profile: ${value}`);
  }
  return value;
}

function runNodeScript(scriptPath, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${scriptPath} failed with status ${String(result.status)}`);
  }
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));
  const configPath = resolve("evaluation.config.json");
  const corpusPath = resolve("scripts/oracles/corpus/render-v3.json");
  const reportsDir = resolve("reports");

  const config = await readJson(configPath);
  const profilePolicy = config?.render?.profiles?.[profile] ?? {};
  const evaluation = await runRenderEvaluation({ configPath, corpusPath, profile });

  const baselineReportPath = resolve(reportsDir, "render-baselines.json");
  const vergeReportPath = resolve(reportsDir, "render-verge.json");
  const scoreReportPath = resolve(reportsDir, "render-score.json");

  await writeJsonReport(baselineReportPath, evaluation.baselineReport);
  await writeJsonReport(vergeReportPath, evaluation.vergeReport);
  await writeJsonReport(scoreReportPath, evaluation.scoreReport);

  runNodeScript("scripts/eval/check-wpt-delta.mjs");
  runNodeScript("scripts/eval/run-fuzz-check.mjs", [`--profile=${profile}`]);
  if (profilePolicy.requireFuzzGuided === true) {
    runNodeScript("scripts/eval/run-fuzz-guided-check.mjs", [`--profile=${profile}`]);
  }
  if (profilePolicy.requireOracleLockRefreshDiff === true) {
    runNodeScript("scripts/eval/check-oracle-lock-refresh-diff.mjs", [`--profile=${profile}`]);
  }
  if (profile === "release") {
    runNodeScript("scripts/eval/check-release-integrity.mjs");
  }

  const [wptDeltaReport, fuzzReport, fuzzGuidedReport, oracleLockRefreshDiffReport, releaseIntegrityReport] =
    await Promise.all([
      readJson(resolve(reportsDir, "wpt-delta.json")),
      readJson(resolve(reportsDir, "fuzz.json")),
      profilePolicy.requireFuzzGuided === true
        ? readJson(resolve(reportsDir, "fuzz-guided.json"))
        : Promise.resolve(null),
      profilePolicy.requireOracleLockRefreshDiff === true
        ? readJson(resolve(reportsDir, "oracle-lock-refresh-diff.json"))
        : Promise.resolve(null),
      profile === "release"
        ? readJson(resolve(reportsDir, "release-integrity.json"))
        : Promise.resolve(null)
    ]);

  const gateResult = evaluateRenderGates({
    config,
    profile,
    scoreReport: evaluation.scoreReport,
    vergeReport: evaluation.vergeReport
  });

  const extraFailures = [];
  if (wptDeltaReport?.ok !== true) {
    extraFailures.push("WPT delta report failed");
  }
  if (fuzzReport?.ok !== true) {
    extraFailures.push("fuzz report failed");
  }
  if (profilePolicy.requireFuzzGuided === true && fuzzGuidedReport?.ok !== true) {
    extraFailures.push("guided fuzz report failed");
  }
  if (profilePolicy.requireOracleLockRefreshDiff === true && oracleLockRefreshDiffReport?.ok !== true) {
    extraFailures.push("oracle lock refresh diff report failed");
  }
  if (profile === "release" && releaseIntegrityReport?.ok !== true) {
    extraFailures.push("release integrity report failed");
  }

  const gates = {
    ok: gateResult.ok && extraFailures.length === 0,
    failures: [...gateResult.failures, ...extraFailures]
  };
  const reports = {
    baselines: baselineReportPath,
    verge: vergeReportPath,
    score: scoreReportPath,
    wptDelta: resolve(reportsDir, "wpt-delta.json"),
    fuzz: resolve(reportsDir, "fuzz.json"),
    ...(profilePolicy.requireFuzzGuided === true
      ? { fuzzGuided: resolve(reportsDir, "fuzz-guided.json") }
      : {}),
    ...(profilePolicy.requireOracleLockRefreshDiff === true
      ? { oracleLockRefreshDiff: resolve(reportsDir, "oracle-lock-refresh-diff.json") }
      : {}),
    ...(profile === "release"
      ? { releaseIntegrity: resolve(reportsDir, "release-integrity.json") }
      : {})
  };
  const summaryPath = resolve(reportsDir, "eval-summary.json");

  await writeJsonReport(summaryPath, {
    suite: "eval",
    profile,
    timestamp: new Date().toISOString(),
    reports,
    gates
  });

  if (!gates.ok) {
    for (const failure of gates.failures) {
      process.stderr.write(`gate-failure: ${failure}\n`);
    }
    throw new Error("evaluation failed");
  }

  process.stdout.write(`eval ${profile} ok: ${summaryPath}\n`);
}

await main();
