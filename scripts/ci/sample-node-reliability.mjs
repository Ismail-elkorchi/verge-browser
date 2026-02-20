import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    workflow: "CI",
    sampleSizePerEvent: 10,
    eventSampleSizes: {},
    events: ["push", "pull_request"],
    outputPath: resolve("reports/ci-node-reliability.json"),
    confidence: 0.95,
    requireNonOverlap: false,
    mode: "rolling",
    windowCount: 3,
    pivotSha: null
  };

  for (const arg of argv) {
    if (arg.startsWith("--workflow=")) {
      options.workflow = arg.slice("--workflow=".length).trim();
      continue;
    }
    if (arg.startsWith("--sample-size=")) {
      const value = Number.parseInt(arg.slice("--sample-size=".length), 10);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`invalid --sample-size value: ${arg}`);
      }
      options.sampleSizePerEvent = value;
      continue;
    }
    if (arg.startsWith("--sample-size-per-event=")) {
      const value = Number.parseInt(arg.slice("--sample-size-per-event=".length), 10);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`invalid --sample-size-per-event value: ${arg}`);
      }
      options.sampleSizePerEvent = value;
      continue;
    }
    if (arg.startsWith("--events=")) {
      const events = arg.slice("--events=".length)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (events.length === 0) {
        throw new Error(`invalid --events value: ${arg}`);
      }
      options.events = [...new Set(events)];
      continue;
    }
    if (arg.startsWith("--event-sample-sizes=")) {
      const rawEntries = arg.slice("--event-sample-sizes=".length).split(",");
      const parsed = {};
      for (const rawEntry of rawEntries) {
        const entry = rawEntry.trim();
        if (entry.length === 0) {
          continue;
        }
        const separator = entry.indexOf(":");
        if (separator <= 0 || separator === entry.length - 1) {
          throw new Error(`invalid --event-sample-sizes entry: ${rawEntry}`);
        }
        const event = entry.slice(0, separator).trim();
        const size = Number.parseInt(entry.slice(separator + 1).trim(), 10);
        if (!Number.isSafeInteger(size) || size < 1) {
          throw new Error(`invalid --event-sample-sizes entry: ${rawEntry}`);
        }
        parsed[event] = size;
      }
      options.eventSampleSizes = parsed;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.outputPath = resolve(arg.slice("--output=".length).trim());
      continue;
    }
    if (arg.startsWith("--confidence=")) {
      const value = Number.parseFloat(arg.slice("--confidence=".length));
      if (!(value > 0 && value < 1)) {
        throw new Error(`invalid --confidence value: ${arg}`);
      }
      options.confidence = value;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length).trim();
      if (value !== "rolling" && value !== "pivot") {
        throw new Error(`invalid --mode value: ${arg}`);
      }
      options.mode = value;
      continue;
    }
    if (arg.startsWith("--window-count=")) {
      const value = Number.parseInt(arg.slice("--window-count=".length), 10);
      if (!Number.isSafeInteger(value) || value < 2) {
        throw new Error(`invalid --window-count value: ${arg}`);
      }
      options.windowCount = value;
      continue;
    }
    if (arg.startsWith("--pivot-sha=")) {
      options.pivotSha = arg.slice("--pivot-sha=".length).trim();
      options.mode = "pivot";
      continue;
    }
    if (arg === "--require-non-overlap") {
      options.requireNonOverlap = true;
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }

  return options;
}

