import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";

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

function runPhase31Validation(forwardedArgs) {
  const result = spawnSync(
    process.execPath,
    ["scripts/eval/run-phase31-real-oracles.mjs", ...forwardedArgs],
    {
      encoding: "utf8",
      stdio: "inherit"
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`phase31 precheck failed with status ${String(result.status)}`);
  }
}

function lockFingerprint(lockFile) {
  const basis = (Array.isArray(lockFile.packages) ? lockFile.packages : [])
    .map((packageRecord) => `${packageRecord.name}@${packageRecord.version}:${packageRecord.debSha256}`)
    .join("\n");
  return createHash("sha256").update(basis).digest("hex");
}

async function main() {
  const forwardedArgs = parseArgs(process.argv.slice(2));
  runPhase31Validation(forwardedArgs);

  const [runtimeReport, lockFile] = await Promise.all([
    readJson(resolve("reports/oracle-runtime.json")),
    readJson(resolve("scripts/oracles/oracle-image.lock.json"))
  ]);

  const expectedFingerprint = lockFingerprint(lockFile);
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

  const report = {
    suite: "phase33-fingerprint-drift",
    timestamp: new Date().toISOString(),
    fingerprint: {
      runtime: runtimeFingerprint,
      expected: expectedFingerprint,
      match: runtimeFingerprint === expectedFingerprint
    },
    engines: {
      required: requiredEngines,
      missing: missingEngines,
      weakFingerprints
    },
    ok: runtimeFingerprint === expectedFingerprint && missingEngines.length === 0 && weakFingerprints.length === 0
  };

  const reportPath = resolve("reports/eval-phase33-summary.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("phase33 fingerprint drift check failed");
  }

  process.stdout.write("phase33 fingerprint drift check ok\n");
}

await main();
