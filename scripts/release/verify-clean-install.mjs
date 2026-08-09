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
const clientEvidence = validateHttpClientInstall({
  manifest,
  lockfile,
  installedManifest: await readJson(
    resolve(root, "node_modules", "@ismail-elkorchi", "http-client", "package.json")
  )
});

process.stdout.write(
  `clean install verified: ${evidence.name}@${evidence.version} ${evidence.integrity}; `
  + `${clientEvidence.name}@${clientEvidence.version} ${clientEvidence.integrity}\n`
);

function validateHttpClientInstall({
  manifest,
  lockfile,
  installedManifest
}) {
  const name = "@ismail-elkorchi/http-client";
  const dependency = manifest.dependencies?.[name];
  if (dependency !== "^0.1.0") {
    throw new Error("http-client must use the published ^0.1.0 release");
  }
  const rootLock = lockfile.packages?.[""];
  const lockEntry = lockfile.packages?.[`node_modules/${name}`];
  if (rootLock?.dependencies?.[name] !== dependency) {
    throw new Error("package.json and package-lock.json disagree on http-client");
  }
  if (
    typeof lockEntry?.version !== "string"
    || lockEntry.resolved !== `https://registry.npmjs.org/@ismail-elkorchi/http-client/-/http-client-${lockEntry.version}.tgz`
    || typeof lockEntry?.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockEntry.integrity)
  ) {
    throw new Error("http-client must resolve from the public npm registry with integrity");
  }
  if (
    installedManifest.name !== name
    || installedManifest.version !== lockEntry.version
  ) {
    throw new Error("installed http-client does not match the public-registry lock entry");
  }
  return Object.freeze({
    name,
    version: installedManifest.version,
    integrity: lockEntry.integrity
  });
}
