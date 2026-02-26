import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CURRENT_CORPUS_PATH = resolve("scripts/oracles/corpus/wpt-delta-v1.json");
const POLICY_PATH = resolve("scripts/oracles/corpus/wpt-delta-refresh-policy.json");
const REPORT_PATH = resolve("reports/wpt-delta-refresh-diff.json");

function runRefresh(outputPath) {
  const result = spawnSync(process.execPath, [
    "scripts/oracles/corpus/refresh-wpt-delta-corpus.mjs",
    `--policy=${POLICY_PATH}`,
    `--output=${outputPath}`
  ], {
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `refresh command failed with status ${String(result.status)}\nstdout=${result.stdout ?? ""}\nstderr=${result.stderr ?? ""}`
    );
  }
}

function readJson(path) {
  return readFile(path, "utf8").then((source) => JSON.parse(source));
}

function mapById(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.id, entry);
  }
  return map;
}

function diffCaseSets(currentCases, refreshedCases) {
  const currentById = mapById(currentCases);
  const refreshedById = mapById(refreshedCases);

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, entry] of refreshedById.entries()) {
    if (!currentById.has(id)) {
      added.push({ id, sourcePath: entry.sourcePath });
      continue;
    }
    const currentEntry = currentById.get(id);
    const fieldDiffs = [];
    for (const field of ["category", "sourcePath", "sha256", "html"]) {
      if (currentEntry[field] !== entry[field]) {
        fieldDiffs.push(field);
      }
    }
    if (fieldDiffs.length > 0) {
      changed.push({ id, fields: fieldDiffs });
    }
  }

  for (const [id, entry] of currentById.entries()) {
    if (!refreshedById.has(id)) {
      removed.push({ id, sourcePath: entry.sourcePath });
    }
  }

  added.sort((left, right) => left.id.localeCompare(right.id));
  removed.sort((left, right) => left.id.localeCompare(right.id));
  changed.sort((left, right) => left.id.localeCompare(right.id));

  return { added, removed, changed };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writeReport(report) {
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
  const scratchDir = await mkdtemp(join(tmpdir(), "verge-wpt-delta-"));
  const refreshedPath = join(scratchDir, "wpt-delta-refresh-candidate.json");

  try {
    runRefresh(refreshedPath);

    const [currentCorpus, refreshedCorpus] = await Promise.all([
      readJson(CURRENT_CORPUS_PATH),
      readJson(refreshedPath)
    ]);

    const caseDiff = diffCaseSets(currentCorpus.cases, refreshedCorpus.cases);
    const sourceDiff = {
      repositoryChanged: currentCorpus?.source?.repository !== refreshedCorpus?.source?.repository,
      commitChanged: currentCorpus?.source?.commit !== refreshedCorpus?.source?.commit,
      currentRepository: currentCorpus?.source?.repository ?? null,
      refreshedRepository: refreshedCorpus?.source?.repository ?? null,
      currentCommit: currentCorpus?.source?.commit ?? null,
      refreshedCommit: refreshedCorpus?.source?.commit ?? null
    };

    const casePlanChanged = !sameJson(currentCorpus.casePlan ?? [], refreshedCorpus.casePlan ?? []);
    const policyChanged = currentCorpus.policy
      ? !sameJson(currentCorpus.policy, refreshedCorpus.policy ?? {})
      : false;

    const report = {
      suite: "wpt-delta-refresh-diff",
      timestamp: new Date().toISOString(),
      policyPath: POLICY_PATH,
      currentCorpusPath: CURRENT_CORPUS_PATH,
      refreshedCorpusPath: refreshedPath,
      sourceDiff,
      casePlanChanged,
      policyChanged,
      caseDiff: {
        addedCount: caseDiff.added.length,
        removedCount: caseDiff.removed.length,
        changedCount: caseDiff.changed.length,
        added: caseDiff.added,
        removed: caseDiff.removed,
        changed: caseDiff.changed
      },
      ok:
        !sourceDiff.repositoryChanged
        && !sourceDiff.commitChanged
        && !casePlanChanged
        && !policyChanged
        && caseDiff.added.length === 0
        && caseDiff.removed.length === 0
        && caseDiff.changed.length === 0
    };

    await writeReport(report);

    if (!report.ok) {
      throw new Error("wpt delta refresh diff detected changes");
    }

    process.stdout.write(`wpt delta refresh diff ok: ${REPORT_PATH}\n`);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

await main();
