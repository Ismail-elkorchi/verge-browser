import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateWorkspaceParserInstall } from "./parser-package-contract.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const root = process.cwd();
const evidence = validateWorkspaceParserInstall({
  manifest: await readJson(resolve(root, "package.json")),
  lockfile: await readJson(resolve(root, "package-lock.json")),
  installedManifest: await readJson(
    resolve(root, "node_modules", "@ismail-elkorchi", "html-parser", "package.json")
  )
});

process.stdout.write(
  `clean install verified: ${evidence.name}@${evidence.version} ${evidence.integrity}\n`
);
