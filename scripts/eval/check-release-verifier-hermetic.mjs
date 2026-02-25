import { resolve } from "node:path";

import { writeJsonReport } from "./json-report-io.mjs";
import { DEFAULT_VERIFIER_ENTRY_SCRIPTS, scanVerifierHermeticity } from "./release-verifier-hermetic-lib.mjs";

function parseArgs(argv) {
  const options = {
    output: "reports/release-verifier-hermetic.json"
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      throw new Error(`unsupported argument: ${arg}`);
    }
    const [rawKey, ...rawValueParts] = arg.slice(2).split("=");
    const value = rawValueParts.join("=").trim();
    if (value.length === 0) {
      throw new Error(`missing value for argument: ${arg}`);
    }
    if (rawKey === "output") {
      options.output = value;
      continue;
    }
    throw new Error(`unsupported argument key: ${rawKey}`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await scanVerifierHermeticity(DEFAULT_VERIFIER_ENTRY_SCRIPTS, process.cwd());

  const report = {
    suite: "release-verifier-hermetic",
    timestamp: new Date().toISOString(),
    entryScripts: result.entryScripts,
    scannedFileCount: result.scannedFiles.length,
    violations: result.violations,
    ok: result.violations.length === 0
  };

  const outputPath = resolve(options.output);
  await writeJsonReport(outputPath, report);

  if (!report.ok) {
    throw new Error("release verifier hermetic import check failed");
  }

  process.stdout.write(`release verifier hermetic check ok: ${outputPath}\n`);
}

await main();
