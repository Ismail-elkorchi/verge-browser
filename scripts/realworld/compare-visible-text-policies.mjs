import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder, TextEncoder } from "node:util";
import { pathToFileURL } from "node:url";

import { findAllByAttr, findAllByTagName, parseBytes, textContent, visibleTextTokens, visibleTextTokensWithProvenance } from "html-parser";

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
const DECISION_SURFACE = "meaningful-content";
const CHALLENGE_SURFACE = "challenge-shell";
const MIN_DECISION_SURFACE_DELTA = 0;
const MIN_CHALLENGE_SURFACE_DELTA = -0.002;
const MAX_RENDERED_STYLE_RULES = 512;
const RENDERED_STYLE_POLICY_ID = "rendered-style-v1";
const STYLE_DECLARATION_HIDE_VALUES = new Set(["none", "hidden", "collapse"]);

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
  },
  {
    id: RENDERED_STYLE_POLICY_ID,
    description: "style-signal filtered rendered-visible approximation",
    options: Object.freeze({}),
    mode: "rendered-style-v1",
    transform: (html) => html
  }
]);

const BASELINE_POLICY_ID = "baseline";

async function loadCssParserModule() {
  const candidates = [];
  const overridePath = process.env.VERGE_CSS_PARSER_MODULE_PATH;
  if (overridePath && overridePath.trim().length > 0) {
    candidates.push(resolve(process.cwd(), overridePath));
  }
  candidates.push(resolve(process.cwd(), "../css-parser/dist/mod.js"));

  let lastError = null;
  for (const candidatePath of candidates) {
    try {
      const moduleUrl = pathToFileURL(candidatePath).href;
      return await import(moduleUrl);
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `css-parser module unavailable; checked ${candidates.join(", ")}; lastError=${detail}`
  );
}

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

function normalizeDeclarationValue(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function declarationHidesSubtree(declaration) {
  const property = typeof declaration.property === "string"
    ? declaration.property.toLowerCase().trim()
    : "";
  const value = typeof declaration.value === "string"
    ? normalizeDeclarationValue(declaration.value)
    : "";

  if (property === "display") {
    return STYLE_DECLARATION_HIDE_VALUES.has(value);
  }
  if (property === "visibility") {
    return STYLE_DECLARATION_HIDE_VALUES.has(value);
  }
  if (property === "content-visibility") {
    return value === "hidden";
  }
  return false;
}

function collectRenderedStyleHiddenNodeIds(tree, cssParser) {
  const hiddenNodeIds = new Set();
  let scannedRuleCount = 0;
  let truncated = false;

  for (const element of findAllByAttr(tree, "style")) {
    const styleValue = element.attributes.find((attribute) => attribute.name.toLowerCase() === "style")?.value ?? "";
    if (styleValue.trim().length === 0) {
      continue;
    }
    const declarations = cssParser.extractInlineStyleSignals(styleValue);
    if (declarations.some((entry) => declarationHidesSubtree(entry))) {
      hiddenNodeIds.add(element.id);
    }
  }

  const styleBlocks = [];
  for (const styleNode of findAllByTagName(tree, "style")) {
    const cssText = textContent(styleNode).trim();
    if (cssText.length > 0) {
      styleBlocks.push(cssText);
    }
  }

  for (const cssText of styleBlocks) {
    const signals = cssParser.extractStyleRuleSignals(cssText, {
      includeUnsupportedSelectors: false
    });
    for (const signal of signals) {
      if (scannedRuleCount >= MAX_RENDERED_STYLE_RULES) {
        truncated = true;
        break;
      }
      scannedRuleCount += 1;
      if (!signal.selectorSupported || !signal.declarations.some((entry) => declarationHidesSubtree(entry))) {
        continue;
      }
      const matched = cssParser.querySelectorAll(signal.selector, tree);
      for (const node of matched) {
        if (node && typeof node === "object" && typeof node.id === "number") {
          hiddenNodeIds.add(node.id);
        }
      }
    }
    if (truncated) {
      break;
    }
  }

  return {
    hiddenNodeIds,
    styleBlockCount: styleBlocks.length,
    scannedRuleCount,
    truncated
  };
}

function collectHiddenSubtreeNodeIds(tree, hiddenRootNodeIds) {
  const hiddenSubtreeNodeIds = new Set();
  const stack = [
    {
      node: tree,
      hiddenAncestor: false
    }
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !current.node || typeof current.node !== "object") {
      continue;
    }

    const nodeId = typeof current.node.id === "number" ? current.node.id : null;
    const isHidden = current.hiddenAncestor || (nodeId !== null && hiddenRootNodeIds.has(nodeId));
    if (isHidden && nodeId !== null) {
      hiddenSubtreeNodeIds.add(nodeId);
    }

    const children = Array.isArray(current.node.children) ? current.node.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!child || typeof child !== "object") {
        continue;
      }
      stack.push({
        node: child,
        hiddenAncestor: isHidden
      });
    }
  }

  return hiddenSubtreeNodeIds;
}

