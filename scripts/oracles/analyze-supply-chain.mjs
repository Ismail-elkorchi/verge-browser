import { resolve } from "node:path";

import { readJson, writeJsonReport } from "../eval/render-eval-lib.mjs";

async function main() {
  const [config, lockFile, runtimeReport] = await Promise.all([
    readJson(resolve("evaluation.config.json")),
    readJson(resolve("scripts/oracles/oracle-image.lock.json")),
    readJson(resolve("reports/oracle-runtime.json"))
  ]);

  const maxOraclePackageCount = config.oracleSupplyChain?.maxOraclePackageCount ?? 110;
  const requiredRootPackages = config.oracleSupplyChain?.requiredRootPackages ?? ["lynx", "w3m", "links2"];
  const lockRootPackages = Array.isArray(lockFile.rootPackages) ? lockFile.rootPackages : [];
  const lockPackages = Array.isArray(lockFile.packages) ? lockFile.packages : [];

  const missingRootPackages = requiredRootPackages.filter((packageName) => !lockRootPackages.includes(packageName));
  const hasAllEngineFingerprints = requiredRootPackages.every((engineName) => runtimeReport.engines?.[engineName]);
  const packageCountOk = lockPackages.length <= maxOraclePackageCount;

  const report = {
    suite: "oracle-supply-chain",
    timestamp: new Date().toISOString(),
    maxOraclePackageCount,
    packageCount: lockPackages.length,
    packageCountOk,
    requiredRootPackages,
    lockRootPackages,
    missingRootPackages,
    hasAllEngineFingerprints,
    imageFingerprint: runtimeReport.image?.fingerprint ?? null,
    ok: packageCountOk && missingRootPackages.length === 0 && hasAllEngineFingerprints
  };

  await writeJsonReport(resolve("reports/oracle-supply-chain.json"), report);

  if (!report.ok) {
    throw new Error(
      `oracle supply-chain check failed: packageCount=${String(report.packageCount)} missingRoots=${missingRootPackages.join(",")}`
    );
  }

  process.stdout.write("oracle supply-chain check ok\n");
}

await main();
