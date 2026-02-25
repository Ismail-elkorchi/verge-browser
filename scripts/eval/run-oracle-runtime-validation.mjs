import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { evaluateRenderGates, hashInt, readJson, runRenderEvaluation, writeJsonReport } from "./render-eval-lib.mjs";
import { collectEngineFingerprints, defaultOracleRootPackages, ensureOracleImage, oracleRunnerPolicy, runEngineDump } from "../oracles/real-oracle-lib.mjs";

function parseArgs(argv) {
  const options = {
    profile: "release",
    sampleCases: null,
    rebuildLock: false,
    widths: [80, 120]
  };

  for (const argument of argv) {
    if (argument.startsWith("--profile=")) {
      const profile = argument.slice("--profile=".length).trim();
      if (profile !== "ci" && profile !== "release") {
        throw new Error(`invalid profile: ${profile}`);
      }
      options.profile = profile;
      continue;
    }
    if (argument.startsWith("--sample-cases=")) {
      const value = Number.parseInt(argument.slice("--sample-cases=".length).trim(), 10);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`invalid sample-cases value: ${argument}`);
      }
      options.sampleCases = value;
      continue;
    }
    if (argument.startsWith("--widths=")) {
      const widthValues = argument
        .slice("--widths=".length)
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isSafeInteger(value) && value >= 40);
      if (widthValues.length === 0) {
        throw new Error(`invalid widths value: ${argument}`);
      }
      options.widths = [...new Set(widthValues)];
      continue;
    }
    if (argument === "--rebuild-lock") {
      options.rebuildLock = true;
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }

  if (options.sampleCases === null) {
    options.sampleCases = options.profile === "release" ? 320 : 160;
  }

  return options;
}

function sampleCases(cases, sampleCount) {
  const rankedCases = [...cases].sort((left, right) => {
    const leftHash = hashInt(left.id);
    const rightHash = hashInt(right.id);
    if (leftHash !== rightHash) return leftHash - rightHash;
    return left.id.localeCompare(right.id);
  });
  return rankedCases.slice(0, Math.min(sampleCount, rankedCases.length));
}

function createRuntimeValidationConfig(baseConfig, profile, widths, sampleCaseCount) {
  const nextConfig = JSON.parse(JSON.stringify(baseConfig));
  nextConfig.render.widths = widths;
  nextConfig.render.profiles[profile] = {
    includeHoldout: true,
    minExecutedFraction: 1,
    minCases: sampleCaseCount * widths.length
  };
  return nextConfig;
}

async function prepareCaseFiles(caseItems, workDir) {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const htmlPathByCaseId = new Map();
  for (const caseItem of caseItems) {
    const filePath = join(workDir, `${caseItem.id}.html`);
    await writeFile(filePath, caseItem.html, "utf8");
    htmlPathByCaseId.set(caseItem.id, filePath);
  }
  return htmlPathByCaseId;
}

