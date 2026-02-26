import { access } from "node:fs/promises";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";

function parseProfile(argv) {
  const profileArg = argv.find((argument) => argument.startsWith("--profile="));
  if (!profileArg) {
    return "ci";
  }
  const value = profileArg.slice("--profile=".length).trim();
  if (value !== "ci" && value !== "release") {
    throw new Error(`invalid profile: ${value}`);
  }
  return value;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));
  const config = await readJson("evaluation.config.json");
  const profilePolicy = config.render?.profiles?.[profile] ?? {};
  const requireFlags = Object.keys(profilePolicy).filter((key) => key.startsWith("require"));

  const requireFlagReportMap = {
    requireRuntimeMatrix: ["reports/runtime-matrix.json"],
    requireFuzzGuided: ["reports/fuzz-guided.json"]
  };
  const requireFlagProducerMap = {
    requireRuntimeMatrix: ["scripts/eval/check-runtime-matrix.mjs"],
    requireFuzzGuided: ["scripts/eval/run-fuzz-guided-check.mjs"]
  };

  const unknownRequireFlags = requireFlags.filter((flag) => !(flag in requireFlagReportMap));
  const missingProducerScripts = [];
  const missingReports = [];

  for (const flag of requireFlags) {
    if (!profilePolicy[flag]) {
      continue;
    }

    for (const scriptPath of requireFlagProducerMap[flag] ?? []) {
      if (!(await fileExists(scriptPath))) {
        missingProducerScripts.push({ flag, scriptPath });
      }
    }
    for (const reportPath of requireFlagReportMap[flag] ?? []) {
      if (!(await fileExists(reportPath))) {
        missingReports.push({ flag, reportPath });
      }
    }
  }

  const ok = unknownRequireFlags.length === 0 && missingProducerScripts.length === 0 && missingReports.length === 0;

  await writeJsonReport("reports/eval-coherence.json", {
    suite: "eval-coherence",
    profile,
    timestamp: new Date().toISOString(),
    requireFlags,
    unknownRequireFlags,
    missingProducerScripts,
    missingReports,
    overall: { ok }
  });

  if (!ok) {
    throw new Error("evaluation coherence check failed");
  }
}

await main();
