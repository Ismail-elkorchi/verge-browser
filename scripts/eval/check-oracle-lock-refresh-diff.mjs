import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { refreshOracleLock } from "../oracles/real-oracle-lib.mjs";
import { writeJsonReport } from "./render-eval-lib.mjs";

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

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function packageKey(entry) {
  return `${entry.name}@${entry.version}`;
}

function indexPackages(entries) {
  const indexed = new Map();
  for (const entry of entries) {
    indexed.set(packageKey(entry), entry);
  }
  return indexed;
}

function diffPackages(currentPackages, candidatePackages) {
  const currentByKey = indexPackages(currentPackages);
  const candidateByKey = indexPackages(candidatePackages);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, candidate] of candidateByKey.entries()) {
    const current = currentByKey.get(key);
    if (!current) {
      added.push({ key, filename: candidate.filename, sha256: candidate.sha256 });
      continue;
    }
    const changedFields = [];
    for (const field of ["filename", "sha256", "downloadUrl", "suite", "component"]) {
      if (current[field] !== candidate[field]) {
        changedFields.push(field);
      }
    }
    if (changedFields.length > 0) {
      changed.push({ key, fields: changedFields });
    }
  }

  for (const [key, current] of currentByKey.entries()) {
    if (!candidateByKey.has(key)) {
      removed.push({ key, filename: current.filename, sha256: current.sha256 });
    }
  }

  added.sort((left, right) => left.key.localeCompare(right.key));
  removed.sort((left, right) => left.key.localeCompare(right.key));
  changed.sort((left, right) => left.key.localeCompare(right.key));

  return {
    added,
    removed,
    changed
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));
  const lockPath = resolve("scripts/oracles/oracle-image.lock.json");
  const candidateLockPath = resolve("tmp/oracle-image/oracle-image.refresh-candidate.lock.json");
  const currentLock = await readJson(lockPath);

  try {
    await refreshOracleLock({
      lockPath: candidateLockPath,
      rootPackages: currentLock.rootPackages,
      snapshotId: currentLock?.sourcePolicy?.snapshotId,
      snapshotRoot: currentLock?.sourcePolicy?.snapshotRoot,
      keyringPath: currentLock?.sourcePolicy?.keyringPath
    });

    const candidateLock = await readJson(candidateLockPath);
    const packageDiff = diffPackages(currentLock.packages ?? [], candidateLock.packages ?? []);
    const sourcePolicyMatches = sameJson(currentLock.sourcePolicy ?? {}, candidateLock.sourcePolicy ?? {});
    const releaseMetadataMatches = sameJson(currentLock.releaseMetadata ?? [], candidateLock.releaseMetadata ?? []);
    const fingerprintMatches = currentLock.fingerprint === candidateLock.fingerprint;

    const report = {
      suite: "oracle-lock-refresh-diff",
      timestamp: new Date().toISOString(),
      profile,
      lockPath,
      candidateLockPath,
      fingerprint: {
        current: currentLock.fingerprint ?? null,
        candidate: candidateLock.fingerprint ?? null,
        match: fingerprintMatches
      },
      packageCounts: {
        current: Array.isArray(currentLock.packages) ? currentLock.packages.length : 0,
        candidate: Array.isArray(candidateLock.packages) ? candidateLock.packages.length : 0,
        match:
          Array.isArray(currentLock.packages)
          && Array.isArray(candidateLock.packages)
          && currentLock.packages.length === candidateLock.packages.length
      },
      sourcePolicyMatches,
      releaseMetadataMatches,
      packageDiff: {
        addedCount: packageDiff.added.length,
        removedCount: packageDiff.removed.length,
        changedCount: packageDiff.changed.length,
        added: packageDiff.added,
        removed: packageDiff.removed,
        changed: packageDiff.changed
      },
      ok:
        fingerprintMatches
        && sourcePolicyMatches
        && releaseMetadataMatches
        && packageDiff.added.length === 0
        && packageDiff.removed.length === 0
        && packageDiff.changed.length === 0
    };

    await writeJsonReport(resolve("reports/oracle-lock-refresh-diff.json"), report);

    if (!report.ok) {
      throw new Error("oracle lock refresh diff check failed");
    }

    process.stdout.write("oracle lock refresh diff check ok\n");
  } finally {
    await rm(candidateLockPath, { force: true });
  }
}

await main();
