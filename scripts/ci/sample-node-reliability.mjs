import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    workflow: "CI",
    sampleSizePerEvent: 10,
    events: ["push", "pull_request"],
    pivotSha: "fd9887b1d9e3577b306deb75c1185be8cd774964",
    outputPath: resolve("reports/ci-node-reliability.json"),
    confidence: 0.95,
    requireNonOverlap: false
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
    if (arg.startsWith("--pivot-sha=")) {
      options.pivotSha = arg.slice("--pivot-sha=".length).trim();
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
    "300",
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
    return {
      lower: 0,
      upper: 0
    };
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
    return {
      lower: 0,
      upper: 0
    };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const z = zScoreForConfidence(options.confidence);

  const allRuns = listCiRuns(options.workflow)
    .filter((run) => run.status === "completed")
    .filter((run) => run.conclusion !== "cancelled");

  const pivotRun = allRuns.find((run) => run.headSha === options.pivotSha && run.event === "push");
  if (!pivotRun) {
    throw new Error(`pivot run not found for sha ${options.pivotSha}`);
  }
  const pivotTime = pivotRun.createdAt;

  const strata = [];
  for (const event of options.events) {
    const beforeCandidates = allRuns
      .filter((run) => run.event === event)
      .filter((run) => run.createdAt < pivotTime)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.sampleSizePerEvent * 8);

    const afterCandidates = allRuns
      .filter((run) => run.event === event)
      .filter((run) => run.createdAt > pivotTime)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.sampleSizePerEvent * 8);

    const beforeSample = collectSample(beforeCandidates, options.sampleSizePerEvent);
    const afterSample = collectSample(afterCandidates, options.sampleSizePerEvent);

    if (beforeSample.length < options.sampleSizePerEvent || afterSample.length < options.sampleSizePerEvent) {
      throw new Error(
        `insufficient sample for event ${event}: ` +
        `before=${String(beforeSample.length)} after=${String(afterSample.length)} ` +
        `requested=${String(options.sampleSizePerEvent)}`
      );
    }

    const summary = summarizeBeforeAfter(beforeSample, afterSample, z);
    strata.push({
      event,
      ...summary
    });
  }

  const overallBeforeRuns = strata.flatMap((entry) => entry.before.runs);
  const overallAfterRuns = strata.flatMap((entry) => entry.after.runs);
  const overall = summarizeBeforeAfter(overallBeforeRuns, overallAfterRuns, z);

  const nonOverlapping = intervalsDoNotOverlap(
    overall.before.failureRateInterval,
    overall.after.failureRateInterval
  );
  const upperBelowZero = overall.delta.failureRateInterval.upper < 0;

  const claim = {
    criterion: "Claim reliability improvement only if failure-rate intervals are non-overlapping and delta upper bound < 0",
    nonOverlappingFailureRateIntervals: nonOverlapping,
    deltaUpperBelowZero: upperBelowZero,
    canClaimImprovement: nonOverlapping && upperBelowZero
  };

  if (options.requireNonOverlap && !claim.canClaimImprovement) {
    throw new Error(
      "non-overlap claim criterion not met: " +
      `nonOverlap=${String(claim.nonOverlappingFailureRateIntervals)} ` +
      `deltaUpperBelowZero=${String(claim.deltaUpperBelowZero)}`
    );
  }

  const report = {
    suite: "ci-node-reliability-sample",
    timestamp: new Date().toISOString(),
    workflow: options.workflow,
    sampleSizePerEvent: options.sampleSizePerEvent,
    events: options.events,
    confidence: options.confidence,
    zScore: z,
    pivot: {
      sha: options.pivotSha,
      runId: pivotRun.databaseId,
      createdAt: pivotRun.createdAt,
      title: pivotRun.displayTitle
    },
    strata,
    before: overall.before,
    after: overall.after,
    delta: overall.delta,
    claim
  };

  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `ci node reliability sample ok: ` +
    `events=${options.events.join(",")} ` +
    `beforeFailureRate=${String(overall.before.summary.failureRate)} ` +
    `afterFailureRate=${String(overall.after.summary.failureRate)} ` +
    `delta=${String(overall.delta.failureRate)} ` +
    `ci=[${String(overall.delta.failureRateInterval.lower)},${String(overall.delta.failureRateInterval.upper)}] ` +
    `claim=${String(claim.canClaimImprovement)}\n`
  );
}

await main();
