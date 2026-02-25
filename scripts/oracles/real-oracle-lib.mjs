import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const DEFAULT_ROOT_PACKAGES = ["lynx", "w3m", "links2"];
const DEFAULT_IMAGE_ROOT = resolve("tmp/oracle-image");
const DEFAULT_LOCK_PATH = resolve("scripts/oracles/oracle-image.lock.json");
const DEFAULT_SNAPSHOT_ROOT = "https://snapshot.ubuntu.com/ubuntu";
const DEFAULT_KEYRING_PATH = "/usr/share/keyrings/ubuntu-archive-keyring.gpg";
const DEFAULT_LOCK_MIRRORS = [
  "http://archive.ubuntu.com/ubuntu",
  "http://security.ubuntu.com/ubuntu"
];

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    throw new Error(
      `command failed: ${command} ${args.join(" ")}\nstatus=${String(result.status)}\nstdout=${stdout}\nstderr=${stderr}`
    );
  }

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
}

export function oracleLdLibraryPath(rootfsPath) {
  return [
    join(rootfsPath, "lib", "x86_64-linux-gnu"),
    join(rootfsPath, "usr", "lib", "x86_64-linux-gnu"),
    join(rootfsPath, "usr", "lib")
  ].join(":");
}

function oracleCommandPath(rootfsPath, engineName) {
  return join(rootfsPath, "usr", "bin", engineName);
}

function parseDependencyNames(rawText) {
  const dependencyNames = new Set();
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*\|?(Depends|PreDepends):\s+(.+)$/);
    if (!match) continue;
    const candidate = match[2]?.trim() ?? "";
    const packageName = candidate.split(/\s+/)[0] ?? "";
    if (packageName.length === 0 || packageName.startsWith("<")) continue;
    dependencyNames.add(packageName);
  }
  return [...dependencyNames];
}

function parsePackageStanzas(rawText) {
  return rawText
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const record = {};
      for (const line of block.split(/\r?\n/)) {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex <= 0) continue;
        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (key.length === 0 || value.length === 0) continue;
        record[key] = value;
      }
      return record;
    });
}

function resolvePackageMetadata(packageName, packageVersion) {
  const showOutput = runCommand("apt-cache", ["show", packageName]).stdout;
  const stanzas = parsePackageStanzas(showOutput);
  for (const stanza of stanzas) {
    if (stanza.Version !== packageVersion) continue;
    const filename = typeof stanza.Filename === "string" ? stanza.Filename : null;
    const sha256 = typeof stanza.SHA256 === "string" ? stanza.SHA256.toLowerCase() : null;
    if (!filename || !sha256) {
      continue;
    }
    return {
      filename,
      sha256
    };
  }
  return null;
}

function resolvePolicySourceRecord(packageName, packageVersion) {
  const policyOutput = runCommand("apt-cache", ["policy", packageName]).stdout;
  const lines = policyOutput.split(/\r?\n/);
  let inVersionBlock = false;

  for (const line of lines) {
    const versionLine = line.match(/^\s*(?:\*{3}\s*)?(\S+)\s+\d+/);
    if (versionLine) {
      const currentVersion = versionLine[1] ?? "";
      inVersionBlock = currentVersion === packageVersion;
      continue;
    }
    if (!inVersionBlock) {
      continue;
    }
    const sourceLine = line.match(/^\s+\d+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/);
    if (!sourceLine) {
      continue;
    }
    const sourceUrl = sourceLine[1] ?? "";
    const suiteAndComponent = sourceLine[2] ?? "";
    const architecture = sourceLine[3] ?? "";
    const indexKind = sourceLine[4] ?? "";
    if (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://")) {
      const suitePathParts = suiteAndComponent.split("/");
      const suite = suitePathParts[0] ?? "";
      const component = suitePathParts[1] ?? "main";
      const indexType = `${architecture} ${indexKind}`.trim();
      if (suite.length === 0) {
        continue;
      }
      return {
        aptSourceUrl: sourceUrl.replace(/\/+$/, ""),
        suite,
        component,
        indexType
      };
    }
  }

  return null;
}

function resolveCandidateVersion(packageName) {
  const policy = runCommand("apt-cache", ["policy", packageName]).stdout;
  const lines = policy.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*Candidate:\s+(.+)$/);
    if (!match) continue;
    const candidateVersion = match[1]?.trim() ?? "";
    if (candidateVersion === "(none)" || candidateVersion.length === 0) {
      return null;
    }
    return candidateVersion;
  }
  return null;
}

function hashString(value) {
  return createHash("sha256").update(value).digest("hex");
}

