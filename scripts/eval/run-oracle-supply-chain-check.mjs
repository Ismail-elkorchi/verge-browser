import { spawnSync } from "node:child_process";
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
  runNodeScript("scripts/oracles/analyze-supply-chain.mjs");

  const [runtimeValidationSummary, supplyChainReport] = await Promise.all([
    readJson(resolve("reports/eval-oracle-runtime-summary.json")),
    readJson(resolve("reports/oracle-supply-chain.json"))
  ]);

  const report = {
    suite: "oracle-supply-chain-check",
    timestamp: new Date().toISOString(),
    profile,
    runtimeValidation: {
      ok: runtimeValidationSummary?.gates?.ok === true
    },
    supplyChain: {
      ok: supplyChainReport?.ok === true,
      packageCount: supplyChainReport?.packageCount ?? null,
      maxOraclePackageCount: supplyChainReport?.maxOraclePackageCount ?? null,
      missingRootPackages: supplyChainReport?.missingRootPackages ?? [],
      provenanceOk: supplyChainReport?.provenance?.ok === true,
      provenanceFailures: supplyChainReport?.provenance?.failures ?? []
    },
    ok:
      runtimeValidationSummary?.gates?.ok === true &&
      runtimeValidationSummary?.profile === profile &&
      supplyChainReport?.ok === true
  };

  const reportPath = resolve("reports/eval-oracle-supply-chain-summary.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("oracle supply-chain check failed");
  }

  process.stdout.write("oracle supply-chain check ok\n");
}

await main();
