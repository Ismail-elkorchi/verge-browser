import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function readJson(path) {
  const content = await readFile(resolve(path), "utf8");
  return JSON.parse(content);
}

export async function writeJsonReport(path, payload) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
