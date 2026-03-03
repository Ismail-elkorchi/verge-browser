import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");
const BACKUP_PATH = resolve(process.cwd(), "tmp", "pack-manifest.package.json.backup");
const DEV_DEPENDENCY_SPEC = "file:../html-parser";
const PUBLISH_DEPENDENCY_SPEC = "0.1.0";

function parsePackageJson(rawText) {
  return JSON.parse(rawText);
}

async function writePackageJson(manifest) {
  await writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeBackup(rawManifestText) {
  await mkdir(dirname(BACKUP_PATH), { recursive: true });
  await writeFile(BACKUP_PATH, rawManifestText, "utf8");
}

async function main() {
  const rawManifestText = await readFile(PACKAGE_JSON_PATH, "utf8");
  const manifest = parsePackageJson(rawManifestText);
  const dependencies = manifest.dependencies ?? {};
  const currentSpec = dependencies["@ismail-elkorchi/html-parser"];

  if (currentSpec !== DEV_DEPENDENCY_SPEC) {
    return;
  }

  await writeBackup(rawManifestText);
  dependencies["@ismail-elkorchi/html-parser"] = PUBLISH_DEPENDENCY_SPEC;
  manifest.dependencies = dependencies;
  await writePackageJson(manifest);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
