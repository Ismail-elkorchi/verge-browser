import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";
import { getGuidedFuzzPolicy, runGuidedFuzz } from "./fuzz-guided-lib.mjs";

function parseProfile(argv) {
  const profileArg = argv.find((argument) => argument.startsWith("--profile="));
  if (!profileArg) {
    return "ci";
  }
  const profile = profileArg.slice("--profile=".length).trim();
  if (profile !== "ci" && profile !== "release") {
    throw new Error(`invalid profile: ${profile}`);
  }
  return profile;
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));
  const config = await readJson(resolve("evaluation.config.json"));
  const policy = getGuidedFuzzPolicy(config, profile);
  const report = runGuidedFuzz(policy, profile);

  const reportPath = resolve("reports/fuzz-guided.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("fuzz-guided check failed");
  }

  process.stdout.write(`fuzz-guided check ${profile} ok: ${reportPath}\n`);
}

await main();
