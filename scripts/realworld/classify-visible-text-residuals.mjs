import { readFile } from "node:fs/promises";
import { parseBytes, visibleTextTokensWithProvenance } from "html-parser";

import {
  corpusPath,
  ensureCorpusDirs,
  normalizeToken,
  readNdjson,
  resolveCorpusDir,
  sha256HexString,
  tokenizeText,
  writeJson
} from "./lib.mjs";

const DECISION_SURFACE = "meaningful-content";
const TOP_BUCKET_COUNT = 5;
const MIN_TOP_BUCKET_SHARE = 0.95;
const MAX_UNCLASSIFIED_RESIDUAL_SHARE = 0.05;
const EXTRA_ORACLE_LOCALE_WORDS = new Set([
  "english",
  "deutsch",
  "espa",
  "fran",
  "portugu",
  "brasil",
  "ais",
  "us"
]);
const EXTRA_ORACLE_UI_WORDS = new Set([
  "submit",
  "toggle",
  "theme",
  "language",
  "sidebar",
  "remember",
  "filter",
  "copy",
  "read",
  "report",
  "helpful",
  "yes",
  "no",
  "avatar",
  "learn",
  "iframe",
  "view",
  "more",
  "free",
  "cloudflare"
]);

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

function fixed6(value) {
  return Number(value.toFixed(6));
}

function provenanceWords(tokens) {
  const words = [];
  for (const token of tokens) {
    if (!token || token.kind !== "text" || typeof token.value !== "string") {
      continue;
    }
    const normalized = normalizeToken(token.value);
    if (normalized.length === 0) {
      continue;
    }
    const pieces = normalized.split(" ").filter((entry) => entry.length > 0);
    for (const piece of pieces) {
      words.push({
        word: piece,
        sourceRole: typeof token.sourceRole === "string" ? token.sourceRole : "unknown",
        sourceNodeKind: typeof token.sourceNodeKind === "string" ? token.sourceNodeKind : "unknown",
        sourceNodeId: Number.isInteger(token.sourceNodeId) ? token.sourceNodeId : null
      });
    }
  }
  return words;
}