function formatSnapshotId(dateValue = new Date()) {
  const year = String(dateValue.getUTCFullYear()).padStart(4, "0");
  const month = String(dateValue.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getUTCDate()).padStart(2, "0");
  const hour = String(dateValue.getUTCHours()).padStart(2, "0");
  const minute = String(dateValue.getUTCMinutes()).padStart(2, "0");
  const second = String(dateValue.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function validateSnapshotId(snapshotId) {
  if (!/^\d{8}T\d{6}Z$/.test(snapshotId)) {
    throw new Error(`invalid snapshot id: ${snapshotId}`);
  }
  return snapshotId;
}

function buildSnapshotBaseUrl(snapshotRoot, snapshotId) {
  const trimmedRoot = snapshotRoot.replace(/\/+$/, "");
  return `${trimmedRoot}/${snapshotId}`;
}

function parseSha256EntriesFromInRelease(inReleaseRawText) {
  const lines = inReleaseRawText.split(/\r?\n/);
  const hashByPath = new Map();
  let inShaSection = false;
  for (const line of lines) {
    if (!inShaSection) {
      if (line === "SHA256:") {
        inShaSection = true;
      }
      continue;
    }
    if (!line.startsWith(" ")) {
      break;
    }
    const match = line.match(/^\s*([0-9a-f]{64})\s+(\d+)\s+(\S+)\s*$/i);
    if (!match) {
      continue;
    }
    const hashValue = match[1]?.toLowerCase() ?? "";
    const sizeValue = Number.parseInt(match[2] ?? "0", 10);
    const pathValue = match[3] ?? "";
    if (hashValue.length !== 64 || !Number.isFinite(sizeValue) || pathValue.length === 0) {
      continue;
    }
    hashByPath.set(pathValue, {
      sha256: hashValue,
      sizeBytes: sizeValue
    });
  }
  return hashByPath;
}

function parseVerifiedSignatureKey(gpgvStderr) {
  const keyMatch = gpgvStderr.match(/using (?:RSA|EDDSA|ECDSA) key ([0-9A-F]{16,40})/i);
  return keyMatch ? keyMatch[1].toUpperCase() : null;
}

function ensureRelativePath(pathValue) {
  return pathValue.replace(/^\/+/, "");
}

async function fetchUrlToFile(url, destinationPath) {
  await mkdir(dirname(destinationPath), { recursive: true });
  runCommand("curl", [
    "-fsSL",
    "--retry-all-errors",
    "--retry-connrefused",
    "--retry",
    "2",
    "--retry-delay",
    "2",
    "--retry-max-time",
    "45",
    "--max-time",
    "30",
    "--connect-timeout",
    "15",
    "--output",
    destinationPath,
    url
  ]);
}

async function hashFile(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", (error) => rejectHash(error));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function findMatchingDebPath(pkgsDir, packageName, packageVersion) {
  const fileEntries = await readdir(pkgsDir);
  const versionPattern = packageVersion.replaceAll(":", "%3a");
  const strictPrefix = `${packageName}_${versionPattern}_`;
  const fallbackPrefix = `${packageName}_`;

  for (const fileEntry of fileEntries) {
    if (!fileEntry.endsWith(".deb")) continue;
    if (fileEntry.startsWith(strictPrefix)) {
      return join(pkgsDir, fileEntry);
    }
  }

  for (const fileEntry of fileEntries) {
    if (!fileEntry.endsWith(".deb")) continue;
    if (fileEntry.startsWith(fallbackPrefix) && fileEntry.includes(versionPattern)) {
      return join(pkgsDir, fileEntry);
    }
  }

  return null;
}

async function downloadDebForPackage(pkgsDir, packageName, packageVersion) {
  const existingDebPath = await findMatchingDebPath(pkgsDir, packageName, packageVersion);
  if (existingDebPath) {
    return existingDebPath;
  }

  const beforeFiles = new Set(await readdir(pkgsDir));
  runCommand("apt", ["download", `${packageName}=${packageVersion}`], {
    cwd: pkgsDir
  });
  const afterFiles = await readdir(pkgsDir);

  for (const fileName of afterFiles) {
    if (!fileName.endsWith(".deb")) continue;
    if (!beforeFiles.has(fileName)) {
      return join(pkgsDir, fileName);
    }
  }

  const downloadedPath = await findMatchingDebPath(pkgsDir, packageName, packageVersion);
  if (!downloadedPath) {
    throw new Error(`deb package not found for ${packageName}=${packageVersion}`);
  }
  return downloadedPath;
}

function dedupeUrls(urls) {
  const unique = [];
  const seen = new Set();
  for (const url of urls) {
    if (typeof url !== "string" || url.length === 0) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    unique.push(url);
  }
  return unique;
}

function fallbackDownloadUrls(packageRecord, fallbackMirrorBases) {
  if (!Array.isArray(fallbackMirrorBases) || fallbackMirrorBases.length === 0) {
    return [];
  }
  if (typeof packageRecord.filename !== "string" || packageRecord.filename.length === 0) {
    return [];
  }
  const relativeFilename = ensureRelativePath(packageRecord.filename);
  if (relativeFilename.length === 0) {
    return [];
  }
  return fallbackMirrorBases.map((baseUrl) => `${baseUrl.replace(/\/+$/, "")}/${relativeFilename}`);
}

async function downloadDebFromUrl(pkgsDir, packageRecord, options = {}) {
  const filenameFromPath = packageRecord.filename
    ? basename(packageRecord.filename)
    : `${packageRecord.name}_${packageRecord.version}.deb`;
  const debPath = join(pkgsDir, filenameFromPath);
  const existingPath = await findMatchingDebPath(pkgsDir, packageRecord.name, packageRecord.version);
  if (existingPath) {
    return existingPath;
  }

  const urlCandidates = dedupeUrls([
    ...fallbackDownloadUrls(packageRecord, options.fallbackMirrorBases ?? []),
    packageRecord.downloadUrl
  ]);
  const failures = [];

  for (const url of urlCandidates) {
    try {
      await fetchUrlToFile(url, debPath);
      return debPath;
    } catch (error) {
      failures.push({
        url,
        error: error instanceof Error ? error.message : String(error)
      });
      await unlink(debPath).catch(() => {});
    }
  }

  const failureSummary = failures.map((entry) => `${entry.url}: ${entry.error}`).join("\n");
  throw new Error(`failed to download deb for ${packageRecord.name}@${packageRecord.version}\n${failureSummary}`);

}

function dependencyClosure(rootPackages) {
  const dependencyOutput = runCommand("apt-cache", [
    "depends",
    "--recurse",
    "--no-recommends",
    "--no-suggests",
    "--no-conflicts",
    "--no-breaks",
    "--no-replaces",
    "--no-enhances",
    ...rootPackages
  ]).stdout;

  const names = new Set([...rootPackages, ...parseDependencyNames(dependencyOutput)]);
  return [...names].sort((left, right) => left.localeCompare(right));
}

async function fetchAndVerifyInRelease(input) {
  const inReleaseUrl = `${input.snapshotBaseUrl}/dists/${input.suite}/InRelease`;
  const inReleasePath = join(input.imageRoot, "release", input.suite, "InRelease");
  await fetchUrlToFile(inReleaseUrl, inReleasePath);
  const inReleaseRaw = await readFile(inReleasePath, "utf8");
  const inReleaseSha256 = await hashFile(inReleasePath);

  const verification = runCommand("gpgv", [
    "--keyring",
    input.keyringPath,
    inReleasePath
  ]);
  const signatureKey = parseVerifiedSignatureKey(verification.stderr) ?? "UNKNOWN";
  const sha256Entries = parseSha256EntriesFromInRelease(inReleaseRaw);

  return {
    suite: input.suite,
    inReleaseUrl,
    inReleasePath,
    inReleaseSha256,
    signatureKey,
    sha256Entries
  };
}

async function fetchAndVerifyPackagesIndex(input) {
  const indexCandidates = [
    `${input.component}/binary-amd64/Packages.gz`,
    `${input.component}/binary-amd64/Packages.xz`,
    `${input.component}/binary-amd64/Packages`
  ];
  const selectedPath = indexCandidates.find((candidatePath) => input.sha256Entries.has(candidatePath));
  if (!selectedPath) {
    throw new Error(`missing signed packages index for ${input.suite}/${input.component}`);
  }

  const expectedHash = input.sha256Entries.get(selectedPath)?.sha256;
  if (!expectedHash) {
    throw new Error(`missing signed hash for ${input.suite}/${selectedPath}`);
  }

  const indexUrl = `${input.snapshotBaseUrl}/dists/${input.suite}/${selectedPath}`;
  const indexPath = join(input.imageRoot, "release", input.suite, ensureRelativePath(selectedPath));
  await fetchUrlToFile(indexUrl, indexPath);
  const actualHash = await hashFile(indexPath);
  if (actualHash !== expectedHash) {
    throw new Error(`packages index hash mismatch for ${input.suite}/${selectedPath}`);
  }
  let packagesRaw;
  if (selectedPath.endsWith(".gz")) {
    const compressedBuffer = await readFile(indexPath);
    packagesRaw = gunzipSync(compressedBuffer).toString("utf8");
  } else if (selectedPath.endsWith(".xz")) {
    packagesRaw = runCommand("xz", ["-dc", indexPath]).stdout;
  } else if (selectedPath.endsWith("/Packages")) {
    packagesRaw = await readFile(indexPath, "utf8");
  } else {
    throw new Error(`unsupported signed index format for ${input.suite}/${selectedPath}`);
  }

  const stanzas = parsePackageStanzas(packagesRaw);
  const packageLookup = new Map();

  for (const stanza of stanzas) {
    const packageName = typeof stanza.Package === "string" ? stanza.Package : "";
    const packageVersion = typeof stanza.Version === "string" ? stanza.Version : "";
    const filename = typeof stanza.Filename === "string" ? ensureRelativePath(stanza.Filename) : "";
    const sha256 = typeof stanza.SHA256 === "string" ? stanza.SHA256.toLowerCase() : "";
    if (packageName.length === 0 || packageVersion.length === 0 || filename.length === 0 || sha256.length !== 64) {
      continue;
    }
    packageLookup.set(`${packageName}\n${packageVersion}\n${filename}`, sha256);
  }

  return {
    suite: input.suite,
    component: input.component,
    indexPath: selectedPath,
    indexUrl,
    indexSha256: expectedHash,
    packageLookup
  };
}

async function materializeRootfs(input) {
  const pkgsDir = join(input.imageRoot, "pkgs");
  const rootfsDir = join(input.imageRoot, "rootfs");
  await mkdir(pkgsDir, { recursive: true });
  await rm(rootfsDir, { recursive: true, force: true });
  await mkdir(rootfsDir, { recursive: true });
  const fallbackMirrorBases = Array.isArray(input.lock?.sourcePolicy?.mirrors)
    ? input.lock.sourcePolicy.mirrors.filter((entry) => typeof entry === "string")
    : [];

  const packageEntries = [];
  for (const packageRecord of input.lock.packages) {
    const debPath = packageRecord.downloadUrl
      ? await downloadDebFromUrl(pkgsDir, packageRecord, { fallbackMirrorBases })
      : await downloadDebForPackage(pkgsDir, packageRecord.name, packageRecord.version);
    const debStat = await stat(debPath);
    const debSha = await hashFile(debPath);

    if (packageRecord.debSha256 !== debSha) {
      throw new Error(`deb sha mismatch for ${packageRecord.name}: expected ${packageRecord.debSha256}, got ${debSha}`);
    }

    runCommand("dpkg-deb", ["-x", debPath, rootfsDir]);
    packageEntries.push({
      ...packageRecord,
      debFile: debPath,
      debSizeBytes: debStat.size
    });
  }

  return {
    pkgsDir,
    rootfsDir,
    packageEntries
  };
}

export function computeOracleLockFingerprint(lockPayload) {
  const validation = validateOracleLockFingerprintInputs(lockPayload);
  if (!validation.ok) {
    throw new Error(`invalid oracle lock fingerprint inputs: ${JSON.stringify(validation.issues)}`);
  }
  const fingerprintBasis = validation.packages
    .map((packageRecord) => `${packageRecord.name}@${packageRecord.version}:${packageRecord.debSha256}:${packageRecord.downloadUrl}`)
    .join("\n");
  return hashString(fingerprintBasis);
}

function packageOrderKey(packageRecord) {
  return `${packageRecord.name}\u0000${packageRecord.version}`;
}

function compareTextBinary(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function validateOracleLockFingerprintInputs(lockPayload) {
  const issues = [];
  const packages = Array.isArray(lockPayload?.packages) ? lockPayload.packages : [];
  if (packages.length === 0) {
    issues.push("packages must be a non-empty array");
  }

  const normalizedPackages = [];
  for (const [index, packageRecord] of packages.entries()) {
    if (!packageRecord || typeof packageRecord !== "object") {
      issues.push(`packages[${String(index)}] must be an object`);
      continue;
    }

    const name = typeof packageRecord.name === "string" ? packageRecord.name.trim() : "";
    const version = typeof packageRecord.version === "string" ? packageRecord.version.trim() : "";
    const debSha256 = typeof packageRecord.debSha256 === "string" ? packageRecord.debSha256.trim().toLowerCase() : "";
    const downloadUrl = typeof packageRecord.downloadUrl === "string" ? packageRecord.downloadUrl.trim() : "";

    if (name.length === 0) {
      issues.push(`packages[${String(index)}].name must be a non-empty string`);
    }
    if (version.length === 0) {
      issues.push(`packages[${String(index)}].version must be a non-empty string`);
    }
    if (!/^[0-9a-f]{64}$/i.test(debSha256)) {
      issues.push(`packages[${String(index)}].debSha256 must be a 64-char hex digest`);
    }
    if (downloadUrl.length === 0) {
      issues.push(`packages[${String(index)}].downloadUrl must be a non-empty string`);
    }

    normalizedPackages.push({
      name,
      version,
      debSha256,
      downloadUrl
    });
  }

  const packageKeys = normalizedPackages.map((packageRecord) => packageOrderKey(packageRecord));
  const sortedKeys = [...packageKeys].sort(compareTextBinary);
  const outOfOrderIndexes = [];
  for (let index = 0; index < packageKeys.length; index += 1) {
    if (packageKeys[index] !== sortedKeys[index]) {
      outOfOrderIndexes.push(index);
    }
  }
  if (outOfOrderIndexes.length > 0) {
    issues.push(`packages must be sorted by name/version; out-of-order indexes: ${outOfOrderIndexes.join(",")}`);
  }

  const duplicateKeys = [];
  for (let index = 1; index < sortedKeys.length; index += 1) {
    if (sortedKeys[index] === sortedKeys[index - 1]) {
      duplicateKeys.push(sortedKeys[index]);
    }
  }
  if (duplicateKeys.length > 0) {
    issues.push(`packages contain duplicate name/version keys: ${[...new Set(duplicateKeys)].join(",")}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    packages: normalizedPackages
  };
}

async function withOracleImageLock(imageRoot, operation) {
  await mkdir(imageRoot, { recursive: true });
  const lockPath = join(imageRoot, ".oracle-image.lock");
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx");
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAtIso: new Date().toISOString() })}\n`, "utf8");
    return await operation();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`oracle image lock is already held: ${lockPath}`);
    }
    throw error;
  } finally {
    if (lockHandle) {
      await lockHandle.close();
      await unlink(lockPath).catch(() => {});
    }
  }
}

async function createLock(input) {
  const dependencyNames = dependencyClosure(input.rootPackages);
  const candidatePackages = [];

  for (const packageName of dependencyNames) {
    const version = resolveCandidateVersion(packageName);
    if (!version) {
      continue;
    }
    const sourceRecord = resolvePolicySourceRecord(packageName, version);
    if (!sourceRecord) {
      throw new Error(`unable to resolve apt policy source for ${packageName}=${version}`);
    }
    candidatePackages.push({
      name: packageName,
      version,
      ...sourceRecord
    });
  }

  candidatePackages.sort((left, right) => compareTextBinary(packageOrderKey(left), packageOrderKey(right)));

  const pkgsDir = join(input.imageRoot, "pkgs");
  await mkdir(pkgsDir, { recursive: true });

  const snapshotRoot = (input.snapshotRoot ?? DEFAULT_SNAPSHOT_ROOT).replace(/\/+$/, "");
  const snapshotId = validateSnapshotId(
    typeof input.snapshotId === "string" && input.snapshotId.length > 0
      ? input.snapshotId
      : formatSnapshotId()
  );
  const keyringPath = resolve(input.keyringPath ?? DEFAULT_KEYRING_PATH);
  const snapshotBaseUrl = buildSnapshotBaseUrl(snapshotRoot, snapshotId);

  const suites = [...new Set(candidatePackages.map((packageRecord) => packageRecord.suite))].sort((left, right) =>
    left.localeCompare(right)
  );
  const releaseBySuite = new Map();
  for (const suite of suites) {
    const releaseMetadata = await fetchAndVerifyInRelease({
      imageRoot: input.imageRoot,
      snapshotBaseUrl,
      suite,
      keyringPath
    });
    releaseBySuite.set(suite, releaseMetadata);
  }

  const packageIndexCache = new Map();
  const hydratedPackages = [];
  for (const packageRecord of candidatePackages) {
    const metadata = resolvePackageMetadata(packageRecord.name, packageRecord.version);
    if (!metadata) {
      throw new Error(`unable to resolve package metadata for ${packageRecord.name}=${packageRecord.version}`);
    }

    const filenamePath = ensureRelativePath(metadata.filename);
    const indexCacheKey = `${packageRecord.suite}/${packageRecord.component}`;
    let packagesIndex = packageIndexCache.get(indexCacheKey);
    if (!packagesIndex) {
      const releaseMetadata = releaseBySuite.get(packageRecord.suite);
      if (!releaseMetadata) {
        throw new Error(`missing verified release metadata for suite ${packageRecord.suite}`);
      }
      packagesIndex = await fetchAndVerifyPackagesIndex({
        imageRoot: input.imageRoot,
        snapshotBaseUrl,
        suite: packageRecord.suite,
        component: packageRecord.component,
        sha256Entries: releaseMetadata.sha256Entries
      });
      packageIndexCache.set(indexCacheKey, packagesIndex);
    }

    const packageIndexKey = `${packageRecord.name}\n${packageRecord.version}\n${filenamePath}`;
    const signedPackageSha256 = packagesIndex.packageLookup.get(packageIndexKey);
    if (!signedPackageSha256) {
      throw new Error(
        `signed metadata missing package record for ${packageRecord.name}=${packageRecord.version} in ${indexCacheKey}`
      );
    }
    if (signedPackageSha256 !== metadata.sha256) {
      throw new Error(
        `signed metadata SHA256 mismatch for ${packageRecord.name}=${packageRecord.version}: ${signedPackageSha256} != ${metadata.sha256}`
      );
    }

    const downloadUrl = `${snapshotBaseUrl}/${filenamePath}`;
    const debPath = await downloadDebFromUrl(pkgsDir, {
      name: packageRecord.name,
      version: packageRecord.version,
      filename: filenamePath,
      downloadUrl
    });
    const debSha = await hashFile(debPath);
    if (debSha !== metadata.sha256) {
      throw new Error(`snapshot deb SHA256 mismatch for ${packageRecord.name}: expected ${metadata.sha256}, got ${debSha}`);
    }

    hydratedPackages.push({
      ...packageRecord,
      filename: filenamePath,
      aptSourceUrl: packageRecord.aptSourceUrl,
      downloadUrl,
      debSha256: debSha,
      suite: packageRecord.suite,
      component: packageRecord.component
    });
  }

  const releaseMetadata = [...releaseBySuite.values()].map((releaseRecord) => {
    const packageIndexes = [...packageIndexCache.values()]
      .filter((indexRecord) => indexRecord.suite === releaseRecord.suite)
      .map((indexRecord) => ({
        component: indexRecord.component,
        indexPath: indexRecord.indexPath,
        indexUrl: indexRecord.indexUrl,
        indexSha256: indexRecord.indexSha256
      }))
      .sort((left, right) => left.indexPath.localeCompare(right.indexPath));

    return {
      suite: releaseRecord.suite,
      inReleaseUrl: releaseRecord.inReleaseUrl,
      inReleaseSha256: releaseRecord.inReleaseSha256,
      signatureKey: releaseRecord.signatureKey,
      packageIndexes
    };
  });

  const lockPayload = {
    formatVersion: 3,
    generatedAtIso: new Date().toISOString(),
    rootPackages: input.rootPackages,
    sourcePolicy: {
      mode: "snapshot-replay",
      mirrors: DEFAULT_LOCK_MIRRORS,
      snapshotRoot,
      snapshotId,
      keyringPath
    },
    releaseMetadata,
    packages: hydratedPackages
  };

  lockPayload.fingerprint = computeOracleLockFingerprint(lockPayload);
  await mkdir(dirname(input.lockPath), { recursive: true });
  await writeFile(input.lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`, "utf8");
  return lockPayload;
}

async function loadLock(lockPath) {
  const rawText = await readFile(lockPath, "utf8");
  const lock = JSON.parse(rawText);
  if (!Number.isInteger(lock?.formatVersion) || lock.formatVersion < 3) {
    throw new Error(`oracle lock formatVersion must be >=3: ${lockPath}`);
  }
  if (!Array.isArray(lock?.packages) || lock.packages.length === 0) {
    throw new Error(`invalid oracle lock file: ${lockPath}`);
  }
  if (!Array.isArray(lock?.rootPackages) || lock.rootPackages.length === 0) {
    throw new Error(`oracle lock file missing rootPackages: ${lockPath}`);
  }
  if (!lock?.sourcePolicy || typeof lock.sourcePolicy !== "object") {
    throw new Error(`oracle lock missing sourcePolicy: ${lockPath}`);
  }
  if (lock.sourcePolicy.mode !== "snapshot-replay") {
    throw new Error(`oracle lock sourcePolicy.mode must be snapshot-replay: ${lockPath}`);
  }
  if (typeof lock.sourcePolicy.snapshotRoot !== "string" || lock.sourcePolicy.snapshotRoot.length === 0) {
    throw new Error(`oracle lock missing sourcePolicy.snapshotRoot: ${lockPath}`);
  }
  if (typeof lock.sourcePolicy.snapshotId !== "string") {
    throw new Error(`oracle lock missing sourcePolicy.snapshotId: ${lockPath}`);
  }
  validateSnapshotId(lock.sourcePolicy.snapshotId);
  if (typeof lock.sourcePolicy.keyringPath !== "string" || lock.sourcePolicy.keyringPath.length === 0) {
    throw new Error(`oracle lock missing sourcePolicy.keyringPath: ${lockPath}`);
  }
  if (!Array.isArray(lock?.releaseMetadata) || lock.releaseMetadata.length === 0) {
    throw new Error(`oracle lock missing releaseMetadata: ${lockPath}`);
  }
  for (const releaseRecord of lock.releaseMetadata) {
    if (typeof releaseRecord?.suite !== "string" || releaseRecord.suite.length === 0) {
      throw new Error(`oracle lock releaseMetadata suite missing: ${lockPath}`);
    }
    if (typeof releaseRecord?.inReleaseUrl !== "string" || releaseRecord.inReleaseUrl.length === 0) {
      throw new Error(`oracle lock releaseMetadata inReleaseUrl missing: ${lockPath}`);
    }
    if (typeof releaseRecord?.inReleaseSha256 !== "string" || releaseRecord.inReleaseSha256.length !== 64) {
      throw new Error(`oracle lock releaseMetadata inReleaseSha256 missing: ${lockPath}`);
    }
    if (typeof releaseRecord?.signatureKey !== "string" || releaseRecord.signatureKey.length === 0) {
      throw new Error(`oracle lock releaseMetadata signatureKey missing: ${lockPath}`);
    }
    if (!Array.isArray(releaseRecord?.packageIndexes) || releaseRecord.packageIndexes.length === 0) {
      throw new Error(`oracle lock releaseMetadata packageIndexes missing: ${lockPath}`);
    }
  }
  for (const packageRecord of lock.packages) {
    if (typeof packageRecord?.name !== "string" || packageRecord.name.length === 0) {
      throw new Error(`oracle lock package missing name: ${lockPath}`);
    }
    if (typeof packageRecord?.version !== "string" || packageRecord.version.length === 0) {
      throw new Error(`oracle lock package missing version: ${lockPath}`);
    }
    if (typeof packageRecord?.debSha256 !== "string" || packageRecord.debSha256.length !== 64) {
      throw new Error(`oracle lock package missing debSha256: ${lockPath}`);
    }
    if (typeof packageRecord?.downloadUrl !== "string" || packageRecord.downloadUrl.length === 0) {
      throw new Error(`oracle lock package missing downloadUrl: ${lockPath}`);
    }
    if (typeof packageRecord?.filename !== "string" || packageRecord.filename.length === 0) {
      throw new Error(`oracle lock package missing filename: ${lockPath}`);
    }
    if (typeof packageRecord?.suite !== "string" || packageRecord.suite.length === 0) {
      throw new Error(`oracle lock package missing suite: ${lockPath}`);
    }
    if (typeof packageRecord?.component !== "string" || packageRecord.component.length === 0) {
      throw new Error(`oracle lock package missing component: ${lockPath}`);
    }
  }
  return lock;
}

function readOsRelease(rootfsPath) {
  const osReleasePath = join(rootfsPath, "usr", "lib", "os-release");
  return readFile(osReleasePath, "utf8").catch(() => "");
}

export async function ensureOracleImage(options = {}) {
  return withOracleImageLock(resolve(options.imageRoot ?? DEFAULT_IMAGE_ROOT), async () => {
    const imageRoot = resolve(options.imageRoot ?? DEFAULT_IMAGE_ROOT);
    const lockPath = resolve(options.lockPath ?? DEFAULT_LOCK_PATH);
    const rootPackages = [...(options.rootPackages ?? DEFAULT_ROOT_PACKAGES)];
    const shouldRebuildLock = options.rebuildLock === true;

    let lock;
    if (shouldRebuildLock) {
      lock = await createLock({
        imageRoot,
        lockPath,
        rootPackages
      });
    } else {
      lock = await loadLock(lockPath);
    }

    const materialized = await materializeRootfs({
      imageRoot,
      lock
    });

    const osReleaseRaw = await readOsRelease(materialized.rootfsDir);
    const imageState = {
      suite: "oracle-host-image",
      timestamp: new Date().toISOString(),
      imageRoot,
      lockPath,
      rootfsPath: materialized.rootfsDir,
      fingerprint: lock.fingerprint ?? computeOracleLockFingerprint(lock),
      rootPackages: lock.rootPackages,
      packageCount: lock.packages.length,
      osRelease: osReleaseRaw.trim()
    };

    const statePath = join(imageRoot, "image-state.json");
    await writeFile(statePath, `${JSON.stringify(imageState, null, 2)}\n`, "utf8");

    return {
      ...imageState,
      packageEntries: materialized.packageEntries,
      lock
    };
  });
}

export async function refreshOracleLock(options = {}) {
  return withOracleImageLock(resolve(options.imageRoot ?? DEFAULT_IMAGE_ROOT), async () => {
    const imageRoot = resolve(options.imageRoot ?? DEFAULT_IMAGE_ROOT);
    const lockPath = resolve(options.lockPath ?? DEFAULT_LOCK_PATH);
    const rootPackages = [...(options.rootPackages ?? DEFAULT_ROOT_PACKAGES)];
    const snapshotId = typeof options.snapshotId === "string" ? validateSnapshotId(options.snapshotId) : undefined;
    const lock = await createLock({
      imageRoot,
      lockPath,
      rootPackages,
      snapshotId,
      snapshotRoot: options.snapshotRoot,
      keyringPath: options.keyringPath
    });
    return {
      lockPath,
      fingerprint: lock.fingerprint,
      packageCount: lock.packages.length,
      snapshotId: lock.sourcePolicy.snapshotId
    };
  });
}

function baseOracleEnv(rootfsPath) {
  return {
    ...process.env,
    HOME: process.env.HOME ?? process.cwd(),
    LD_LIBRARY_PATH: oracleLdLibraryPath(rootfsPath),
    LYNX_CFG: join(rootfsPath, "etc", "lynx", "lynx.cfg"),
    TERM: process.env.TERM ?? "xterm-256color"
  };
}

function oracleDynamicLoaderPath(rootfsPath) {
  const candidates = [
    join(rootfsPath, "usr", "lib", "x86_64-linux-gnu", "ld-linux-x86-64.so.2"),
    join(rootfsPath, "lib64", "ld-linux-x86-64.so.2"),
    join(rootfsPath, "lib", "x86_64-linux-gnu", "ld-linux-x86-64.so.2")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function runOracleBinary(rootfsPath, binaryPath, args) {
  const loaderPath = oracleDynamicLoaderPath(rootfsPath);
  if (!loaderPath) {
    return runCommand(binaryPath, args, {
      env: baseOracleEnv(rootfsPath)
    });
  }
  return runCommand(loaderPath, [
    "--library-path",
    oracleLdLibraryPath(rootfsPath),
    binaryPath,
    ...args
  ], {
    env: baseOracleEnv(rootfsPath)
  });
}

export function runEngineDump(options) {
  const binaryPath = oracleCommandPath(options.rootfsPath, options.engineName);
  const htmlPath = options.htmlPath;
  const fileUrl = `file://${htmlPath}`;

  let args;
  if (options.engineName === "lynx") {
    args = ["-dump", "-nolist", `-width=${String(options.width)}`, fileUrl];
  } else if (options.engineName === "w3m") {
    args = ["-dump", "-cols", String(options.width), htmlPath];
  } else if (options.engineName === "links2") {
    args = ["-dump", "-width", String(options.width), fileUrl];
  } else {
    throw new Error(`unsupported engine: ${options.engineName}`);
  }

  const result = runOracleBinary(options.rootfsPath, binaryPath, args);
  const output = result.stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = output.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function versionCommandArgs(engineName) {
  if (engineName === "lynx") return ["--version"];
  if (engineName === "w3m") return ["-version"];
  if (engineName === "links2") return ["-version"];
  throw new Error(`unsupported engine: ${engineName}`);
}

export async function collectEngineFingerprints(options) {
  const fingerprints = {};
  for (const engineName of DEFAULT_ROOT_PACKAGES) {
    const binaryPath = oracleCommandPath(options.rootfsPath, engineName);
    const binaryStat = await stat(binaryPath);
    const binarySha = await hashFile(binaryPath);
    const version = runOracleBinary(
      options.rootfsPath,
      binaryPath,
      versionCommandArgs(engineName)
    ).stdout.trim();
    fingerprints[engineName] = {
      engine: engineName,
      path: binaryPath,
      sizeBytes: binaryStat.size,
      sha256: binarySha,
      version
    };
  }
  return fingerprints;
}

export async function writeOracleRuntimeReport(input) {
  const reportPath = resolve(input.reportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(input.payload, null, 2)}\n`, "utf8");
}

export function defaultOracleRootPackages() {
  return [...DEFAULT_ROOT_PACKAGES];
}

export async function copyDebArtifacts(input) {
  await mkdir(input.destinationDir, { recursive: true });
  for (const packageEntry of input.packageEntries) {
    const destinationPath = join(input.destinationDir, `${packageEntry.name}_${packageEntry.version}.deb`);
    await copyFile(packageEntry.debFile, destinationPath);
  }
}
