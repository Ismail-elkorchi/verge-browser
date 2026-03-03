import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const PACKAGE_JSON_PATH = resolve(process.cwd(), "package.json");
const BACKUP_PATH = resolve(process.cwd(), "tmp", "pack-manifest.package.json.backup");

async function main() {
  let backupText;
  try {
    backupText = await readFile(BACKUP_PATH, "utf8");
  } catch (error) {
    if ((error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      return;
    }
    throw error;
  }

  await writeFile(PACKAGE_JSON_PATH, backupText, "utf8");
  await rm(BACKUP_PATH, { force: true });
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
