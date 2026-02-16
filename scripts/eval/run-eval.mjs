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
  const evaluation = await runRenderEvaluation({
    configPath,
    corpusPath,
    profile
  });

  const baselineReportPath = resolve(reportsDir, "render-baselines.json");
  const vergeReportPath = resolve(reportsDir, "render-verge.json");
  const scoreReportPath = resolve(reportsDir, "render-score.json");

  await writeJsonReport(baselineReportPath, evaluation.baselineReport);
  await writeJsonReport(vergeReportPath, evaluation.vergeReport);
  await writeJsonReport(scoreReportPath, evaluation.scoreReport);

  runNodeScript("scripts/eval/write-agent-report.mjs");
  runNodeScript("scripts/eval/write-stream-report.mjs");
  runNodeScript("scripts/bench/run-bench.mjs");
  runNodeScript("scripts/eval/check-bench-governance.mjs");
  if (profile === "release") {
    runNodeScript("scripts/eval/check-release-integrity.mjs");
  }
  runNodeScript("scripts/eval/write-phase-ladder-report.mjs", [`--profile=${profile}`]);

  const [agentReport, streamReport, benchGovernanceReport, releaseIntegrityReport, phaseLadderReport] = await Promise.all([
    readJson(resolve(reportsDir, "agent.json")),
    readJson(resolve(reportsDir, "stream.json")),
    readJson(resolve(reportsDir, "bench-governance.json")),
    profile === "release"
      ? readJson(resolve(reportsDir, "release-integrity.json"))
      : Promise.resolve(null),
    readJson(resolve(reportsDir, "phase-ladder.json"))
  ]);

  const gateResult = evaluateRenderGates({
    config,
    profile,
    scoreReport: evaluation.scoreReport,
    vergeReport: evaluation.vergeReport
  });

  const extraFailures = [];
  if (agentReport?.overall?.ok !== true) {
    extraFailures.push("agent report failed");
  }
  if (streamReport?.overall?.ok !== true) {
    extraFailures.push("stream report failed");
  }
  if (benchGovernanceReport?.ok !== true) {
    extraFailures.push("bench governance report failed");
  }
  if (profile === "release" && releaseIntegrityReport?.ok !== true) {
    extraFailures.push("release integrity report failed");
  }
  if (phaseLadderReport?.overall?.ok !== true) {
    extraFailures.push("phase ladder report failed");
  }

  const combinedGateResult = {
    ok: gateResult.ok && extraFailures.length === 0,
    failures: [...gateResult.failures, ...extraFailures]
  };

  const summary = {
    suite: "eval",
    profile,
    timestamp: new Date().toISOString(),
    reports: {
      baselines: baselineReportPath,
      verge: vergeReportPath,
      score: scoreReportPath,
      agent: resolve(reportsDir, "agent.json"),
      stream: resolve(reportsDir, "stream.json"),
      bench: resolve(reportsDir, "bench.json"),
      benchGovernance: resolve(reportsDir, "bench-governance.json"),
      phaseLadder: resolve(reportsDir, "phase-ladder.json"),
      ...(profile === "release" ? { releaseIntegrity: resolve(reportsDir, "release-integrity.json") } : {})
    },
    gates: combinedGateResult
  };

  const summaryPath = resolve(reportsDir, "eval-summary.json");
  await writeJsonReport(summaryPath, summary);

  if (!combinedGateResult.ok) {
    for (const failure of combinedGateResult.failures) {
      process.stderr.write(`gate-failure: ${failure}\n`);
    }
    throw new Error("evaluation failed");
  }

  process.stdout.write(`eval ${profile} ok: ${summaryPath}\n`);
}

await main();
