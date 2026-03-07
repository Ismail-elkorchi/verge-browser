import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const distPath = join(scriptDirectory, "..", "..", "dist");

await rm(distPath, { recursive: true, force: true });
