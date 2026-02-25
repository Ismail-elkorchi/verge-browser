import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { readJson, writeJsonReport } from "../eval/render-eval-lib.mjs";

const SNAPSHOT_ID_PATTERN = /^\d{8}T\d{6}Z$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SIGNATURE_KEY_PATTERN = /^[0-9A-F]{16,40}$/i;

function hasHttpsUrl(value) {
  return typeof value === "string" && value.startsWith("https://");
}

function normalizeProvenancePolicy(policy) {
  return {
    requireSnapshotReplayMode: policy?.requireSnapshotReplayMode !== false,
    requireHttpsSnapshotRoot: policy?.requireHttpsSnapshotRoot !== false,
    requireSnapshotId: policy?.requireSnapshotId !== false,
    requireKeyringPath: policy?.requireKeyringPath !== false,
    requireReleaseMetadata: policy?.requireReleaseMetadata !== false,
    requireSignatureKeyHex: policy?.requireSignatureKeyHex !== false,
    rejectUnknownSignatureKey: policy?.rejectUnknownSignatureKey !== false,
    requirePackageIndexes: policy?.requirePackageIndexes !== false,
    requireHttpsReleaseUrls: policy?.requireHttpsReleaseUrls !== false,
    requireHttpsIndexUrls: policy?.requireHttpsIndexUrls !== false,
    requireIndexSha256: policy?.requireIndexSha256 !== false,
    requireHttpsPackageDownloadUrls: policy?.requireHttpsPackageDownloadUrls !== false
  };
}

