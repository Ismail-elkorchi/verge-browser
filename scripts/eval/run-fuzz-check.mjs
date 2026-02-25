import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { readJson, writeJsonReport } from "./render-eval-lib.mjs";
import { evaluateFuzzCase, generateFuzzHtml } from "./fuzz-lib.mjs";

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

function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((percentileValue / 100) * (sorted.length - 1));
  return sorted[index] ?? sorted[0] ?? 0;
}

function getFuzzPolicy(config, profile) {
  const defaults = profile === "release"
    ? { seed: 20260226, caseCount: 512, maxDepth: 6, sectionCount: 10, topSlowest: 20 }
    : { seed: 20260226, caseCount: 128, maxDepth: 5, sectionCount: 8, topSlowest: 10 };
  const policy = config?.fuzz?.profiles?.[profile] ?? {};
  return {
    seed: Number.isSafeInteger(policy.seed) ? policy.seed : defaults.seed,
    caseCount: Number.isSafeInteger(policy.caseCount) ? policy.caseCount : defaults.caseCount,
    maxDepth: Number.isSafeInteger(policy.maxDepth) ? policy.maxDepth : defaults.maxDepth,
    sectionCount: Number.isSafeInteger(policy.sectionCount) ? policy.sectionCount : defaults.sectionCount,
    topSlowest: Number.isSafeInteger(policy.topSlowest) ? policy.topSlowest : defaults.topSlowest
  };
}

async function main() {
  const profile = parseProfile(process.argv.slice(2));
  const config = await readJson(resolve("evaluation.config.json"));
  const policy = getFuzzPolicy(config, profile);

  const deterministicMismatches = [];
  const crashes = [];
  const durations = [];
  const slowest = [];

  for (let index = 0; index < policy.caseCount; index += 1) {
    const caseSeed = policy.seed + index;
    const caseId = `fuzz-${profile}-${String(index + 1).padStart(4, "0")}`;
    const html = generateFuzzHtml(caseSeed, {
      maxDepth: policy.maxDepth,
      sectionCount: policy.sectionCount
    });

    const caseEntry = { caseId, seed: caseSeed, html };
    const start = performance.now();
    try {
      const first = evaluateFuzzCase(caseEntry);
      const second = evaluateFuzzCase(caseEntry);
      const durationMs = performance.now() - start;
      durations.push(durationMs);

      if (JSON.stringify(first) !== JSON.stringify(second)) {
        deterministicMismatches.push({
          caseId,
          seed: caseSeed,
          first,
          second
        });
      }

      slowest.push({
        caseId,
        seed: caseSeed,
        durationMs: Number(durationMs.toFixed(6)),
        parseErrorCount: first.parseErrorCount,
        lineCount: first.lineCount,
        linkCount: first.linkCount
      });
    } catch (error) {
      const durationMs = performance.now() - start;
      durations.push(durationMs);
      crashes.push({
        caseId,
        seed: caseSeed,
        durationMs: Number(durationMs.toFixed(6)),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  slowest.sort((left, right) => right.durationMs - left.durationMs);
  const topSlowest = slowest.slice(0, policy.topSlowest);

  const report = {
    suite: "fuzz",
    timestamp: new Date().toISOString(),
    profile,
    policy,
    totals: {
      caseCount: policy.caseCount,
      crashes: crashes.length,
      deterministicMismatches: deterministicMismatches.length
    },
    timing: {
      p50Ms: Number(percentile(durations, 50).toFixed(6)),
      p95Ms: Number(percentile(durations, 95).toFixed(6)),
      maxMs: Number((durations.length > 0 ? Math.max(...durations) : 0).toFixed(6))
    },
    topSlowest,
    crashes,
    deterministicMismatches,
    ok: crashes.length === 0 && deterministicMismatches.length === 0
  };

  const reportPath = resolve("reports/fuzz.json");
  await writeJsonReport(reportPath, report);

  if (!report.ok) {
    throw new Error("fuzz check failed");
  }

  process.stdout.write(`fuzz check ${profile} ok: ${reportPath}\n`);
}

await main();
