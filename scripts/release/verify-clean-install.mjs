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
const dependencyEvidence = await Promise.all([
  "@ismail-elkorchi/css-parser",
  "@ismail-elkorchi/http-client",
  "@ismail-elkorchi/terminal-ui"
].map(async (name) => validatePublishedDependencyInstall({
  name,
  manifest,
  lockfile,
  installedManifest: await readJson(resolve(root, "node_modules", ...name.split("/"), "package.json"))
})));

process.stdout.write(
  `clean install verified: ${evidence.name}@${evidence.version} ${evidence.integrity}; `
  + `${dependencyEvidence.map((entry) => `${entry.name}@${entry.version} ${entry.integrity}`).join("; ")}\n`
);

function validatePublishedDependencyInstall({
  name,
  manifest,
  lockfile,
  installedManifest
}) {
  const dependency = manifest.dependencies?.[name];
  if (typeof dependency !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(dependency)) {
    throw new Error(`${name} must use an exact published version`);
  }
  const rootLock = lockfile.packages?.[""];
  const lockEntry = lockfile.packages?.[`node_modules/${name}`];
  if (rootLock?.dependencies?.[name] !== dependency) {
    throw new Error(`package.json and package-lock.json disagree on ${name}`);
  }
  if (
    typeof lockEntry?.version !== "string"
    || lockEntry.version !== dependency
    || lockEntry.resolved !== `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${lockEntry.version}.tgz`
    || typeof lockEntry?.integrity !== "string"
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(lockEntry.integrity)
  ) {
    throw new Error(`${name} must resolve from the public npm registry with integrity`);
  }
  if (
    installedManifest.name !== name
    || installedManifest.version !== lockEntry.version
  ) {
    throw new Error(`installed ${name} does not match the public-registry lock entry`);
  }
  return Object.freeze({
    name,
    version: installedManifest.version,
    integrity: lockEntry.integrity
  });
}