function ensureRealBaselineMetadata(imageState, engineFingerprints) {
  const metadata = {};
  for (const engineName of defaultOracleRootPackages()) {
    const fingerprint = engineFingerprints[engineName];
    if (!fingerprint) {
      throw new Error(`missing engine fingerprint for ${engineName}`);
    }
    metadata[engineName] = {
      version: fingerprint.version,
      runner: "real-binary",
      binaryPath: fingerprint.path,
      binarySha256: fingerprint.sha256,
      binarySizeBytes: fingerprint.sizeBytes,
      imageFingerprint: imageState.fingerprint
    };
  }
  return metadata;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolve("evaluation.config.json");
  const corpusPath = resolve("scripts/oracles/corpus/render-v3.json");
  const reportsDir = resolve("reports");

  const [baseConfig, baseCorpus] = await Promise.all([
    readJson(configPath),
    readJson(corpusPath)
  ]);

  if (!Array.isArray(baseCorpus?.cases) || baseCorpus.cases.length === 0) {
    throw new Error("render corpus is empty");
  }

  const selectedCaseItems = sampleCases(baseCorpus.cases, options.sampleCases).map((caseItem) => ({
    ...caseItem,
    widths: options.widths
  }));
  const selectedCorpus = {
    ...baseCorpus,
    suite: `${baseCorpus.suite ?? "render-v3"}-oracle-runtime`,
    cases: selectedCaseItems
  };
  const selectedConfig = createRuntimeValidationConfig(baseConfig, options.profile, options.widths, selectedCaseItems.length);

  const imageState = await ensureOracleImage({
    rebuildLock: options.rebuildLock
  });
  const engineFingerprints = await collectEngineFingerprints({
    rootfsPath: imageState.rootfsPath
  });
  const baselineMetadataByEngine = ensureRealBaselineMetadata(imageState, engineFingerprints);

  const caseWorkDir = resolve("tmp/oracle-image/work/html");
  const htmlPathByCaseId = await prepareCaseFiles(selectedCaseItems, caseWorkDir);

  const evaluation = await runRenderEvaluation({
    profile: options.profile,
    config: selectedConfig,
    corpus: selectedCorpus,
    minimumCorpusCases: selectedCaseItems.length,
    baselineRunner: "real-binary",
    baselineMetadataByEngine,
    resolveBaselineOutput: ({ engineName, width, caseItem }) => {
      const htmlPath = htmlPathByCaseId.get(caseItem.id);
      if (!htmlPath) {
        throw new Error(`missing html file for case ${caseItem.id}`);
      }
      const lines = runEngineDump({
        rootfsPath: imageState.rootfsPath,
        engineName,
        width,
        htmlPath
      });
      return { lines };
    }
  });

  const gateResult = evaluateRenderGates({
    config: selectedConfig,
    profile: options.profile,
    scoreReport: evaluation.scoreReport,
    vergeReport: evaluation.vergeReport,
    enforceComparativeWin: false
  });

  const expectedEngineRecordCount = evaluation.scoreReport.coverage.executedSurface;
  const engineRecordChecks = Object.fromEntries(
    Object.entries(evaluation.baselineReport.casesByEngine).map(([engineName, records]) => [
      engineName,
      {
        expected: expectedEngineRecordCount,
        actual: Array.isArray(records) ? records.length : 0,
        ok: Array.isArray(records) && records.length === expectedEngineRecordCount
      }
    ])
  );

  const runtimeReport = {
    suite: "oracle-runtime",
    timestamp: new Date().toISOString(),
    profile: options.profile,
    runnerPolicy: oracleRunnerPolicy(),
    image: {
      rootfsPath: imageState.rootfsPath,
      lockPath: imageState.lockPath,
      fingerprint: imageState.fingerprint,
      packageCount: imageState.packageCount,
      rootPackages: imageState.rootPackages,
      sourcePolicy: imageState.lock?.sourcePolicy ?? null,
      releaseMetadata: Array.isArray(imageState.lock?.releaseMetadata)
        ? imageState.lock.releaseMetadata.map((releaseRecord) => ({
            suite: releaseRecord.suite,
            inReleaseUrl: releaseRecord.inReleaseUrl,
            inReleaseSha256: releaseRecord.inReleaseSha256,
            signatureKey: releaseRecord.signatureKey,
            packageIndexes: releaseRecord.packageIndexes
          }))
        : []
    },
    engines: engineFingerprints
  };

  await writeJsonReport(resolve(reportsDir, "oracle-runtime.json"), runtimeReport);
  const expectedRunnerPolicy = oracleRunnerPolicy();
  const runnerPolicyMatchesExpected = JSON.stringify(runtimeReport.runnerPolicy) === JSON.stringify(expectedRunnerPolicy);
  const runnerPolicyReport = {
    suite: "oracle-runner-policy",
    timestamp: new Date().toISOString(),
    runtimeReport: resolve(reportsDir, "oracle-runtime.json"),
    expectedPolicy: expectedRunnerPolicy,
    observedPolicy: runtimeReport.runnerPolicy,
    checks: {
      hasRunnerPolicy: runtimeReport.runnerPolicy !== null,
      policyMatchesExpected: runnerPolicyMatchesExpected
    },
    ok: runtimeReport.runnerPolicy !== null && runnerPolicyMatchesExpected
  };
  await writeJsonReport(resolve(reportsDir, "oracle-runner-policy.json"), runnerPolicyReport);
  await writeJsonReport(resolve(reportsDir, "render-baselines-real.json"), evaluation.baselineReport);
  await writeJsonReport(resolve(reportsDir, "render-verge-real.json"), evaluation.vergeReport);
  await writeJsonReport(resolve(reportsDir, "render-score-real.json"), evaluation.scoreReport);

  const engineRecordsOk = Object.values(engineRecordChecks).every((entry) => entry.ok);
  const summary = {
    suite: "oracle-runtime-validation",
    timestamp: new Date().toISOString(),
    profile: options.profile,
    selection: {
      sampleCases: selectedCaseItems.length,
      widths: options.widths
    },
    gates: gateResult,
    runtime: {
      hasAllEngineFingerprints: Object.keys(engineFingerprints).length === defaultOracleRootPackages().length,
      hasSnapshotPolicy: imageState.lock?.sourcePolicy?.mode === "snapshot-replay",
      hasReleaseMetadata: Array.isArray(imageState.lock?.releaseMetadata) && imageState.lock.releaseMetadata.length > 0,
      hasRunnerPolicy: runtimeReport.runnerPolicy !== null,
      runnerPolicyMatchesExpected,
      engineRecordChecks
    },
    reports: {
      runtime: resolve(reportsDir, "oracle-runtime.json"),
      runnerPolicy: resolve(reportsDir, "oracle-runner-policy.json"),
      baselines: resolve(reportsDir, "render-baselines-real.json"),
      verge: resolve(reportsDir, "render-verge-real.json"),
      score: resolve(reportsDir, "render-score-real.json")
    }
  };

  await writeJsonReport(resolve(reportsDir, "eval-oracle-runtime-summary.json"), summary);

  if (!gateResult.ok || !engineRecordsOk || !runnerPolicyReport.ok) {
    for (const failure of gateResult.failures) {
      process.stderr.write(`gate-failure: ${failure}\n`);
    }
    if (!engineRecordsOk) {
      process.stderr.write(`record-failure: ${JSON.stringify(engineRecordChecks)}\n`);
    }
    if (!runnerPolicyReport.ok) {
      process.stderr.write(`runner-policy-failure: ${JSON.stringify(runnerPolicyReport.checks)}\n`);
    }
    throw new Error("oracle runtime validation failed");
  }

  process.stdout.write("oracle runtime validation ok\n");
}

await main();
