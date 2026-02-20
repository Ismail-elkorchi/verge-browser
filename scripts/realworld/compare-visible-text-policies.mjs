import { readFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

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

const NORMALIZATION_VERSION = "v2";
const UTF8_ENCODER = new TextEncoder();

const POLICIES = Object.freeze([
  {
    id: "baseline",
    description: "visibleText default options",
    options: Object.freeze({}),
    transform: (html) => html
  },
  {
    id: "fallback-all",
    description: "includeAccessibleNameFallback with aria-label/title on a, button, input",
    options: Object.freeze({
      includeAccessibleNameFallback: true
    }),
    transform: (html) => html
  },
  {
    id: "fallback-aria-only",
    description: "fallback enabled with title attributes stripped from all elements",
    options: Object.freeze({
      includeAccessibleNameFallback: true
    }),
    transform: (html) => transformHtml(html, {
      stripTitleAll: true,
      stripAriaLabelFromTags: []
    })
  },
  {
    id: "fallback-controls-aria-only",
    description: "fallback enabled with title stripped globally and aria-label stripped on anchors",
    options: Object.freeze({
      includeAccessibleNameFallback: true
    }),
    transform: (html) => transformHtml(html, {
      stripTitleAll: true,
      stripAriaLabelFromTags: ["a"]
    })
  },
  {
    id: "fallback-input-only-aria",
    description: "fallback enabled with title stripped globally and aria-label stripped on anchors and buttons",
    options: Object.freeze({
      includeAccessibleNameFallback: true
    }),
    transform: (html) => transformHtml(html, {
      stripTitleAll: true,
      stripAriaLabelFromTags: ["a", "button"]
    })
  }
]);

const BASELINE_POLICY_ID = "baseline";

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

function normalizeTagName(tagName) {
  return tagName.toLowerCase();
}

function removeAttributesFromTagMarkup(tagMarkup, attributeNames) {
  let next = tagMarkup;
  for (const attributeName of attributeNames) {
    const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const attributePattern = new RegExp(
      `\\s${escapedName}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>` + "`" + `]+))?`,
      "gi"
    );
    next = next.replace(attributePattern, "");
  }
  return next;
}

function transformHtml(html, transformPolicy) {
  const stripAriaLabelFromTags = new Set(
    (transformPolicy.stripAriaLabelFromTags ?? []).map((tagName) => normalizeTagName(tagName))
  );
  return html.replace(/<[^>]+>/g, (tagMarkup) => {
    if (tagMarkup.startsWith("</") || tagMarkup.startsWith("<!") || tagMarkup.startsWith("<?")) {
      return tagMarkup;
    }

    const tagNameMatch = /^<\s*([A-Za-z0-9:-]+)/.exec(tagMarkup);
    if (!tagNameMatch) {
      return tagMarkup;
    }

    const tagName = normalizeTagName(tagNameMatch[1] ?? "");
    const attributesToStrip = [];
    if (transformPolicy.stripTitleAll) {
      attributesToStrip.push("title");
    }
    if (stripAriaLabelFromTags.has(tagName)) {
      attributesToStrip.push("aria-label");
    }
    if (attributesToStrip.length === 0) {
      return tagMarkup;
    }

    return removeAttributesFromTagMarkup(tagMarkup, attributesToStrip);
  });
}

function policyTokensFromHtml(htmlText, policy) {
  const transformedHtml = policy.transform(htmlText);
  const tree = parseBytes(UTF8_ENCODER.encode(transformedHtml), {
    captureSpans: false,
    trace: false
  });
  const mergedText = visibleTextTokens(tree, policy.options)
    .map((token) => (token.kind === "text" ? token.value : " "))
    .join(" ");
  return tokenizeText(mergedText);
}

function fixed6(value) {
  return Number(value.toFixed(6));
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizePolicy(records, policyId) {
  const normalizedValues = records.map((record) => record.scores[policyId].normalizedTokenF1);
  const rawValues = records.map((record) => record.scores[policyId].rawTokenF1);
  const deltaValues = policyId === BASELINE_POLICY_ID
    ? []
    : records.map((record) => record.deltasFromBaseline[policyId].normalizedTokenF1);

  const betterCount = policyId === BASELINE_POLICY_ID
    ? 0
    : deltaValues.filter((value) => value > 0).length;
  const worseCount = policyId === BASELINE_POLICY_ID
    ? 0
    : deltaValues.filter((value) => value < 0).length;
  const sameCount = policyId === BASELINE_POLICY_ID
    ? records.length
    : records.length - betterCount - worseCount;

  return {
    policyId,
    compared: records.length,
    meanRawTokenF1: fixed6(mean(rawValues)),
    meanNormalizedTokenF1: fixed6(mean(normalizedValues)),
    meanDeltaNormalizedTokenF1: policyId === BASELINE_POLICY_ID ? 0 : fixed6(mean(deltaValues)),
    betterCount,
    worseCount,
    sameCount,
    worstResiduals: [...records]
      .sort((left, right) => left.scores[policyId].normalizedTokenF1 - right.scores[policyId].normalizedTokenF1)
      .slice(0, 10)
      .map((record) => ({
        pageSha256: record.pageSha256,
        finalUrl: record.finalUrl,
        tool: record.tool,
        width: record.width,
        normalizedTokenF1: record.scores[policyId].normalizedTokenF1
      })),
    bestImprovements: policyId === BASELINE_POLICY_ID
      ? []
      : [...records]
        .sort((left, right) => right.deltasFromBaseline[policyId].normalizedTokenF1 - left.deltasFromBaseline[policyId].normalizedTokenF1)
        .slice(0, 10)
        .map((record) => ({
          pageSha256: record.pageSha256,
          finalUrl: record.finalUrl,
          tool: record.tool,
          width: record.width,
          deltaNormalizedTokenF1: record.deltasFromBaseline[policyId].normalizedTokenF1
        })),
    worstRegressions: policyId === BASELINE_POLICY_ID
      ? []
      : [...records]
        .sort((left, right) => left.deltasFromBaseline[policyId].normalizedTokenF1 - right.deltasFromBaseline[policyId].normalizedTokenF1)
        .slice(0, 10)
        .map((record) => ({
          pageSha256: record.pageSha256,
          finalUrl: record.finalUrl,
          tool: record.tool,
          width: record.width,
          deltaNormalizedTokenF1: record.deltasFromBaseline[policyId].normalizedTokenF1
        }))
  };
}

function summarizePolicies(records, policies) {
  return policies
    .map((policy) => summarizePolicy(records, policy.id))
    .sort((left, right) => {
      if (right.meanNormalizedTokenF1 !== left.meanNormalizedTokenF1) {
        return right.meanNormalizedTokenF1 - left.meanNormalizedTokenF1;
      }
      return left.policyId.localeCompare(right.policyId);
    });
}

function selectRecommendedCandidate(policies, summaryByPolicyId) {
  const candidatePolicies = policies.filter((policy) => policy.id !== BASELINE_POLICY_ID);
  const sorted = [...candidatePolicies].sort((left, right) => {
    const leftSummary = summaryByPolicyId.get(left.id);
    const rightSummary = summaryByPolicyId.get(right.id);
    if (!leftSummary || !rightSummary) {
      return 0;
    }
    if (rightSummary.meanDeltaNormalizedTokenF1 !== leftSummary.meanDeltaNormalizedTokenF1) {
      return rightSummary.meanDeltaNormalizedTokenF1 - leftSummary.meanDeltaNormalizedTokenF1;
    }
    if (rightSummary.meanNormalizedTokenF1 !== leftSummary.meanNormalizedTokenF1) {
      return rightSummary.meanNormalizedTokenF1 - leftSummary.meanNormalizedTokenF1;
    }
    if (leftSummary.worseCount !== rightSummary.worseCount) {
      return leftSummary.worseCount - rightSummary.worseCount;
    }
    return left.id.localeCompare(right.id);
  });
  return sorted[0] ?? null;
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

  const policyTokensByPageSha = new Map();
  for (const pageSha of new Set(eligibleRecords.map((record) => record.pageSha256))) {
    const page = pageBySha.get(pageSha);
    if (!page) {
      continue;
    }
    const htmlBytes = new Uint8Array(await readFile(corpusPath(corpusDir, `cache/html/${pageSha}.bin`)));
    const htmlText = new TextDecoder().decode(htmlBytes);
    const tokensByPolicy = {};
    for (const policy of POLICIES) {
      tokensByPolicy[policy.id] = policyTokensFromHtml(htmlText, {
        ...policy,
        transform: policy.transform
      });
    }
    policyTokensByPageSha.set(pageSha, tokensByPolicy);
  }

  const baseRecords = [];
  for (const record of eligibleRecords) {
    const policyTokens = policyTokensByPageSha.get(record.pageSha256);
    if (!policyTokens) {
      continue;
    }

    const oracleOutputPath = corpusPath(corpusDir, `cache/oracle/${record.tool}/${record.stdoutSha256}.txt`);
    const oracleOutput = await readFile(oracleOutputPath, "utf8");
    const oracleTokensRaw = tokenizeText(oracleOutput);
    const oracleTokensNormalized = tokenizeText(normalizeOracleTextForScoring(oracleOutput));

    const scores = {};
    for (const policy of POLICIES) {
      const tokensForPolicy = policyTokens[policy.id];
      scores[policy.id] = {
        rawTokenF1: fixed6(tokenF1(tokensForPolicy, oracleTokensRaw)),
        normalizedTokenF1: fixed6(tokenF1(tokensForPolicy, oracleTokensNormalized))
      };
    }
    const baselineScore = scores[BASELINE_POLICY_ID];
    const deltasFromBaseline = {};
    for (const policy of POLICIES) {
      if (policy.id === BASELINE_POLICY_ID) {
        continue;
      }
      deltasFromBaseline[policy.id] = {
        rawTokenF1: fixed6(scores[policy.id].rawTokenF1 - baselineScore.rawTokenF1),
        normalizedTokenF1: fixed6(scores[policy.id].normalizedTokenF1 - baselineScore.normalizedTokenF1)
      };
    }

    baseRecords.push({
      pageSha256: record.pageSha256,
      finalUrl: record.finalUrl,
      tool: record.tool,
      width: record.width,
      pageSurface: record.pageSurface ?? "unknown",
      pageSurfaceReasons: record.pageSurfaceReasons ?? [],
      scores,
      deltasFromBaseline
    });
  }

  const runId = sha256HexString(
    JSON.stringify({
      script: "compare-visible-text-policies-v2",
      oracleRunIds: [...new Set(eligibleRecords.map((record) => record.runId))].sort(),
      policies: POLICIES.map((policy) => policy.id),
      compared: baseRecords.map((record) => ({
        sha256: record.pageSha256,
        tool: record.tool,
        width: record.width
      }))
    })
  );

  const policySummaryList = summarizePolicies(baseRecords, POLICIES);
  const policySummaryById = new Map(policySummaryList.map((item) => [item.policyId, item]));
  const recommendedCandidate = selectRecommendedCandidate(POLICIES, policySummaryById);
  if (!recommendedCandidate) {
    throw new Error("candidate policy selection failed");
  }

  const detailRecords = baseRecords.map((record) => ({
    runId,
    pageSha256: record.pageSha256,
    finalUrl: record.finalUrl,
    tool: record.tool,
    width: record.width,
    pageSurface: record.pageSurface,
    pageSurfaceReasons: record.pageSurfaceReasons,
    baseline: record.scores[BASELINE_POLICY_ID],
    candidate: record.scores[recommendedCandidate.id],
    delta: record.deltasFromBaseline[recommendedCandidate.id],
    scores: record.scores,
    deltasFromBaseline: record.deltasFromBaseline
  }));

  const groupedBySurface = new Map();
  for (const record of baseRecords) {
    if (!groupedBySurface.has(record.pageSurface)) {
      groupedBySurface.set(record.pageSurface, []);
    }
    groupedBySurface.get(record.pageSurface).push(record);
  }

  const summary = {
    suite: "visible-text-policy-compare",
    runId,
    generatedAtIso: new Date().toISOString(),
    normalizationVersion: NORMALIZATION_VERSION,
    baselinePolicyId: BASELINE_POLICY_ID,
    recommendedCandidatePolicyId: recommendedCandidate.id,
    recommendedCandidateReason: "Highest mean delta vs baseline, tie-broken by mean score then lower worseCount",
    policies: POLICIES.map((policy) => ({
      id: policy.id,
      description: policy.description,
      options: policy.options
    })),
    comparedRecords: detailRecords.length,
    comparedPages: new Set(detailRecords.map((record) => record.pageSha256)).size,
    overall: {
      baseline: policySummaryById.get(BASELINE_POLICY_ID),
      candidate: policySummaryById.get(recommendedCandidate.id)
    },
    byPolicy: policySummaryList,
    bySurface: [...groupedBySurface.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([surface, records]) => ({
        surface,
        byPolicy: summarizePolicies(records, POLICIES)
      }))
  };

  await writeNdjson(corpusPath(corpusDir, "reports/visible-text-policy-compare.ndjson"), detailRecords);
  await writeJson(corpusPath(corpusDir, "reports/visible-text-policy-compare.json"), summary);
  process.stdout.write(
    `visible-text-policy-compare ok: records=${String(detailRecords.length)} candidate=${recommendedCandidate.id} runId=${runId}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`visible-text-policy-compare failed: ${message}\n`);
  process.exit(1);
});
