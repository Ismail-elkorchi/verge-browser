import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const packageJsonUrl = new globalThis.URL("../../package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
const docsName = typeof packageJson.name === "string" && packageJson.name.length > 0
  ? packageJson.name
  : "verge-browser";
const outputDir = resolve(process.cwd(), "tmp/jsr-docs-html");

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

execFileSync("deno", [
  "doc",
  "--html",
  `--name=${docsName}`,
  `--output=${outputDir}`,
  "--no-lock",
  "--sloppy-imports",
  "jsr/mod.ts"
], {
  stdio: "inherit"
});
