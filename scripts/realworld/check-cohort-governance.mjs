import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildCohortGovernance } from "./cohort-governance-lib.mjs";
import {
  corpusPath,
  readNdjson,
  resolveCorpusDir,
  sha256HexString,
  writeJson
} from "./lib.mjs";

function parseArgs(argv) {
  const args = {
    corpusDir: process.env.VERGE_CORPUS_DIR ?? resolveCorpusDir(),
    cohortConfigPath: resolve(process.cwd(), "scripts/realworld/cohorts/cohort-governance-v4.json")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`missing value for argument --${key}`);
    }
    index += 1;
    if (key === "corpus-dir") {
      args.corpusDir = resolve(process.cwd(), value);
      continue;
    }
    if (key === "cohort-config") {
      args.cohortConfigPath = resolve(process.cwd(), value);
      continue;
    }
    if (key === "page-surface-report") {
      args.pageSurfacePath = resolve(process.cwd(), value);
      continue;
    }
    if (key === "policy-summary-report") {
      args.policySummaryPath = resolve(process.cwd(), value);
      continue;
    }
    if (key === "policy-ndjson-report") {
      args.policyNdjsonPath = resolve(process.cwd(), value);
      continue;
    }
    if (key === "residual-report") {
      args.residualPath = resolve(process.cwd(), value);
      continue;
    }
    if (key === "governance-report") {
      args.governanceReportPath = resolve(process.cwd(), value);
      continue;
    }
    if (key === "snapshot-report") {
      args.snapshotReportPath = resolve(process.cwd(), value);
      continue;
    }
    throw new Error(`unknown argument --${key}`);
  }

  return args;
}

async function readJson(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source);
}

async function hashFile(path) {
  const source = await readFile(path, "utf8");
  return sha256HexString(source);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pageSurfacePath = args.pageSurfacePath ?? corpusPath(args.corpusDir, "reports/page-surface-v2.json");
  const policySummaryPath =
    args.policySummaryPath ?? corpusPath(args.corpusDir, "reports/visible-text-policy-compare.json");
  const policyNdjsonPath =
    args.policyNdjsonPath ?? corpusPath(args.corpusDir, "reports/visible-text-policy-compare.ndjson");
  const residualPath =
    args.residualPath ?? corpusPath(args.corpusDir, "reports/visible-text-residual-taxonomy.json");
  const governanceReportPath =
    args.governanceReportPath ?? corpusPath(args.corpusDir, "reports/cohort-governance-v4.json");
  const snapshotReportPath =
    args.snapshotReportPath ?? corpusPath(args.corpusDir, "reports/cohort-snapshot-fingerprint-v1.json");

  const [policyConfig, pageSurfaceReport, policySummary, policyRecords, residualReport] = await Promise.all([
    readJson(args.cohortConfigPath),
    readJson(pageSurfacePath),
    readJson(policySummaryPath),
    readNdjson(policyNdjsonPath),
    readJson(residualPath)
  ]);

  policyConfig.__path = args.cohortConfigPath;

  const inputHashes = {
    cohortConfigSha256: await hashFile(args.cohortConfigPath),
    pageSurfaceReportSha256: await hashFile(pageSurfacePath),
    policySummaryReportSha256: await hashFile(policySummaryPath),
    policyNdjsonReportSha256: await hashFile(policyNdjsonPath),
    residualReportSha256: await hashFile(residualPath)
  };

  const { governanceReport, snapshotReport } = buildCohortGovernance({
    policyConfig,
    pageSurfaceReport,
    policySummary,
    policyRecords,
    residualReport,
    inputHashes
  });

  await writeJson(governanceReportPath, governanceReport);
  await writeJson(snapshotReportPath, snapshotReport);

  if (!governanceReport.ok) {
    const failedChecks = Object.entries(governanceReport.checks)
      .filter(([, value]) => value.pass !== true)
      .map(([key]) => key);
    throw new Error(`cohort governance failed: ${failedChecks.join(", ")}`);
  }

  process.stdout.write(
    `cohort-governance-v4 ok: cohorts=${String(governanceReport.cohorts.length)} records=${String(
      governanceReport.counts.comparedRecords
    )} snapshotFingerprint=${governanceReport.snapshot.fingerprint}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cohort-governance-v4 failed: ${message}\n`);
  process.exit(1);
});

