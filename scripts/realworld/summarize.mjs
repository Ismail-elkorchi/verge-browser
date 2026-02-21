import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { corpusPath, readNdjson, resolveCorpusDir } from "./lib.mjs";

function formatList(items, fallback) {
  if (!items || items.length === 0) {
    return `- ${fallback}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function formatWorstEntries(entries, metricName) {
  if (!entries || entries.length === 0) {
    return "- none";
  }
  return entries
    .map((entry) => `- ${entry.sha256} (${metricName}=${String(entry[metricName])}) ${entry.finalUrl}`)
    .join("\n");
}

function formatParseErrorFrequency(entries) {
  if (!entries || entries.length === 0) {
    return "- none";
  }
  return entries.slice(0, 20).map((entry) => `- ${entry.parseErrorId}: ${String(entry.count)}`).join("\n");
}

function formatOracleTools(tools) {
  if (!tools || tools.length === 0) {
    return "- none available";
  }
  return tools.map((tool) => {
    if (!tool.available) {
      return `- ${tool.tool} (${tool.source ?? "unknown"}): unavailable${tool.error ? ` (${tool.error})` : ""}`;
    }
    return `- ${tool.tool} (${tool.source ?? "unknown"}): sha256=${tool.binarySha256} version=${tool.version}`;
  }).join("\n");
}

function formatOracleWorst(toolScores) {
  if (!toolScores || toolScores.length === 0) {
    return "- no oracle comparisons were executed";
  }
  const lines = [];
  for (const score of toolScores) {
    lines.push(
      `- ${score.tool}: meanRawTokenF1=${String(score.meanRawTokenF1)} meanNormalizedTokenF1=${String(score.meanNormalizedTokenF1)}`
    );
    if (score.worstRaw.length > 0) {
      const worstRaw = score.worstRaw[0];
      lines.push(
        `  worst raw: ${worstRaw.sha256} width=${String(worstRaw.width)} rawTokenF1=${String(worstRaw.rawTokenF1)} normalizedTokenF1=${String(worstRaw.normalizedTokenF1)}`
      );
    }
    if (score.worstNormalized.length > 0) {
      const worstNormalized = score.worstNormalized[0];
      lines.push(
        `  worst normalized: ${worstNormalized.sha256} width=${String(worstNormalized.width)} rawTokenF1=${String(worstNormalized.rawTokenF1)} normalizedTokenF1=${String(worstNormalized.normalizedTokenF1)}`
      );
    }
  }
  return lines.join("\n");
}

function formatOracleBySurface(surfaceScores) {
  if (!surfaceScores || surfaceScores.length === 0) {
    return "- no surface split available";
  }
  const lines = [];
  for (const surfaceEntry of surfaceScores) {
    lines.push(`- ${surfaceEntry.surface}: pages=${String(surfaceEntry.pages)}`);
    if (!surfaceEntry.toolScores || surfaceEntry.toolScores.length === 0) {
      lines.push("  no comparisons");
      continue;
    }
    for (const score of surfaceEntry.toolScores) {
      lines.push(
        `  ${score.tool}: meanRawTokenF1=${String(score.meanRawTokenF1)} meanNormalizedTokenF1=${String(score.meanNormalizedTokenF1)}`
      );
    }
  }
  return lines.join("\n");
}

function formatCohortGovernance(report) {
  if (!report) {
    return "- cohort governance report is unavailable";
  }
  if (!Array.isArray(report.cohorts) || report.cohorts.length === 0) {
    return "- no cohort rows available";
  }
  const lines = [];
  for (const cohort of report.cohorts) {
    lines.push(
      `- ${cohort.id}: pages=${String(cohort.observed.pages)} records=${String(cohort.observed.records)} weight=${String(cohort.weight)}`
    );
    lines.push(
      `  meanDelta=${String(cohort.scores.meanDeltaNormalizedTokenF1)} residualWeightedDelta=${String(cohort.scores.residualWeightedDeltaNormalizedTokenF1)} quotaPass=${String(cohort.checks.quota.pass)}`
    );
  }
  return lines.join("\n");
}

async function main() {
  const corpusDir = resolveCorpusDir();
  const pageSummaryPath = corpusPath(corpusDir, "reports/field-summary.json");
  const oracleSummaryPath = corpusPath(corpusDir, "reports/oracle-summary.json");
  const cssManifestPath = corpusPath(corpusDir, "manifests/css.ndjson");
  const cohortGovernancePath = corpusPath(corpusDir, "reports/cohort-governance-v4.json");

  const fieldSummary = JSON.parse(await readFile(pageSummaryPath, "utf8"));
  const oracleSummary = JSON.parse(await readFile(oracleSummaryPath, "utf8"));
  const cssRecords = await readNdjson(cssManifestPath);
  let cohortGovernance = null;
  try {
    cohortGovernance = JSON.parse(await readFile(cohortGovernancePath, "utf8"));
  } catch {
    cohortGovernance = null;
  }

  const cssByKind = cssRecords.reduce((acc, record) => {
    const key = record.kind ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const markdownLines = [
    "# Field report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Corpus",
    `- pages: ${String(fieldSummary.corpus.pageCount)}`,
    `- css payload records: ${String(cssRecords.length)}`,
    `- css by kind: ${JSON.stringify(cssByKind)}`,
    "",
    "## Timing distribution",
    `- parse p50 ms: ${String(fieldSummary.timing.parseMs.p50)}`,
    `- parse p95 ms: ${String(fieldSummary.timing.parseMs.p95)}`,
    `- render p50 ms: ${String(fieldSummary.timing.renderMs.p50)}`,
    `- render p95 ms: ${String(fieldSummary.timing.renderMs.p95)}`,
    "",
    "## Worst pages by parse time",
    formatWorstEntries(fieldSummary.worst.parseTimeMs, "parseTimeMs"),
    "",
    "## Worst pages by render time",
    formatWorstEntries(fieldSummary.worst.renderTimeMs, "renderTimeMs"),
    "",
    "## Parse error frequencies",
    formatParseErrorFrequency(fieldSummary.parseErrorIdFrequency),
    "",
    "## Oracle availability and fingerprints",
    `- source mode: ${oracleSummary.sourceMode ?? "unknown"}`,
    ...(oracleSummary.image
      ? [
        `- image fingerprint: ${oracleSummary.image.fingerprint}`,
        `- image package count: ${String(oracleSummary.image.packageCount)}`
      ]
      : []),
    ...(oracleSummary.normalization
      ? [
        `- normalization version: ${oracleSummary.normalization.version}`,
        `- normalization mode: ${oracleSummary.normalization.mode}`
      ]
      : []),
    formatOracleTools(oracleSummary.tools),
    "",
    "## Worst oracle disagreements",
    formatOracleWorst(oracleSummary.toolScores),
    "",
    "## Oracle scores by page surface",
    `- page surfaces: ${JSON.stringify(oracleSummary.pageSurfaceCounts ?? {})}`,
    formatOracleBySurface(oracleSummary.toolScoresBySurface),
    "",
    "## Cohort governance v4",
    `- report ok: ${String(cohortGovernance?.ok ?? false)}`,
    `- snapshot fingerprint: ${String(cohortGovernance?.snapshot?.fingerprint ?? "missing")}`,
    `- weighted mean delta: ${String(cohortGovernance?.weightedAggregate?.meanDeltaNormalizedTokenF1 ?? "missing")}`,
    `- weighted residual delta: ${String(cohortGovernance?.weightedAggregate?.residualWeightedDeltaNormalizedTokenF1 ?? "missing")}`,
    formatCohortGovernance(cohortGovernance),
    "",
    "## Parity checks",
    formatList(
      [
        `parseBytes vs parseStream mismatches: ${String(fieldSummary.parity.parseBytesVsParseStreamMismatches)}`
      ],
      "no parity checks"
    )
  ];

  const outputPath = resolve(process.cwd(), "docs/field-report.md");
  await writeFile(outputPath, `${markdownLines.join("\n")}\n`, "utf8");
  process.stdout.write(`field-report doc updated: ${outputPath}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-report failed: ${message}\n`);
  process.exit(1);
});
