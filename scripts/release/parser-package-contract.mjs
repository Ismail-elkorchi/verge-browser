export const HTML_PARSER_PACKAGE_NAME = "@ismail-elkorchi/html-parser";

const EXACT_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parserTarballUrl(version) {
  return `${PUBLIC_NPM_REGISTRY}/${HTML_PARSER_PACKAGE_NAME}/-/html-parser-${version}.tgz`;
}

export function validateParserPackageContract({
  dependencySpec,
  lockEntry,
  installedManifest
}) {
  const version = requireString(dependencySpec, "html-parser dependency");
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new Error(`html-parser dependency must be an exact version, got ${version}`);
  }

  const locked = requireRecord(lockEntry, "html-parser lock entry");
  if (locked.version !== version) {
    throw new Error(
      `html-parser lock version ${String(locked.version)} does not match dependency ${version}`
    );
  }

  const expectedResolved = parserTarballUrl(version);
  if (locked.resolved !== expectedResolved) {
    throw new Error(
      `html-parser must resolve from ${expectedResolved}, got ${String(locked.resolved)}`
    );
  }

  const integrity = requireString(locked.integrity, "html-parser lock integrity");
  if (!SHA512_INTEGRITY_PATTERN.test(integrity)) {
    throw new Error("html-parser lock integrity must be a SHA-512 SRI value");
  }
  if (locked.dev === true) {
    throw new Error("html-parser must remain a runtime dependency");
  }

  const installed = requireRecord(installedManifest, "installed html-parser manifest");
  if (installed.name !== HTML_PARSER_PACKAGE_NAME) {
    throw new Error(
      `installed parser name ${String(installed.name)} does not match ${HTML_PARSER_PACKAGE_NAME}`
    );
  }
  if (installed.version !== version) {
    throw new Error(
      `installed html-parser version ${String(installed.version)} does not match ${version}`
    );
  }

  return Object.freeze({
    name: HTML_PARSER_PACKAGE_NAME,
    version,
    resolved: expectedResolved,
    integrity
  });
}

export function validateWorkspaceParserInstall({
  manifest,
  lockfile,
  installedManifest
}) {
  const packageManifest = requireRecord(manifest, "package manifest");
  const packageLock = requireRecord(lockfile, "package lock");
  const dependencies = requireRecord(packageManifest.dependencies, "package dependencies");
  const packages = requireRecord(packageLock.packages, "package-lock packages");
  const root = requireRecord(packages[""], "package-lock root");
  const rootDependencies = requireRecord(
    root.dependencies,
    "package-lock root dependencies"
  );

  const dependencySpec = dependencies[HTML_PARSER_PACKAGE_NAME];
  if (rootDependencies[HTML_PARSER_PACKAGE_NAME] !== dependencySpec) {
    throw new Error("package.json and package-lock.json disagree on html-parser");
  }

  return validateParserPackageContract({
    dependencySpec,
    lockEntry: packages[`node_modules/${HTML_PARSER_PACKAGE_NAME}`],
    installedManifest
  });
}