function policyTokensFromHtml(htmlText, policy, cssParser) {
  const transformedHtml = policy.transform(htmlText);
  const tree = parseBytes(UTF8_ENCODER.encode(transformedHtml), {
    captureSpans: false,
    trace: false
  });

  if (policy.mode === "rendered-style-v1") {
    const hidden = collectRenderedStyleHiddenNodeIds(tree, cssParser);
    const hiddenSubtreeNodeIds = collectHiddenSubtreeNodeIds(tree, hidden.hiddenNodeIds);
    const mergedText = visibleTextTokensWithProvenance(tree, policy.options)
      .filter((token) => token.sourceNodeId === null || !hiddenSubtreeNodeIds.has(token.sourceNodeId))
      .map((token) => (token.kind === "text" ? token.value : " "))
      .join(" ");
    return {
      tokens: tokenizeText(mergedText),
      diagnostics: {
        hiddenRootNodeCount: hidden.hiddenNodeIds.size,
        hiddenSubtreeNodeCount: hiddenSubtreeNodeIds.size,
        styleBlockCount: hidden.styleBlockCount,
        scannedRuleCount: hidden.scannedRuleCount,
        scannedRuleTruncated: hidden.truncated
      }
    };
  }

  const mergedText = visibleTextTokens(tree, policy.options)
    .map((token) => (token.kind === "text" ? token.value : " "))
    .join(" ");
  return {
    tokens: tokenizeText(mergedText),
    diagnostics: null
  };
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

function parseSurfaceSummaryList(entries) {
  return new Map(entries.map((entry) => [entry.policyId, entry]));
}

async function main() {
  const cssParser = await loadCssParserModule();
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
      }, cssParser);
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
      const tokensForPolicy = policyTokens[policy.id]?.tokens ?? [];
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
      renderedStyleDiagnostics: policyTokens[RENDERED_STYLE_POLICY_ID]?.diagnostics ?? null,
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

  const groupedBySurface = new Map();
  for (const record of baseRecords) {
    if (!groupedBySurface.has(record.pageSurface)) {
      groupedBySurface.set(record.pageSurface, []);
    }
    groupedBySurface.get(record.pageSurface).push(record);
  }

  const policySummaryList = summarizePolicies(baseRecords, POLICIES);
  const policySummaryById = parseSurfaceSummaryList(policySummaryList);
  const bySurfaceSummary = [...groupedBySurface.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([surface, records]) => ({
      surface,
      byPolicy: summarizePolicies(records, POLICIES)
    }));

  const decisionSurfaceRecords = groupedBySurface.get(DECISION_SURFACE) ?? [];
  const decisionSummaryList = summarizePolicies(
    decisionSurfaceRecords.length > 0 ? decisionSurfaceRecords : baseRecords,
    POLICIES
  );
  const decisionSummaryById = parseSurfaceSummaryList(decisionSummaryList);
  const primaryCandidate = selectRecommendedCandidate(POLICIES, decisionSummaryById);
  if (!primaryCandidate) {
    throw new Error("candidate policy selection failed");
  }
  const primaryCandidateSummary = decisionSummaryById.get(primaryCandidate.id);
  if (!primaryCandidateSummary) {
    throw new Error(`candidate summary missing for ${primaryCandidate.id}`);
  }

  const promotedPolicyId = primaryCandidateSummary.meanDeltaNormalizedTokenF1 > MIN_DECISION_SURFACE_DELTA
    ? primaryCandidate.id
    : BASELINE_POLICY_ID;
  const promotedPolicySummaryDecisionSurface = decisionSummaryById.get(promotedPolicyId);
  if (!promotedPolicySummaryDecisionSurface) {
    throw new Error(`decision surface summary missing for ${promotedPolicyId}`);
  }

  const challengeSurfaceSummary = bySurfaceSummary.find((entry) => entry.surface === CHALLENGE_SURFACE);
  const challengeSummaryByPolicyId = challengeSurfaceSummary
    ? parseSurfaceSummaryList(challengeSurfaceSummary.byPolicy)
    : new Map();
  const promotedPolicyChallengeSurfaceSummary = challengeSummaryByPolicyId.get(promotedPolicyId) ?? null;

  const surfaceGates = {
    decisionSurfaceCoverage: {
      pass: decisionSurfaceRecords.length > 0,
      surface: DECISION_SURFACE,
      comparedRecords: decisionSurfaceRecords.length
    },
    decisionSurfaceNonRegression: {
      pass: promotedPolicySummaryDecisionSurface.meanDeltaNormalizedTokenF1 >= MIN_DECISION_SURFACE_DELTA,
      surface: DECISION_SURFACE,
      minDelta: MIN_DECISION_SURFACE_DELTA,
      observedDelta: promotedPolicySummaryDecisionSurface.meanDeltaNormalizedTokenF1,
      promotedPolicyId
    },
    challengeSurfaceRegressionFloor: {
      pass: promotedPolicyChallengeSurfaceSummary === null
        || promotedPolicyChallengeSurfaceSummary.meanDeltaNormalizedTokenF1 >= MIN_CHALLENGE_SURFACE_DELTA,
      surface: CHALLENGE_SURFACE,
      minDelta: MIN_CHALLENGE_SURFACE_DELTA,
      observedDelta: promotedPolicyChallengeSurfaceSummary?.meanDeltaNormalizedTokenF1 ?? null,
      promotedPolicyId
    }
  };
  const allSurfaceGatesPass = Object.values(surfaceGates).every((gate) => gate.pass);

  const detailRecords = baseRecords.map((record) => {
    const delta = promotedPolicyId === BASELINE_POLICY_ID
      ? { rawTokenF1: 0, normalizedTokenF1: 0 }
      : record.deltasFromBaseline[promotedPolicyId] ?? { rawTokenF1: 0, normalizedTokenF1: 0 };
    return {
      runId,
      pageSha256: record.pageSha256,
      finalUrl: record.finalUrl,
      tool: record.tool,
      width: record.width,
      pageSurface: record.pageSurface,
      pageSurfaceReasons: record.pageSurfaceReasons,
      renderedStyleDiagnostics: record.renderedStyleDiagnostics,
      baseline: record.scores[BASELINE_POLICY_ID],
      candidate: record.scores[promotedPolicyId],
      delta,
      scores: record.scores,
      deltasFromBaseline: record.deltasFromBaseline
    };
  });

  const renderedStyleDiagnostics = (() => {
    const candidates = detailRecords
      .map((record) => record.renderedStyleDiagnostics)
      .filter((entry) => entry !== null);
    if (candidates.length === 0) {
      return null;
    }
    return {
      records: candidates.length,
      meanHiddenRootNodeCount: fixed6(mean(candidates.map((entry) => entry.hiddenRootNodeCount))),
      meanHiddenSubtreeNodeCount: fixed6(mean(candidates.map((entry) => entry.hiddenSubtreeNodeCount))),
      meanStyleBlockCount: fixed6(mean(candidates.map((entry) => entry.styleBlockCount))),
      meanScannedRuleCount: fixed6(mean(candidates.map((entry) => entry.scannedRuleCount))),
      truncatedRecordCount: candidates.filter((entry) => entry.scannedRuleTruncated === true).length
    };
  })();

  const summary = {
    suite: "visible-text-policy-compare",
    runId,
    generatedAtIso: new Date().toISOString(),
    normalizationVersion: NORMALIZATION_VERSION,
    baselinePolicyId: BASELINE_POLICY_ID,
    recommendedCandidatePolicyId: promotedPolicyId,
    recommendedCandidateReason: promotedPolicyId === BASELINE_POLICY_ID
      ? `No candidate exceeded baseline on ${DECISION_SURFACE}; baseline retained`
      : `Highest mean delta on ${DECISION_SURFACE}, tie-broken by mean score then lower worseCount`,
    policySelection: {
      decisionSurface: DECISION_SURFACE,
      primaryCandidatePolicyId: primaryCandidate.id,
      primaryCandidateDeltaOnDecisionSurface: primaryCandidateSummary.meanDeltaNormalizedTokenF1,
      promotedPolicyId
    },
    gates: {
      ok: allSurfaceGatesPass,
      thresholds: {
        decisionSurface: {
          minDelta: MIN_DECISION_SURFACE_DELTA
        },
        challengeSurface: {
          minDelta: MIN_CHALLENGE_SURFACE_DELTA
        }
      },
      checks: surfaceGates
    },
    policies: POLICIES.map((policy) => ({
      id: policy.id,
      description: policy.description,
      options: policy.options
    })),
    comparedRecords: detailRecords.length,
    comparedPages: new Set(detailRecords.map((record) => record.pageSha256)).size,
    overall: {
      baseline: policySummaryById.get(BASELINE_POLICY_ID),
      candidate: policySummaryById.get(promotedPolicyId)
    },
    decisionSurface: {
      surface: DECISION_SURFACE,
      baseline: decisionSummaryById.get(BASELINE_POLICY_ID),
      candidate: decisionSummaryById.get(promotedPolicyId)
    },
    renderedStyleDiagnostics,
    byPolicy: policySummaryList,
    bySurface: bySurfaceSummary
  };

  await writeNdjson(corpusPath(corpusDir, "reports/visible-text-policy-compare.ndjson"), detailRecords);
  await writeJson(corpusPath(corpusDir, "reports/visible-text-policy-compare.json"), summary);
  if (!allSurfaceGatesPass) {
    throw new Error("visible-text-policy-compare surface gates failed");
  }
  process.stdout.write(
    `visible-text-policy-compare ok: records=${String(detailRecords.length)} candidate=${promotedPolicyId} runId=${runId}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`visible-text-policy-compare failed: ${message}\n`);
  process.exit(1);
});
