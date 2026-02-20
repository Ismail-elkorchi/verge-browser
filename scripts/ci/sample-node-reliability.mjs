import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    workflow: "CI",
    sampleSize: 20,
    pivotSha: "fd9887b1d9e3577b306deb75c1185be8cd774964",
    outputPath: resolve("reports/ci-node-reliability.json")
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
      options.sampleSize = value;
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
    "200",
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allRuns = listCiRuns(options.workflow)
    .filter((run) => run.status === "completed")
    .filter((run) => run.conclusion !== "cancelled");

  const pivotRun = allRuns.find((run) => run.headSha === options.pivotSha && run.event === "push");
  if (!pivotRun) {
    throw new Error(`pivot run not found for sha ${options.pivotSha}`);
  }
  const pivotTime = pivotRun.createdAt;

  const beforeCandidates = allRuns
    .filter((run) => run.createdAt < pivotTime)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, options.sampleSize * 2);
  const afterCandidates = allRuns
    .filter((run) => run.createdAt > pivotTime)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, options.sampleSize * 2);

  const collectSample = (candidates) => {
    const sample = [];
    for (const run of candidates) {
      const nodeJob = fetchNodeJob(run.databaseId);
      if (!nodeJob || nodeJob.status !== "completed" || nodeJob.conclusion === "cancelled") {
        continue;
      }
      sample.push(compactRun(run, nodeJob));
      if (sample.length >= options.sampleSize) {
        break;
      }
    }
    return sample;
  };

  const beforeSample = collectSample(beforeCandidates);
  const afterSample = collectSample(afterCandidates);

  if (beforeSample.length < options.sampleSize || afterSample.length < options.sampleSize) {
    throw new Error(
      `insufficient sample: before=${String(beforeSample.length)} after=${String(afterSample.length)} requested=${String(options.sampleSize)}`
    );
  }

  const beforeSummary = summarizeSample(beforeSample);
  const afterSummary = summarizeSample(afterSample);
  const deltaFailureRate = Number((afterSummary.failureRate - beforeSummary.failureRate).toFixed(6));

  const report = {
    suite: "ci-node-reliability-sample",
    timestamp: new Date().toISOString(),
    workflow: options.workflow,
    sampleSize: options.sampleSize,
    pivot: {
      sha: options.pivotSha,
      runId: pivotRun.databaseId,
      createdAt: pivotRun.createdAt,
      title: pivotRun.displayTitle
    },
    before: {
      summary: beforeSummary,
      runs: beforeSample
    },
    after: {
      summary: afterSummary,
      runs: afterSample
    },
    delta: {
      failureRate: deltaFailureRate
    }
  };

  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `ci node reliability sample ok: beforeFailureRate=${String(beforeSummary.failureRate)} afterFailureRate=${String(afterSummary.failureRate)} delta=${String(deltaFailureRate)}\n`
  );
}

await main();
