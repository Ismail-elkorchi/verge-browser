import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_ROOT_PACKAGES = ["lynx", "w3m", "links2"];
const DEFAULT_IMAGE_ROOT = resolve("tmp/oracle-image");
const DEFAULT_LOCK_PATH = resolve("scripts/oracles/oracle-image.lock.json");

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

async function materializeRootfs(input) {
  const pkgsDir = join(input.imageRoot, "pkgs");
  const rootfsDir = join(input.imageRoot, "rootfs");
  await mkdir(pkgsDir, { recursive: true });
  await rm(rootfsDir, { recursive: true, force: true });
  await mkdir(rootfsDir, { recursive: true });

  const packageEntries = [];
  for (const packageRecord of input.lock.packages) {
    const debPath = await downloadDebForPackage(pkgsDir, packageRecord.name, packageRecord.version);
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

function lockFingerprint(lockPayload) {
  const fingerprintBasis = lockPayload.packages
    .map((packageRecord) => `${packageRecord.name}@${packageRecord.version}:${packageRecord.debSha256}`)
    .join("\n");
  return hashString(fingerprintBasis);
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
  const packages = [];

  for (const packageName of dependencyNames) {
    const version = resolveCandidateVersion(packageName);
    if (!version) {
      continue;
    }
    packages.push({
      name: packageName,
      version
    });
  }

  packages.sort((left, right) => left.name.localeCompare(right.name));

  const pkgsDir = join(input.imageRoot, "pkgs");
  await mkdir(pkgsDir, { recursive: true });

  const hydratedPackages = [];
  for (const packageRecord of packages) {
    const debPath = await downloadDebForPackage(pkgsDir, packageRecord.name, packageRecord.version);
    const debSha = await hashFile(debPath);
    hydratedPackages.push({
      ...packageRecord,
      debSha256: debSha
    });
  }

  const lockPayload = {
    formatVersion: 1,
    generatedAtIso: new Date().toISOString(),
    rootPackages: input.rootPackages,
    packages: hydratedPackages
  };

  lockPayload.fingerprint = lockFingerprint(lockPayload);
  await mkdir(dirname(input.lockPath), { recursive: true });
  await writeFile(input.lockPath, `${JSON.stringify(lockPayload, null, 2)}\n`, "utf8");
  return lockPayload;
}

async function loadLock(lockPath) {
  const rawText = await readFile(lockPath, "utf8");
  const lock = JSON.parse(rawText);
  if (!Array.isArray(lock?.packages) || lock.packages.length === 0) {
    throw new Error(`invalid oracle lock file: ${lockPath}`);
  }
  if (!Array.isArray(lock?.rootPackages) || lock.rootPackages.length === 0) {
    throw new Error(`oracle lock file missing rootPackages: ${lockPath}`);
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
      try {
        lock = await loadLock(lockPath);
      } catch {
        lock = await createLock({
          imageRoot,
          lockPath,
          rootPackages
        });
      }
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
      fingerprint: lock.fingerprint ?? lockFingerprint(lock),
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

function baseOracleEnv(rootfsPath) {
  return {
    ...process.env,
    HOME: process.env.HOME ?? process.cwd(),
    LD_LIBRARY_PATH: oracleLdLibraryPath(rootfsPath),
    LYNX_CFG: join(rootfsPath, "etc", "lynx", "lynx.cfg"),
    TERM: process.env.TERM ?? "xterm-256color"
  };
}

export function runEngineDump(options) {
  const binaryPath = oracleCommandPath(options.rootfsPath, options.engineName);
  const env = baseOracleEnv(options.rootfsPath);
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

  const result = runCommand(binaryPath, args, {
    env
  });
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
    const version = runCommand(binaryPath, versionCommandArgs(engineName), {
      env: baseOracleEnv(options.rootfsPath)
    }).stdout.trim();
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