function runGhJson(args) {
  const stdout = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function listCiRuns(workflow) {
  return runGhJson([
    "run",
    "list",
    "--workflow",
    workflow,
    "--limit",
    "400",
    "--json",
    "databaseId,headSha,headBranch,status,conclusion,event,createdAt,displayTitle,url"
  ]);
}

function fetchNodeJob(runId) {
  const response = runGhJson([
    "api",
    `repos/Ismail-elkorchi/verge-browser/actions/runs/${String(runId)}/jobs`
  ]);
  const jobs = Array.isArray(response.jobs) ? response.jobs : [];
  return jobs.find((job) => job.name === "node") ?? null;
}

function summarizeSample(entries) {
  const total = entries.length;
  const passed = entries.filter((entry) => entry.nodeConclusion === "success").length;
  const failed = entries.filter((entry) => entry.nodeConclusion !== "success").length;
  return {
    total,
    passed,
    failed,
    failureRate: total === 0 ? 0 : Number((failed / total).toFixed(6)),
    passRate: total === 0 ? 0 : Number((passed / total).toFixed(6))
  };
}

function zScoreForConfidence(confidence) {
  if (confidence >= 0.999) return 3.291;
  if (confidence >= 0.99) return 2.576;
  if (confidence >= 0.98) return 2.326;
  if (confidence >= 0.95) return 1.96;
  if (confidence >= 0.9) return 1.645;
  return 1.282;
}

function clamp01(value) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function wilsonInterval(successes, total, z) {
  if (total === 0) {
    return { lower: 0, upper: 0 };
  }
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + (z2 / total);
  const center = (p + (z2 / (2 * total))) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total)))) / denominator;
  return {
    lower: Number(clamp01(center - margin).toFixed(6)),
    upper: Number(clamp01(center + margin).toFixed(6))
  };
}

function differenceInterval(summaryBefore, summaryAfter, z) {
  const n1 = summaryBefore.total;
  const n2 = summaryAfter.total;
  if (n1 === 0 || n2 === 0) {
    return { lower: 0, upper: 0 };
  }
  const p1 = summaryBefore.failureRate;
  const p2 = summaryAfter.failureRate;
  const delta = p2 - p1;
  const se = Math.sqrt((p1 * (1 - p1) / n1) + (p2 * (1 - p2) / n2));
  const margin = z * se;
  return {
    lower: Number(Math.max(-1, delta - margin).toFixed(6)),
    upper: Number(Math.min(1, delta + margin).toFixed(6))
  };
}

function intervalsDoNotOverlap(left, right) {
  return left.upper < right.lower || right.upper < left.lower;
}

function compactRun(run, nodeJob) {
  return {
    runId: run.databaseId,
    createdAt: run.createdAt,
    event: run.event,
    conclusion: run.conclusion,
    headSha: run.headSha,
    headBranch: run.headBranch,
    title: run.displayTitle,
    url: run.url,
    nodeStatus: nodeJob?.status ?? "missing",
    nodeConclusion: nodeJob?.conclusion ?? "missing"
  };
}

function collectSample(candidates, sampleSize) {
  const sample = [];
  for (const run of candidates) {
    const nodeJob = fetchNodeJob(run.databaseId);
    if (!nodeJob || nodeJob.status !== "completed" || nodeJob.conclusion === "cancelled") {
      continue;
    }
    sample.push(compactRun(run, nodeJob));
    if (sample.length >= sampleSize) {
      break;
    }
  }
  return sample;
}

function collectRollingWindows(candidates, sampleSize, windowCount, event) {
  const windows = [];
  const stride = Math.max(1, sampleSize);
  for (let index = 0; index < windowCount; index += 1) {
    const start = index * stride;
    const windowCandidates = candidates.slice(start, start + sampleSize * 12);
    const windowSample = collectSample(windowCandidates, sampleSize);
    if (windowSample.length < sampleSize) {
      break;
    }
    windows.push({
      windowIndex: index,
      label: index === 0 ? "current" : `prior-${String(index)}`,
      runs: windowSample
    });
  }
  if (windows.length === 0) {
    throw new Error(
      `insufficient rolling sample for event ${event}: collected=0 requiredWindowSample=${String(sampleSize)}`
    );
  }
  return windows;
}

function summarizeBeforeAfter(beforeSample, afterSample, z) {
  const beforeSummary = summarizeSample(beforeSample);
  const afterSummary = summarizeSample(afterSample);
  const beforeCi = wilsonInterval(beforeSummary.failed, beforeSummary.total, z);
  const afterCi = wilsonInterval(afterSummary.failed, afterSummary.total, z);
  const deltaFailureRate = Number((afterSummary.failureRate - beforeSummary.failureRate).toFixed(6));
  const deltaCi = differenceInterval(beforeSummary, afterSummary, z);
  return {
    before: {
      summary: beforeSummary,
      failureRateInterval: beforeCi,
      runs: beforeSample
    },
    after: {
      summary: afterSummary,
      failureRateInterval: afterCi,
      runs: afterSample
    },
    delta: {
      failureRate: deltaFailureRate,
      failureRateInterval: deltaCi
    }
  };
}