export function evaluateOracleSupplyChain({ config, lockFile, runtimeReport }) {
  const oracleSupplyChain = config?.oracleSupplyChain ?? {};
  const provenancePolicy = normalizeProvenancePolicy(oracleSupplyChain.provenancePolicy);
  const maxOraclePackageCount = oracleSupplyChain.maxOraclePackageCount ?? 110;
  const requiredRootPackages = oracleSupplyChain.requiredRootPackages ?? ["lynx", "w3m", "links2"];

  const lockRootPackages = Array.isArray(lockFile?.rootPackages) ? lockFile.rootPackages : [];
  const lockPackages = Array.isArray(lockFile?.packages) ? lockFile.packages : [];
  const releaseMetadata = Array.isArray(lockFile?.releaseMetadata) ? lockFile.releaseMetadata : [];

  const missingRootPackages = requiredRootPackages.filter((packageName) => !lockRootPackages.includes(packageName));
  const hasAllEngineFingerprints = requiredRootPackages.every((engineName) => runtimeReport.engines?.[engineName]);
  const packageCountOk = lockPackages.length <= maxOraclePackageCount;

  const provenanceFailures = [];
  const signatureKeys = [];
  let packageIndexesCount = 0;

  const sourcePolicy = lockFile?.sourcePolicy ?? {};
  if (provenancePolicy.requireSnapshotReplayMode && sourcePolicy.mode !== "snapshot-replay") {
    provenanceFailures.push("sourcePolicy.mode must be snapshot-replay");
  }
  if (provenancePolicy.requireHttpsSnapshotRoot && !hasHttpsUrl(sourcePolicy.snapshotRoot)) {
    provenanceFailures.push("sourcePolicy.snapshotRoot must be an https URL");
  }
  if (provenancePolicy.requireSnapshotId && !SNAPSHOT_ID_PATTERN.test(String(sourcePolicy.snapshotId ?? ""))) {
    provenanceFailures.push("sourcePolicy.snapshotId must match YYYYMMDDTHHMMSSZ");
  }
  if (provenancePolicy.requireKeyringPath && typeof sourcePolicy.keyringPath !== "string") {
    provenanceFailures.push("sourcePolicy.keyringPath must be a non-empty string");
  }

  if (provenancePolicy.requireReleaseMetadata && releaseMetadata.length === 0) {
    provenanceFailures.push("releaseMetadata must be a non-empty array");
  }

  for (const [releaseIndex, releaseRecord] of releaseMetadata.entries()) {
    const signatureKey = String(releaseRecord?.signatureKey ?? "");
    signatureKeys.push(signatureKey);

    if (provenancePolicy.requireHttpsReleaseUrls && !hasHttpsUrl(releaseRecord?.inReleaseUrl)) {
      provenanceFailures.push(`releaseMetadata[${String(releaseIndex)}].inReleaseUrl must be an https URL`);
    }
    if (provenancePolicy.requireSignatureKeyHex) {
      if (signatureKey.length === 0) {
        provenanceFailures.push(`releaseMetadata[${String(releaseIndex)}].signatureKey must be present`);
      } else {
        if (provenancePolicy.rejectUnknownSignatureKey && signatureKey.toUpperCase() === "UNKNOWN") {
          provenanceFailures.push(`releaseMetadata[${String(releaseIndex)}].signatureKey must not be UNKNOWN`);
        }
        if (!SIGNATURE_KEY_PATTERN.test(signatureKey)) {
          provenanceFailures.push(`releaseMetadata[${String(releaseIndex)}].signatureKey must be 16-40 hex chars`);
        }
      }
    }

    const packageIndexes = Array.isArray(releaseRecord?.packageIndexes) ? releaseRecord.packageIndexes : [];
    packageIndexesCount += packageIndexes.length;

    if (provenancePolicy.requirePackageIndexes && packageIndexes.length === 0) {
      provenanceFailures.push(`releaseMetadata[${String(releaseIndex)}].packageIndexes must be non-empty`);
    }

    for (const [indexOffset, packageIndex] of packageIndexes.entries()) {
      const indexPath = `releaseMetadata[${String(releaseIndex)}].packageIndexes[${String(indexOffset)}]`;
      if (provenancePolicy.requireHttpsIndexUrls && !hasHttpsUrl(packageIndex?.indexUrl)) {
        provenanceFailures.push(`${indexPath}.indexUrl must be an https URL`);
      }
      if (provenancePolicy.requireIndexSha256 && !HEX_SHA256_PATTERN.test(String(packageIndex?.indexSha256 ?? ""))) {
        provenanceFailures.push(`${indexPath}.indexSha256 must be a 64-char hex digest`);
      }
    }
  }

  if (provenancePolicy.requireHttpsPackageDownloadUrls) {
    for (const [packageIndex, packageRecord] of lockPackages.entries()) {
      if (!hasHttpsUrl(packageRecord?.downloadUrl)) {
        provenanceFailures.push(`packages[${String(packageIndex)}].downloadUrl must be an https URL`);
      }
    }
  }

  const unknownSignatureKeys = signatureKeys.filter((signatureKey) => signatureKey.toUpperCase() === "UNKNOWN");
  const provenanceOk = provenanceFailures.length === 0;

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
    provenance: {
      policy: provenancePolicy,
      releaseMetadataCount: releaseMetadata.length,
      packageIndexesCount,
      unknownSignatureKeys,
      ok: provenanceOk,
      failures: provenanceFailures
    },
    ok: packageCountOk && missingRootPackages.length === 0 && hasAllEngineFingerprints && provenanceOk
  };

  return report;
}

async function main() {
  const [config, lockFile, runtimeReport] = await Promise.all([
    readJson(resolve("evaluation.config.json")),
    readJson(resolve("scripts/oracles/oracle-image.lock.json")),
    readJson(resolve("reports/oracle-runtime.json"))
  ]);

  const report = evaluateOracleSupplyChain({ config, lockFile, runtimeReport });

  await writeJsonReport(resolve("reports/oracle-supply-chain.json"), report);

  if (!report.ok) {
    throw new Error(
      `oracle supply-chain check failed: packageCount=${String(report.packageCount)} missingRoots=${report.missingRootPackages.join(",")}`
    );
  }

  process.stdout.write("oracle supply-chain check ok\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
