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
    lines.push(`- ${score.tool}: meanTokenF1=${String(score.meanTokenF1)}`);
    if (score.worst.length > 0) {
      const worstCase = score.worst[0];
      lines.push(`  worst: ${worstCase.sha256} width=${String(worstCase.width)} tokenF1=${String(worstCase.tokenF1)}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const corpusDir = resolveCorpusDir();
  const pageSummaryPath = corpusPath(corpusDir, "reports/field-summary.json");
  const oracleSummaryPath = corpusPath(corpusDir, "reports/oracle-summary.json");
  const cssManifestPath = corpusPath(corpusDir, "manifests/css.ndjson");

  const fieldSummary = JSON.parse(await readFile(pageSummaryPath, "utf8"));
  const oracleSummary = JSON.parse(await readFile(oracleSummaryPath, "utf8"));
  const cssRecords = await readNdjson(cssManifestPath);

  const cssByKind = cssRecords.reduce((acc, record) => {
    const key = record.kind ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const markdownLines = [
    "# Phase 5 field report",
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
    formatOracleTools(oracleSummary.tools),
    "",
    "## Worst oracle disagreements",
    formatOracleWorst(oracleSummary.toolScores),
    "",
    "## Parity checks",
    formatList(
      [
        `parseBytes vs parseStream mismatches: ${String(fieldSummary.parity.parseBytesVsParseStreamMismatches)}`
      ],
      "no parity checks"
    )
  ];

  const outputPath = resolve(process.cwd(), "docs/phase5-field-report.md");
  await writeFile(outputPath, `${markdownLines.join("\n")}\n`, "utf8");
  process.stdout.write(`field-report doc updated: ${outputPath}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-report failed: ${message}\n`);
  process.exit(1);
});