function toCountMap(values) {
  const map = new Map();
  for (const value of values) {
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return map;
}

function sourceRoleBucketId(sourceRole) {
  return `missing:${sourceRole}`;
}

function classifyExtraOracleWord(word) {
  if (/^[0-9]+$/u.test(word)) {
    return "extra:oracle:number";
  }
  if (/^[+\-_=|]{2,}$/u.test(word)) {
    return "extra:oracle:separator";
  }
  if (
    word.includes("chrome")
    || word.includes("firefox")
    || word.includes("safari")
    || word.includes("edge")
    || word.includes("ienone")
    || /^js[0-9]+$/u.test(word)
  ) {
    return "extra:oracle:compat-table";
  }
  if (EXTRA_ORACLE_LOCALE_WORDS.has(word)) {
    return "extra:oracle:locale-label";
  }
  if (EXTRA_ORACLE_UI_WORDS.has(word)) {
    return "extra:oracle:ui-label";
  }
  if (/^[a-z]+$/u.test(word)) {
    return "extra:oracle:word";
  }
  if (/^[a-z0-9+-]+$/u.test(word)) {
    return "extra:oracle:mixed-token";
  }
  return "extra:oracle:unclassified";
}

function classifyRecordResiduals(expectedWords, oracleWords) {
  const expectedCounts = toCountMap(expectedWords.map((entry) => entry.word));
  const oracleCounts = toCountMap(oracleWords);
  const expectedWordEntries = new Map();
  for (const entry of expectedWords) {
    if (!expectedWordEntries.has(entry.word)) {
      expectedWordEntries.set(entry.word, []);
    }
    expectedWordEntries.get(entry.word).push(entry);
  }

  const bucketTokenCounts = new Map();
  const extraSubclassCounts = new Map();
  let mismatchTokenCount = 0;
  let extraTokenCount = 0;

  for (const [word, expectedCount] of expectedCounts.entries()) {
    const oracleCount = oracleCounts.get(word) ?? 0;
    const missingCount = expectedCount - Math.min(expectedCount, oracleCount);
    if (missingCount <= 0) {
      continue;
    }
    const entries = expectedWordEntries.get(word) ?? [];
    for (let index = 0; index < missingCount; index += 1) {
      const source = entries[index] ?? entries[entries.length - 1] ?? {
        sourceRole: "unknown",
        sourceNodeKind: "unknown",
        sourceNodeId: null
      };
      const bucketId = sourceRoleBucketId(source.sourceRole);
      bucketTokenCounts.set(bucketId, (bucketTokenCounts.get(bucketId) ?? 0) + 1);
      mismatchTokenCount += 1;
    }
  }

  for (const [word, oracleCount] of oracleCounts.entries()) {
    const expectedCount = expectedCounts.get(word) ?? 0;
    const extraCount = oracleCount - Math.min(expectedCount, oracleCount);
    if (extraCount <= 0) {
      continue;
    }
    bucketTokenCounts.set("extra:oracle", (bucketTokenCounts.get("extra:oracle") ?? 0) + extraCount);
    const subclassId = classifyExtraOracleWord(word);
    extraSubclassCounts.set(subclassId, (extraSubclassCounts.get(subclassId) ?? 0) + extraCount);
    extraTokenCount += extraCount;
    mismatchTokenCount += extraCount;
  }

  return {
    bucketTokenCounts,
    mismatchTokenCount,
    extraSubclassCounts,
    extraTokenCount
  };
}

async function loadExpectedWordsForPage(corpusDir, pageSha256, cache) {
  if (cache.has(pageSha256)) {
    return cache.get(pageSha256);
  }
  const htmlPath = corpusPath(corpusDir, `cache/html/${pageSha256}.bin`);
  const htmlBytes = new Uint8Array(await readFile(htmlPath));
  const tree = parseBytes(htmlBytes, {
    captureSpans: false,
    trace: false
  });
  const tokens = visibleTextTokensWithProvenance(tree, {});
  const words = provenanceWords(tokens);
  cache.set(pageSha256, words);
  return words;
}

async function main() {
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const oracleRecords = await readNdjson(corpusPath(corpusDir, "reports/oracle-compare.ndjson"));
  const eligibleRecords = oracleRecords
    .filter((record) => record?.pageSurface === DECISION_SURFACE)
    .filter((record) => !record.error)
    .filter((record) => typeof record.stdoutSha256 === "string" && record.stdoutSha256.length > 0)
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
    throw new Error("no eligible meaningful-content oracle records; run npm run field:oracles first");
  }

  const expectedWordsCache = new Map();
  const bucketAggregates = new Map();
  const extraSubclassAggregates = new Map();
  const perRecord = [];
  let residualMassTotal = 0;

  for (const record of eligibleRecords) {
    const expectedWords = await loadExpectedWordsForPage(corpusDir, record.pageSha256, expectedWordsCache);
    const oracleOutputPath = corpusPath(corpusDir, `cache/oracle/${record.tool}/${record.stdoutSha256}.txt`);
    const oracleOutput = await readFile(oracleOutputPath, "utf8");
    const oracleWords = tokenizeText(normalizeOracleTextForScoring(oracleOutput));

    const { bucketTokenCounts, mismatchTokenCount, extraSubclassCounts, extraTokenCount } = classifyRecordResiduals(expectedWords, oracleWords);
    const residualMass = Math.max(0, 1 - Number(record.normalizedTokenF1 ?? 0));
    if (residualMass <= 0 || mismatchTokenCount <= 0) {
      continue;
    }
    residualMassTotal += residualMass;

    const recordBuckets = [];
    const sortedBuckets = [...bucketTokenCounts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    });
    for (const [bucketId, tokenCount] of sortedBuckets) {
      const contribution = residualMass * (tokenCount / mismatchTokenCount);
      recordBuckets.push({
        bucketId,
        tokenCount,
        contribution: fixed6(contribution)
      });
      if (!bucketAggregates.has(bucketId)) {
        bucketAggregates.set(bucketId, {
          bucketId,
          residualMass: 0,
          tokenCount: 0,
          recordCount: 0,
          examples: []
        });
      }
      const aggregate = bucketAggregates.get(bucketId);
      aggregate.residualMass += contribution;
      aggregate.tokenCount += tokenCount;
      aggregate.recordCount += 1;
      aggregate.examples.push({
        pageSha256: record.pageSha256,
        finalUrl: record.finalUrl,
        tool: record.tool,
        width: record.width,
        normalizedTokenF1: Number(record.normalizedTokenF1 ?? 0),
        residualMass: fixed6(residualMass),
        contribution: fixed6(contribution)
      });
    }

    const recordExtraSubclasses = [];
    if (extraTokenCount > 0) {
      const extraResidualMass = residualMass * (extraTokenCount / mismatchTokenCount);
      const sortedExtraSubclasses = [...extraSubclassCounts.entries()].sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return left[0].localeCompare(right[0]);
      });
      for (const [subclassId, tokenCount] of sortedExtraSubclasses) {
        const contribution = extraResidualMass * (tokenCount / extraTokenCount);
        recordExtraSubclasses.push({
          subclassId,
          tokenCount,
          contribution: fixed6(contribution)
        });

        if (!extraSubclassAggregates.has(subclassId)) {
          extraSubclassAggregates.set(subclassId, {
            subclassId,
            residualMass: 0,
            tokenCount: 0,
            recordCount: 0,
            examples: []
          });
        }
        const aggregate = extraSubclassAggregates.get(subclassId);
        aggregate.residualMass += contribution;
        aggregate.tokenCount += tokenCount;
        aggregate.recordCount += 1;
        aggregate.examples.push({
          pageSha256: record.pageSha256,
          finalUrl: record.finalUrl,
          tool: record.tool,
          width: record.width,
          normalizedTokenF1: Number(record.normalizedTokenF1 ?? 0),
          residualMass: fixed6(residualMass),
          contribution: fixed6(contribution)
        });
      }
    }

    perRecord.push({
      pageSha256: record.pageSha256,
      finalUrl: record.finalUrl,
      tool: record.tool,
      width: record.width,
      normalizedTokenF1: Number(record.normalizedTokenF1 ?? 0),
      residualMass: fixed6(residualMass),
      mismatchTokenCount,
      buckets: recordBuckets,
      extraOracleSubclasses: recordExtraSubclasses
    });
  }

  const buckets = [...bucketAggregates.values()]
    .map((entry) => ({
      bucketId: entry.bucketId,
      residualClassId: entry.bucketId.replace(/[:]/g, "-"),
      residualMass: fixed6(entry.residualMass),
      residualShare: residualMassTotal > 0 ? fixed6(entry.residualMass / residualMassTotal) : 0,
      tokenCount: entry.tokenCount,
      recordCount: entry.recordCount,
      examples: [...entry.examples]
        .sort((left, right) => {
          if (right.contribution !== left.contribution) {
            return right.contribution - left.contribution;
          }
          if (left.pageSha256 !== right.pageSha256) {
            return left.pageSha256.localeCompare(right.pageSha256);
          }
          if (left.tool !== right.tool) {
            return left.tool.localeCompare(right.tool);
          }
          return left.width - right.width;
        })
        .slice(0, 5)
    }))
    .sort((left, right) => {
      if (right.residualMass !== left.residualMass) {
        return right.residualMass - left.residualMass;
      }
      return left.bucketId.localeCompare(right.bucketId);
    });

  const topBuckets = buckets.slice(0, TOP_BUCKET_COUNT);
  const topBucketsResidualShare = fixed6(topBuckets.reduce((sum, entry) => sum + entry.residualShare, 0));
  const taxonomyCoveragePass = topBucketsResidualShare >= MIN_TOP_BUCKET_SHARE;
  const extraOracleSubclasses = [...extraSubclassAggregates.values()]
    .map((entry) => ({
      subclassId: entry.subclassId,
      residualMass: fixed6(entry.residualMass),
      residualShare: residualMassTotal > 0 ? fixed6(entry.residualMass / residualMassTotal) : 0,
      tokenCount: entry.tokenCount,
      recordCount: entry.recordCount,
      examples: [...entry.examples]
        .sort((left, right) => {
          if (right.contribution !== left.contribution) {
            return right.contribution - left.contribution;
          }
          if (left.pageSha256 !== right.pageSha256) {
            return left.pageSha256.localeCompare(right.pageSha256);
          }
          if (left.tool !== right.tool) {
            return left.tool.localeCompare(right.tool);
          }
          return left.width - right.width;
        })
        .slice(0, 5)
    }))
    .sort((left, right) => {
      if (right.residualMass !== left.residualMass) {
        return right.residualMass - left.residualMass;
      }
      return left.subclassId.localeCompare(right.subclassId);
    });
  const unclassifiedSubclass = extraOracleSubclasses.find((entry) => entry.subclassId === "extra:oracle:unclassified") ?? null;
  const unclassifiedResidualShare = unclassifiedSubclass ? unclassifiedSubclass.residualShare : 0;
  const subclassCoveragePass = unclassifiedResidualShare <= MAX_UNCLASSIFIED_RESIDUAL_SHARE;

  const report = {
    suite: "visible-text-residual-taxonomy",
    runId: sha256HexString(
      JSON.stringify({
        script: "classify-visible-text-residuals-v1",
        decisionSurface: DECISION_SURFACE,
        records: eligibleRecords.map((entry) => ({
          pageSha256: entry.pageSha256,
          tool: entry.tool,
          width: entry.width,
          stdoutSha256: entry.stdoutSha256
        }))
      })
    ),
    generatedAtIso: new Date().toISOString(),
    decisionSurface: DECISION_SURFACE,
    thresholds: {
      topBucketCount: TOP_BUCKET_COUNT,
      minTopBucketShare: MIN_TOP_BUCKET_SHARE,
      maxUnclassifiedResidualShare: MAX_UNCLASSIFIED_RESIDUAL_SHARE
    },
    recordsCompared: perRecord.length,
    residualMassTotal: fixed6(residualMassTotal),
    unclassifiedResidualShare,
    taxonomyCoverage: {
      topBucketCount: TOP_BUCKET_COUNT,
      topBucketsResidualShare,
      pass: taxonomyCoveragePass
    },
    classificationCoverage: {
      unclassifiedResidualShare,
      maxUnclassifiedResidualShare: MAX_UNCLASSIFIED_RESIDUAL_SHARE,
      pass: subclassCoveragePass
    },
    buckets,
    topBuckets,
    extraOracleSubclasses,
    records: perRecord
  };

  await writeJson(corpusPath(corpusDir, "reports/visible-text-residual-taxonomy.json"), report);
  if (!taxonomyCoveragePass || !subclassCoveragePass) {
    const failures = [];
    if (!taxonomyCoveragePass) {
      failures.push(`top${String(TOP_BUCKET_COUNT)} share=${String(topBucketsResidualShare)}`);
    }
    if (!subclassCoveragePass) {
      failures.push(`unclassified share=${String(unclassifiedResidualShare)}`);
    }
    throw new Error(`residual taxonomy coverage failed: ${failures.join(", ")}`);
  }
  process.stdout.write(
    `visible-text-residual-taxonomy ok: records=${String(perRecord.length)} buckets=${String(buckets.length)} topShare=${String(topBucketsResidualShare)} unclassifiedShare=${String(unclassifiedResidualShare)}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`visible-text-residual-taxonomy failed: ${message}\n`);
  process.exit(1);
});
