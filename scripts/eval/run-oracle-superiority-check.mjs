import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";

function parseProfile(argv) {
  let profile = "release";
  for (const argument of argv) {
    if (argument.startsWith("--profile=")) {
      profile = argument.slice("--profile=".length);
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
  if (profile !== "ci" && profile !== "release") {
    throw new Error(`invalid profile: ${profile}`);
  }
  return profile;
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));

  const [config, scoreReport, runtimeValidationSummary] = await Promise.all([
    readJson(resolve("evaluation.config.json")),
    readJson(resolve("reports/render-score-real.json")),
    readJson(resolve("reports/eval-oracle-runtime-summary.json"))
  ]);

  const delta = config.render.comparativeWinDelta;
  const requiredMetrics = Object.keys(config.render.metrics);
  const vergeMetrics = scoreReport.metrics.verge;
  const baselineNames = Object.keys(scoreReport.metrics).filter((engineName) => engineName !== "verge");

  const failures = [];
  if (runtimeValidationSummary?.profile !== profile) {
    failures.push(`oracle runtime report profile mismatch: expected ${profile}`);
  }
  const metrics = {};
  for (const metricName of requiredMetrics) {
    const bestBaseline = Math.max(...baselineNames.map((engineName) => scoreReport.metrics[engineName][metricName]));
    const metricOk = vergeMetrics[metricName] >= bestBaseline + delta;
    metrics[metricName] = {
      verge: vergeMetrics[metricName],
      bestBaseline,
      required: bestBaseline + delta,
      ok: metricOk
    };
    if (!metricOk) {
      failures.push(
        `superiority failed for ${metricName}: verge=${vergeMetrics[metricName].toFixed(4)} baseline=${bestBaseline.toFixed(4)} delta=${String(delta)}`
      );
    }
  }

  const report = {
    suite: "oracle-superiority-check",
    timestamp: new Date().toISOString(),
    profile,
    runtimeValidationOk: runtimeValidationSummary?.gates?.ok === true,
    metrics,
    failures,
    ok: failures.length === 0 && runtimeValidationSummary?.gates?.ok === true
  };

  const reportPath = resolve("reports/eval-oracle-superiority-summary.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    for (const failure of failures) {
      process.stderr.write(`oracle-superiority-failure: ${failure}\n`);
    }
    throw new Error("oracle superiority check failed");
  }

  process.stdout.write(`oracle superiority check ok: ${reportPath}\n`);
}

await main();
