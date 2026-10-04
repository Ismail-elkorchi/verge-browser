import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDependencyInstall } from "./dependency-package-contract.mjs";


async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const root = process.cwd();
const manifest = await readJson(resolve(root, "package.json"));
const lockfile = await readJson(resolve(root, "package-lock.json"));
const installedLock = await readJson(resolve(root, "node_modules", ".package-lock.json"));
const dependencyEvidence = await Promise.all([
  "@ismail-elkorchi/html-parser",
  "@ismail-elkorchi/css-parser",
  "@ismail-elkorchi/http-client",
  "@ismail-elkorchi/terminal-ui"
].map(async (name) => {
  const dependencySpec = manifest.dependencies?.[name];
  if (lockfile.packages?.[""]?.dependencies?.[name] !== dependencySpec) {
    throw new Error(`package.json and package-lock.json disagree on ${name}`);
  }
  return validateDependencyInstall({
    name,
    dependencySpec,
    lockEntry: lockfile.packages?.[`node_modules/${name}`],
    installedLockEntry: installedLock.packages?.[`node_modules/${name}`],
    installedManifest: await readJson(resolve(root, "node_modules", ...name.split("/"), "package.json"))
  });
}));

for (const parser of ["html-parser", "css-parser"]) {
  await import(pathToFileURL(resolve(root, "node_modules", "@ismail-elkorchi", parser, "dist", "mod.js")).href);
}

// A Git install must run the upstream prepare build; source metadata alone is insufficient.
for (const entry of ["component", "components", "tui"]) {
  await import(pathToFileURL(resolve(root, "node_modules", "@ismail-elkorchi", "terminal-ui", "dist", entry, "index.js")).href);
}

process.stdout.write(
  `clean install verified: `
  + `${dependencyEvidence.map((entry) => `${entry.name}@${entry.revision ?? entry.version} ${entry.integrity}`).join("; ")}\n`
);
