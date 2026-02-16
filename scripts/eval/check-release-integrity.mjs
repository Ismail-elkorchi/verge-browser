import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { writeJsonReport } from "./render-eval-lib.mjs";

function runNpmPackDryRun() {
  const result = spawnSync("npm", ["pack", "--json", "--dry-run"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr}`);
  }

  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    throw new Error("npm pack --dry-run produced empty output");
  }
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("unexpected npm pack --dry-run JSON payload");
  }
  return parsed[0];
}

async function main() {
  const packResult = runNpmPackDryRun();
  const files = Array.isArray(packResult.files)
    ? packResult.files
        .map((entry) => (entry && typeof entry.path === "string" ? entry.path : null))
        .filter((entry) => entry !== null)
    : [];

  const forbiddenPrefixes = ["reports/", "tmp/", "test/", "scripts/"];
  const forbiddenEntries = files.filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix))
  );

  const hasDist = files.some((path) => path.startsWith("dist/"));
  const hasReadme = files.includes("README.md");
  const hasLicense = files.includes("LICENSE");

  const report = {
    suite: "release-integrity",
    timestamp: new Date().toISOString(),
    tarball: {
      filename: packResult.filename,
      packageSize: packResult.size,
      unpackedSize: packResult.unpackedSize
    },
    files: {
      count: files.length,
      hasDist,
      hasReadme,
      hasLicense,
      forbiddenPrefixes,
      forbiddenEntries
    },
    ok: hasDist && hasReadme && hasLicense && forbiddenEntries.length === 0
  };

  const reportPath = resolve("reports/release-integrity.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("release integrity check failed");
  }

  process.stdout.write(`release integrity ok: ${reportPath}\n`);
}

await main();
