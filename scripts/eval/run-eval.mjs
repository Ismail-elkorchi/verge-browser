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
  runNodeScript("scripts/eval/check-runtime-matrix.mjs", [`--profile=${profile}`]);
  runNodeScript("scripts/eval/check-eval-coherence.mjs", [`--profile=${profile}`]);
  runNodeScript("scripts/eval/write-network-outcomes-report.mjs");
  runNodeScript("scripts/bench/run-bench.mjs");
  runNodeScript("scripts/eval/check-bench-governance.mjs");
  runNodeScript("scripts/eval/check-oracle-workflow-policy.mjs");
  if (profile === "release") {
    runNodeScript("scripts/eval/check-release-integrity.mjs");
  }
  runNodeScript("scripts/eval/write-capability-ladder-report.mjs", [`--profile=${profile}`]);

  const [agentReport, streamReport, runtimeMatrixReport, evalCoherenceReport, networkOutcomesReport, benchGovernanceReport, oracleWorkflowPolicyReport, releaseIntegrityReport, capabilityLadderReport] = await Promise.all([
    readJson(resolve(reportsDir, "agent.json")),
    readJson(resolve(reportsDir, "stream.json")),
    readJson(resolve(reportsDir, "runtime-matrix.json")),
    readJson(resolve(reportsDir, "eval-coherence.json")),
    readJson(resolve(reportsDir, "network-outcomes.json")),
    readJson(resolve(reportsDir, "bench-governance.json")),
    readJson(resolve(reportsDir, "oracle-workflow-policy.json")),
    profile === "release"
      ? readJson(resolve(reportsDir, "release-integrity.json"))
      : Promise.resolve(null),
    readJson(resolve(reportsDir, "capability-ladder.json"))
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
  if (runtimeMatrixReport?.overall?.ok !== true) {
    extraFailures.push("runtime matrix report failed");
  }
  if (evalCoherenceReport?.overall?.ok !== true) {
    extraFailures.push("evaluation coherence report failed");
  }
  if (networkOutcomesReport?.overall?.ok !== true) {
    extraFailures.push("network outcomes report failed");
  }
  if (benchGovernanceReport?.ok !== true) {
    extraFailures.push("bench governance report failed");
  }
  if (oracleWorkflowPolicyReport?.ok !== true) {
    extraFailures.push("oracle workflow policy report failed");
  }
  if (profile === "release" && releaseIntegrityReport?.ok !== true) {
    extraFailures.push("release integrity report failed");
  }
  if (capabilityLadderReport?.overall?.ok !== true) {
    extraFailures.push("capability ladder report failed");
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
      runtimeMatrix: resolve(reportsDir, "runtime-matrix.json"),
      evalCoherence: resolve(reportsDir, "eval-coherence.json"),
      networkOutcomes: resolve(reportsDir, "network-outcomes.json"),
      bench: resolve(reportsDir, "bench.json"),
      benchGovernance: resolve(reportsDir, "bench-governance.json"),
      oracleWorkflowPolicy: resolve(reportsDir, "oracle-workflow-policy.json"),
      capabilityLadder: resolve(reportsDir, "capability-ladder.json"),
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