function evaluateClaim(summary) {
  const nonOverlapping = intervalsDoNotOverlap(
    summary.before.failureRateInterval,
    summary.after.failureRateInterval
  );
  const upperBelowZero = summary.delta.failureRateInterval.upper < 0;
  return {
    nonOverlappingFailureRateIntervals: nonOverlapping,
    deltaUpperBelowZero: upperBelowZero,
    canClaimImprovement: nonOverlapping && upperBelowZero
  };
}

function summarizeWindow(window, z) {
  const summary = summarizeSample(window.runs);
  return {
    windowIndex: window.windowIndex,
    label: window.label,
    summary,
    failureRateInterval: wilsonInterval(summary.failed, summary.total, z),
    runs: window.runs
  };
}

function buildRollingReport(allRuns, options, z) {
  const strata = [];
  for (const event of options.events) {
    const sampleSize = options.eventSampleSizes[event] ?? options.sampleSizePerEvent;
    const candidates = allRuns
      .filter((run) => run.event === event)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const windows = collectRollingWindows(candidates, sampleSize, options.windowCount, event);
    const summarizedWindows = windows.map((window) => summarizeWindow(window, z));
    const currentWindow = summarizedWindows.find((entry) => entry.windowIndex === 0);
    const previousWindow = summarizedWindows.find((entry) => entry.windowIndex === 1);
    const sampleSufficient = Boolean(currentWindow && previousWindow);
    const comparison = sampleSufficient
      ? summarizeBeforeAfter(previousWindow.runs, currentWindow.runs, z)
      : null;
    const claim = sampleSufficient
      ? evaluateClaim(comparison)
      : {
        nonOverlappingFailureRateIntervals: false,
        deltaUpperBelowZero: false,
        canClaimImprovement: false
      };
    strata.push({
      event,
      sampleSize,
      windows: summarizedWindows,
      sampleSufficient,
      comparison,
      claim
    });
  }

  const comparableStrata = strata.filter((entry) => entry.sampleSufficient);
  const previousRuns = comparableStrata.flatMap((entry) => entry.comparison.before.runs);
  const currentRuns = comparableStrata.flatMap((entry) => entry.comparison.after.runs);
  const overallComparison = previousRuns.length > 0 && currentRuns.length > 0
    ? summarizeBeforeAfter(previousRuns, currentRuns, z)
    : summarizeBeforeAfter([], [], z);
  const overallClaim = previousRuns.length > 0 && currentRuns.length > 0
    ? evaluateClaim(overallComparison)
    : {
      nonOverlappingFailureRateIntervals: false,
      deltaUpperBelowZero: false,
      canClaimImprovement: false
    };

  const claim = {
    criterion: "Claim reliability improvement only if current vs prior windows are non-overlapping and delta upper bound < 0",
    nonOverlappingFailureRateIntervals: overallClaim.nonOverlappingFailureRateIntervals,
    deltaUpperBelowZero: overallClaim.deltaUpperBelowZero,
    allStrataComparable: comparableStrata.length === strata.length,
    allStrataClaimable: comparableStrata.length > 0 && comparableStrata.every((entry) => entry.claim.canClaimImprovement),
    canClaimImprovement: overallClaim.canClaimImprovement
      && comparableStrata.length === strata.length
      && comparableStrata.every((entry) => entry.claim.canClaimImprovement)
  };

  return {
    mode: "rolling",
    windowCount: options.windowCount,
    strata,
    before: overallComparison.before,
    after: overallComparison.after,
    delta: overallComparison.delta,
    claim
  };
}

