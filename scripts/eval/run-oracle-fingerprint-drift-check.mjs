import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";
import { computeOracleLockFingerprint, validateOracleLockFingerprintInputs } from "../oracles/real-oracle-lib.mjs";

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

  const [runtimeReport, runtimeSummary, lockFile] = await Promise.all([
    readJson(resolve("reports/oracle-runtime.json")),
    readJson(resolve("reports/eval-oracle-runtime-summary.json")),
    readJson(resolve("scripts/oracles/oracle-image.lock.json"))
  ]);

  const fingerprintInputValidation = validateOracleLockFingerprintInputs(lockFile);
  const expectedFingerprint = fingerprintInputValidation.ok
    ? computeOracleLockFingerprint(lockFile)
    : null;
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

  const lockFingerprintOk = fingerprintInputValidation.ok && (lockDeclaredFingerprint === null
    ? expectedFingerprint === runtimeFingerprint
    : lockDeclaredFingerprint === expectedFingerprint && runtimeFingerprint === lockDeclaredFingerprint);

  const report = {
    suite: "oracle-fingerprint-drift-check",
    timestamp: new Date().toISOString(),
    profile,
    fingerprint: {
      runtime: runtimeFingerprint,
      expected: expectedFingerprint,
      lockDeclared: lockDeclaredFingerprint,
      match: lockFingerprintOk
    },
    diagnostics: {
      packageCount,
      packagesWithDownloadUrl,
      fingerprintInputValidationOk: fingerprintInputValidation.ok,
      fingerprintInputValidationIssues: fingerprintInputValidation.issues,
      lockDeclaredMatchesExpected: lockDeclaredFingerprint === expectedFingerprint,
      runtimeMatchesLockDeclared: runtimeFingerprint === lockDeclaredFingerprint
    },
    engines: {
      required: requiredEngines,
      missing: missingEngines,
      weakFingerprints
    },
    ok:
      runtimeSummary?.gates?.ok === true &&
      runtimeSummary?.profile === profile &&
      lockFingerprintOk &&
      missingEngines.length === 0 &&
      weakFingerprints.length === 0
  };

  const reportPath = resolve("reports/eval-oracle-fingerprint-summary.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("oracle fingerprint drift check failed");
  }

  process.stdout.write("oracle fingerprint drift check ok\n");
}

await main();
