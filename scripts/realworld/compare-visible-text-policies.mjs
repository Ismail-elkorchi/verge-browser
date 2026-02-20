import { readFile } from "node:fs/promises";

import { parseBytes, visibleTextTokens } from "html-parser";

import {
  corpusPath,
  ensureCorpusDirs,
  readNdjson,
  resolveCorpusDir,
  sha256HexString,
  tokenF1,
  tokenizeText,
  writeJson,
  writeNdjson
} from "./lib.mjs";

const NORMALIZATION_VERSION = "v1";
const POLICY_BASELINE = Object.freeze({
  id: "baseline",
  description: "visibleText default options",
  options: {}
});
const POLICY_ACCESSIBLE_FALLBACK = Object.freeze({
  id: "accessibleNameFallback",
  description: "visibleText with includeAccessibleNameFallback=true",
  options: {
    includeAccessibleNameFallback: true
  }
});

function normalizeOracleTextForScoring(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\s*link:\s+.*$/gim, "")
    .replace(/^\s*iframe:\s+.*$/gim, "")
    .replace(/\[(?:img|image)\]/gim, " ")
    .replace(/\((?:button|submit|image)\)/gim, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function policyTokensFromTree(tree, options) {
  const mergedText = visibleTextTokens(tree, options)
    .map((token) => (token.kind === "text" ? token.value : " "))
    .join(" ");
  return tokenizeText(mergedText);
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function fixed6(value) {
  return Number(value.toFixed(6));
}

function summarizeGroup(records) {
  const baselineScores = records.map((record) => record.baseline.normalizedTokenF1);
  const candidateScores = records.map((record) => record.candidate.normalizedTokenF1);
  const deltas = records.map((record) => record.delta.normalizedTokenF1);
  const better = deltas.filter((delta) => delta > 0).length;
  const worse = deltas.filter((delta) => delta < 0).length;
  const same = records.length - better - worse;

  return {
    compared: records.length,
    meanBaselineNormalizedTokenF1: fixed6(mean(baselineScores)),
    meanCandidateNormalizedTokenF1: fixed6(mean(candidateScores)),
    meanDeltaNormalizedTokenF1: fixed6(mean(deltas)),
    betterCount: better,
    worseCount: worse,
    sameCount: same,
    bestImprovements: [...records]
      .sort((left, right) => right.delta.normalizedTokenF1 - left.delta.normalizedTokenF1)
      .slice(0, 5)
      .map((record) => ({
        pageSha256: record.pageSha256,
        finalUrl: record.finalUrl,
        tool: record.tool,
        width: record.width,
        baselineNormalizedTokenF1: record.baseline.normalizedTokenF1,
        candidateNormalizedTokenF1: record.candidate.normalizedTokenF1,
        deltaNormalizedTokenF1: record.delta.normalizedTokenF1
      })),
    worstRegressions: [...records]
      .sort((left, right) => left.delta.normalizedTokenF1 - right.delta.normalizedTokenF1)
      .slice(0, 5)
      .map((record) => ({
        pageSha256: record.pageSha256,
        finalUrl: record.finalUrl,
        tool: record.tool,
        width: record.width,
        baselineNormalizedTokenF1: record.baseline.normalizedTokenF1,
        candidateNormalizedTokenF1: record.candidate.normalizedTokenF1,
        deltaNormalizedTokenF1: record.delta.normalizedTokenF1
      })),
    worstResiduals: [...records]
      .sort((left, right) => left.candidate.normalizedTokenF1 - right.candidate.normalizedTokenF1)
      .slice(0, 5)
      .map((record) => ({
        pageSha256: record.pageSha256,
        finalUrl: record.finalUrl,
        tool: record.tool,
        width: record.width,
        candidateNormalizedTokenF1: record.candidate.normalizedTokenF1
      }))
  };
}

async function main() {
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const pagesManifest = await readNdjson(corpusPath(corpusDir, "manifests/pages.ndjson"));
  const oracleCompareRecords = await readNdjson(corpusPath(corpusDir, "reports/oracle-compare.ndjson"));
  const eligibleRecords = oracleCompareRecords
    .filter((record) => !record.error && typeof record.stdoutSha256 === "string" && record.stdoutSha256.length > 0)
    .sort((left, right) => {
      if (left.pageSha256 !== right.pageSha256) {
        return left.pageSha256.localeCompare(right.pageSha256);
      }
      if (left.tool !== right.tool) {
        return left.tool.localeCompare(right.tool);
      }
      return left.width - right.width;
    });

  if (eligibleRecords.length === 0) {
    throw new Error("oracle comparison data missing; run npm run field:oracles first");
  }

  const pageBySha = new Map();
  for (const page of pagesManifest) {
    if (page && typeof page.sha256 === "string" && page.sha256.length > 0 && !pageBySha.has(page.sha256)) {
      pageBySha.set(page.sha256, page);
    }
  }

  const pageTokensBySha = new Map();
  for (const pageSha of new Set(eligibleRecords.map((record) => record.pageSha256))) {
    const page = pageBySha.get(pageSha);
    if (!page) {
      continue;
    }
    const htmlBytes = new Uint8Array(await readFile(corpusPath(corpusDir, `cache/html/${pageSha}.bin`)));
    const tree = parseBytes(htmlBytes, {
      captureSpans: false,
      trace: false
    });
    pageTokensBySha.set(pageSha, {
      baselineTokens: policyTokensFromTree(tree, POLICY_BASELINE.options),
      candidateTokens: policyTokensFromTree(tree, POLICY_ACCESSIBLE_FALLBACK.options)
    });
  }

  const detailRecords = [];
  for (const record of eligibleRecords) {
    const pageTokens = pageTokensBySha.get(record.pageSha256);
    if (!pageTokens) {
      continue;
    }

    const oracleOutputPath = corpusPath(corpusDir, `cache/oracle/${record.tool}/${record.stdoutSha256}.txt`);
    const oracleOutput = await readFile(oracleOutputPath, "utf8");
    const oracleTokensRaw = tokenizeText(oracleOutput);
    const oracleTokensNormalized = tokenizeText(normalizeOracleTextForScoring(oracleOutput));

    const baselineRaw = fixed6(tokenF1(pageTokens.baselineTokens, oracleTokensRaw));
    const baselineNormalized = fixed6(tokenF1(pageTokens.baselineTokens, oracleTokensNormalized));
    const candidateRaw = fixed6(tokenF1(pageTokens.candidateTokens, oracleTokensRaw));
    const candidateNormalized = fixed6(tokenF1(pageTokens.candidateTokens, oracleTokensNormalized));

    detailRecords.push({
      pageSha256: record.pageSha256,
      finalUrl: record.finalUrl,
      tool: record.tool,
      width: record.width,
      pageSurface: record.pageSurface ?? "unknown",
      pageSurfaceReasons: record.pageSurfaceReasons ?? [],
      baseline: {
        rawTokenF1: baselineRaw,
        normalizedTokenF1: baselineNormalized
      },
      candidate: {
        rawTokenF1: candidateRaw,
        normalizedTokenF1: candidateNormalized
      },
      delta: {
        rawTokenF1: fixed6(candidateRaw - baselineRaw),
        normalizedTokenF1: fixed6(candidateNormalized - baselineNormalized)
      }
    });
  }

  const runId = sha256HexString(
    JSON.stringify({
      script: "compare-visible-text-policies-v1",
      oracleRunIds: [...new Set(eligibleRecords.map((record) => record.runId))].sort(),
      compared: detailRecords.map((record) => ({
        sha256: record.pageSha256,
        tool: record.tool,
        width: record.width
      }))
    })
  );

  const groupedByTool = new Map();
  const groupedBySurface = new Map();
  for (const record of detailRecords) {
    if (!groupedByTool.has(record.tool)) {
      groupedByTool.set(record.tool, []);
    }
    groupedByTool.get(record.tool).push(record);

    if (!groupedBySurface.has(record.pageSurface)) {
      groupedBySurface.set(record.pageSurface, []);
    }
    groupedBySurface.get(record.pageSurface).push(record);
  }

  const summary = {
    suite: "visible-text-policy-compare",
    runId,
    generatedAtIso: new Date().toISOString(),
    policies: {
      baseline: POLICY_BASELINE,
      candidate: POLICY_ACCESSIBLE_FALLBACK
    },
    normalizationVersion: NORMALIZATION_VERSION,
    comparedRecords: detailRecords.length,
    comparedPages: new Set(detailRecords.map((record) => record.pageSha256)).size,
    overall: summarizeGroup(detailRecords),
    byTool: [...groupedByTool.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([tool, records]) => ({
        tool,
        ...summarizeGroup(records)
      })),
    bySurface: [...groupedBySurface.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([surface, records]) => ({
        surface,
        ...summarizeGroup(records)
      }))
  };

  const ndjsonRecords = detailRecords.map((record) => ({
    runId,
    ...record
  }));
  await writeNdjson(corpusPath(corpusDir, "reports/visible-text-policy-compare.ndjson"), ndjsonRecords);
  await writeJson(corpusPath(corpusDir, "reports/visible-text-policy-compare.json"), summary);
  process.stdout.write(`visible-text-policy-compare ok: records=${String(detailRecords.length)} runId=${runId}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`visible-text-policy-compare failed: ${message}\n`);
  process.exit(1);
});
