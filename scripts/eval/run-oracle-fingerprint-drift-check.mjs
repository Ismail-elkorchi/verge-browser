import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";
import { computeOracleLockFingerprint } from "../oracles/real-oracle-lib.mjs";

function parseArgs(argv) {
  const forwardedArgs = [];
  for (const argument of argv) {
    if (
      argument.startsWith("--profile=") ||
      argument.startsWith("--sample-cases=") ||
      argument.startsWith("--widths=") ||
      argument === "--rebuild-lock"
    ) {
      forwardedArgs.push(argument);
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
  return forwardedArgs;
}

function runOracleRuntimeValidation(forwardedArgs) {
  const result = spawnSync(
    process.execPath,
    ["scripts/eval/run-oracle-runtime-validation.mjs", ...forwardedArgs],
    {
      encoding: "utf8",
      stdio: "inherit"
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`oracle runtime precheck failed with status ${String(result.status)}`);
  }
}

async function main() {
  const forwardedArgs = parseArgs(process.argv.slice(2));
  runOracleRuntimeValidation(forwardedArgs);

  const [runtimeReport, lockFile] = await Promise.all([
    readJson(resolve("reports/oracle-runtime.json")),
    readJson(resolve("scripts/oracles/oracle-image.lock.json"))
  ]);

  const expectedFingerprint = computeOracleLockFingerprint(lockFile);
  const lockDeclaredFingerprint = typeof lockFile?.fingerprint === "string" ? lockFile.fingerprint : null;
  const packageRecords = Array.isArray(lockFile?.packages) ? lockFile.packages : [];
  const packageCount = packageRecords.length;
  const packagesWithDownloadUrl = packageRecords.filter((packageRecord) => typeof packageRecord?.downloadUrl === "string" && packageRecord.downloadUrl.length > 0).length;
  const runtimeFingerprint = runtimeReport?.image?.fingerprint ?? null;
  const engines = runtimeReport?.engines ?? {};
  const requiredEngines = ["lynx", "w3m", "links2"];
  const missingEngines = requiredEngines.filter((engineName) => !engines[engineName]);
  const weakFingerprints = requiredEngines.filter((engineName) => {
    const engine = engines[engineName];
    if (!engine) return true;
    return (
      typeof engine.sha256 !== "string" ||
      engine.sha256.length !== 64 ||
      typeof engine.sizeBytes !== "number" ||
      engine.sizeBytes <= 0 ||
      typeof engine.version !== "string" ||
      engine.version.trim().length === 0
    );
  });

  const lockFingerprintOk = lockDeclaredFingerprint === null
    ? expectedFingerprint === runtimeFingerprint
    : lockDeclaredFingerprint === expectedFingerprint && runtimeFingerprint === lockDeclaredFingerprint;

  const report = {
    suite: "oracle-fingerprint-drift-check",
    timestamp: new Date().toISOString(),
    fingerprint: {
      runtime: runtimeFingerprint,
      expected: expectedFingerprint,
      lockDeclared: lockDeclaredFingerprint,
      match: lockFingerprintOk
    },
    diagnostics: {
      packageCount,
      packagesWithDownloadUrl,
      lockDeclaredMatchesExpected: lockDeclaredFingerprint === expectedFingerprint,
      runtimeMatchesLockDeclared: runtimeFingerprint === lockDeclaredFingerprint
    },
    engines: {
      required: requiredEngines,
      missing: missingEngines,
      weakFingerprints
    },
    ok: lockFingerprintOk && missingEngines.length === 0 && weakFingerprints.length === 0
  };

  const reportPath = resolve("reports/eval-oracle-fingerprint-summary.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("oracle fingerprint drift check failed");
  }

  process.stdout.write("oracle fingerprint drift check ok\n");
}

await main();