function buildPivotReport(allRuns, options, z) {
  if (!options.pivotSha) {
    throw new Error("pivot mode requires --pivot-sha");
  }
  const pivotRun = allRuns.find((run) => run.headSha === options.pivotSha && run.event === "push");
  if (!pivotRun) {
    throw new Error(`pivot run not found for sha ${options.pivotSha}`);
  }
  const pivotTime = pivotRun.createdAt;

  const strata = [];
  for (const event of options.events) {
    const sampleSize = options.eventSampleSizes[event] ?? options.sampleSizePerEvent;
    const beforeCandidates = allRuns
      .filter((run) => run.event === event)
      .filter((run) => run.createdAt < pivotTime)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, sampleSize * 12);

    const afterCandidates = allRuns
      .filter((run) => run.event === event)
      .filter((run) => run.createdAt > pivotTime)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, sampleSize * 12);

    const beforeSample = collectSample(beforeCandidates, sampleSize);
    const afterSample = collectSample(afterCandidates, sampleSize);
    if (beforeSample.length < sampleSize || afterSample.length < sampleSize) {
      throw new Error(
        `insufficient pivot sample for event ${event}: ` +
        `before=${String(beforeSample.length)} after=${String(afterSample.length)} requested=${String(sampleSize)}`
      );
    }

    const comparison = summarizeBeforeAfter(beforeSample, afterSample, z);
    const claim = evaluateClaim(comparison);
    strata.push({
      event,
      sampleSize,
      comparison,
      claim
    });
  }

  const overallBeforeRuns = strata.flatMap((entry) => entry.comparison.before.runs);
  const overallAfterRuns = strata.flatMap((entry) => entry.comparison.after.runs);
  const overallComparison = summarizeBeforeAfter(overallBeforeRuns, overallAfterRuns, z);
  const overallClaim = evaluateClaim(overallComparison);

  return {
    mode: "pivot",
    pivot: {
      sha: options.pivotSha,
      runId: pivotRun.databaseId,
      createdAt: pivotRun.createdAt,
      title: pivotRun.displayTitle
    },
    strata,
    before: overallComparison.before,
    after: overallComparison.after,
    delta: overallComparison.delta,
    claim: {
      criterion: "Claim reliability improvement only if failure-rate intervals are non-overlapping and delta upper bound < 0",
      nonOverlappingFailureRateIntervals: overallClaim.nonOverlappingFailureRateIntervals,
      deltaUpperBelowZero: overallClaim.deltaUpperBelowZero,
      allStrataClaimable: strata.every((entry) => entry.claim.canClaimImprovement),
      canClaimImprovement: overallClaim.canClaimImprovement && strata.every((entry) => entry.claim.canClaimImprovement)
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const z = zScoreForConfidence(options.confidence);

  const allRuns = listCiRuns(options.workflow)
    .filter((run) => run.status === "completed")
    .filter((run) => run.conclusion !== "cancelled");

  const modeReport = options.mode === "pivot"
    ? buildPivotReport(allRuns, options, z)
    : buildRollingReport(allRuns, options, z);

  if (options.requireNonOverlap && !modeReport.claim.canClaimImprovement) {
    throw new Error(
      "non-overlap claim criterion not met: " +
      `nonOverlap=${String(modeReport.claim.nonOverlappingFailureRateIntervals)} ` +
      `deltaUpperBelowZero=${String(modeReport.claim.deltaUpperBelowZero)} ` +
      `allStrataClaimable=${String(modeReport.claim.allStrataClaimable)}`
    );
  }

  const report = {
    suite: "ci-node-reliability-sample",
    timestamp: new Date().toISOString(),
    workflow: options.workflow,
    mode: modeReport.mode,
    sampleSizePerEvent: options.sampleSizePerEvent,
    eventSampleSizes: options.eventSampleSizes,
    events: options.events,
    confidence: options.confidence,
    zScore: z,
    ...(modeReport.mode === "rolling" ? { windowCount: modeReport.windowCount } : {}),
    ...(modeReport.mode === "pivot" ? { pivot: modeReport.pivot } : {}),
    strata: modeReport.strata,
    before: modeReport.before,
    after: modeReport.after,
    delta: modeReport.delta,
    claim: modeReport.claim
  };

  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `ci node reliability sample ok: ` +
    `mode=${modeReport.mode} ` +
    `events=${options.events.join(",")} ` +
    `beforeFailureRate=${String(modeReport.before.summary.failureRate)} ` +
    `afterFailureRate=${String(modeReport.after.summary.failureRate)} ` +
    `delta=${String(modeReport.delta.failureRate)} ` +
    `ci=[${String(modeReport.delta.failureRateInterval.lower)},${String(modeReport.delta.failureRateInterval.upper)}] ` +
    `claim=${String(modeReport.claim.canClaimImprovement)}\n`
  );
}

await main();
