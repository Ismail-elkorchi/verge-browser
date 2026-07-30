import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateWorkspaceParserInstall } from "./parser-package-contract.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const root = process.cwd();
const manifest = await readJson(resolve(root, "package.json"));
const lockfile = await readJson(resolve(root, "package-lock.json"));
const evidence = validateWorkspaceParserInstall({
  manifest,
  lockfile,
  installedManifest: await readJson(
    resolve(root, "node_modules", "@ismail-elkorchi", "html-parser", "package.json")
  )
});
const clientEvidence = await validateHttpClientInstall({
  root,
  manifest,
  lockfile,
  installedManifest: await readJson(
    resolve(root, "node_modules", "@ismail-elkorchi", "http-client", "package.json")
  )
});

process.stdout.write(
  `clean install verified: ${evidence.name}@${evidence.version} ${evidence.integrity}; `
  + `${clientEvidence.name}@${clientEvidence.version} ${clientEvidence.sha256}\n`
);

async function validateHttpClientInstall({
  root,
  manifest,
  lockfile,
  installedManifest
}) {
  const name = "@ismail-elkorchi/http-client";
  const dependency = manifest.dependencies?.[name];
  if (
    typeof dependency !== "string"
    || !/^file:canary\/http-client-0\.1\.0-[a-f0-9]{40}\.tgz$/u.test(dependency)
  ) {
    throw new Error("http-client must use one commit-pinned canary tarball");
  }
  if (
    !Array.isArray(manifest.bundledDependencies)
    || !manifest.bundledDependencies.includes(name)
  ) {
    throw new Error("http-client must be a bundled runtime dependency");
  }
  const rootLock = lockfile.packages?.[""];
  const lockEntry = lockfile.packages?.[`node_modules/${name}`];
  if (rootLock?.dependencies?.[name] !== dependency) {
    throw new Error("package.json and package-lock.json disagree on http-client");
  }
  if (
    lockEntry?.resolved !== dependency
    || lockEntry?.inBundle !== true
    || typeof lockEntry?.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockEntry.integrity)
  ) {
    throw new Error("http-client lock evidence is incomplete");
  }
  if (installedManifest.name !== name || installedManifest.version !== "0.1.0") {
    throw new Error("installed http-client does not match the pinned package");
  }

  const tarballPath = resolve(root, dependency.slice("file:".length));
  const checksumFields = (
    await readFile(resolve(root, "canary", "SHA256SUMS"), "utf8")
  ).trim().split(/\s+/u);
  if (
    checksumFields.length !== 2
    || checksumFields[1] !== dependency.split("/").at(-1)
    || !/^[a-f0-9]{64}$/u.test(checksumFields[0] ?? "")
  ) {
    throw new Error("http-client SHA256SUMS is invalid");
  }
  const sha256 = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");
  if (sha256 !== checksumFields[0]) {
    throw new Error("http-client tarball checksum does not match SHA256SUMS");
  }
  return Object.freeze({
    name,
    version: installedManifest.version,
    sha256
  });
}
