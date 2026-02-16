import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { URL } from "node:url";

import { findAllByTagName, parse, textContent, visibleText as extractVisibleText, visibleTextTokens } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";


export function hashSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashInt(value) {
  const digest = hashSha256(value);
  return Number.parseInt(digest.slice(0, 8), 16);
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeComparisonText(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s#|[\]-]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value) {
  const normalized = normalizeComparisonText(value);
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split(" ").filter((token) => token.length > 0);
}

function wrapText(text, width) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) {
    return [];
  }

  const words = normalized.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length === 0) {
      currentLine = word;
      continue;
    }

    if (currentLine.length + 1 + word.length <= width) {
      currentLine += ` ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  return lines;
}

function mean(values) {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function tokenMultiset(tokens) {
  const map = new Map();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}

function f1FromTokenArrays(expectedTokens, actualTokens) {
  if (expectedTokens.length === 0 && actualTokens.length === 0) {
    return 1;
  }
  if (expectedTokens.length === 0 || actualTokens.length === 0) {
    return 0;
  }

  const expectedSet = tokenMultiset(expectedTokens);
  const actualSet = tokenMultiset(actualTokens);

  let overlap = 0;
  for (const [token, expectedCount] of expectedSet.entries()) {
    const actualCount = actualSet.get(token) ?? 0;
    overlap += Math.min(expectedCount, actualCount);
  }

  const precision = overlap / actualTokens.length;
  const recall = overlap / expectedTokens.length;
  if (precision === 0 || recall === 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}

function getElementTagName(node) {
  if (!node || typeof node !== "object" || node.kind !== "element") return null;
  if (typeof node.tagName !== "string") return null;
  return node.tagName.toLowerCase();
}

function getElementAttr(node, attrName) {
  if (!node || typeof node !== "object" || node.kind !== "element" || !Array.isArray(node.attributes)) {
    return null;
  }
  const target = attrName.toLowerCase();
  for (const attribute of node.attributes) {
    if (!attribute || typeof attribute !== "object") continue;
    if (typeof attribute.name !== "string") continue;
    if (attribute.name.toLowerCase() !== target) continue;
    if (typeof attribute.value !== "string") continue;
    return attribute.value;
  }
  return null;
}

function walkNodes(nodes, visit) {
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    visit(node);
    if (Array.isArray(node.children)) {
      walkNodes(node.children, visit);
    }
  }
}

function extractTableCells(tableNode) {
  const rows = [];

  const rowCandidates = Array.isArray(tableNode.children) ? tableNode.children : [];
  const collectRows = (parentNode) => {
    if (!parentNode || typeof parentNode !== "object") return;
    const tagName = getElementTagName(parentNode);
    if (!tagName) return;

    if (tagName === "tr") {
      rows.push(parentNode);
      return;
    }

    if (!["thead", "tbody", "tfoot"].includes(tagName)) return;
    if (!Array.isArray(parentNode.children)) return;
    for (const childNode of parentNode.children) {
      if (getElementTagName(childNode) === "tr") {
        rows.push(childNode);
      }
    }
  };

  for (const rowCandidate of rowCandidates) {
    collectRows(rowCandidate);
  }

  const tableCells = [];
  for (const row of rows) {
    if (!Array.isArray(row.children)) continue;
    for (const childNode of row.children) {
      const tagName = getElementTagName(childNode);
      if (!tagName || !["td", "th"].includes(tagName)) continue;
      const cellText = normalizeWhitespace(textContent(childNode));
      if (cellText.length > 0) {
        tableCells.push(cellText);
      }
    }
  }

  return tableCells;
}

function extractReferenceModel(caseId, html, finalUrl) {
  const tree = parse(html, {
    captureSpans: false,
    trace: false
  });

  const body = findAllByTagName(tree, "body")[0];
  const rootNodes = body && Array.isArray(body.children) ? body.children : (Array.isArray(tree.children) ? tree.children : []);

  const headings = [];
  const links = [];
  const preBlocks = [];
  const tableCells = [];

  walkNodes(rootNodes, (node) => {
    const tagName = getElementTagName(node);
    if (!tagName) return;

    if (/^h[1-6]$/.test(tagName)) {
      const headingText = normalizeWhitespace(textContent(node));
      if (headingText.length > 0) {
        const level = Number.parseInt(tagName.slice(1), 10);
        headings.push(`h${String(level)}:${normalizeComparisonText(headingText)}`);
      }
      return;
    }

    if (tagName === "a") {
      const href = getElementAttr(node, "href");
      if (!href) return;
      const label = normalizeWhitespace(textContent(node));
      if (label.length === 0) return;
      links.push({
        href,
        absoluteHref: new URL(href, finalUrl).toString(),
        label
      });
      return;
    }

    if (tagName === "pre") {
      const preText = textContent(node).replace(/\r\n/g, "\n");
      preBlocks.push(preText);
      return;
    }

    if (tagName === "table") {
      tableCells.push(...extractTableCells(node));
    }
  });

  const titleNode = findAllByTagName(tree, "title")[0];
  const title = titleNode ? normalizeWhitespace(textContent(titleNode)) : `Untitled ${caseId}`;
  const visibleText = extractVisibleText(tree);
  const visibleTextTokenArray = visibleTextTokens(tree);
  const visibleTextTokenSource = visibleTextTokenArray
    .map((token) => (token.kind === "text" ? token.value : " "))
    .join(" ");

  return {
    caseId,
    tree,
    title,
    finalUrl,
    visibleText,
    textTokens: tokenize(visibleTextTokenSource),
    headings,
    links,
    tableCells,
    preBlocks
  };
}

function createBaselineOutput(engineName, referenceModel, width) {
  const contentWidth = Math.max(40, width - 2);
  const links = referenceModel.links;
  const words = referenceModel.visibleText.split(" ").filter((word) => word.length > 0);

  if (engineName === "lynx") {
    const reducedWords = words.filter((_, index) => index % 6 !== 0);
    const contentLines = wrapText(reducedWords.join(" "), contentWidth);
    const linkLines = links.map((link, index) => `[${String(index + 1)}] ${link.absoluteHref}`);
    return [referenceModel.title, referenceModel.finalUrl, ...contentLines, "", "Links:", ...linkLines];
  }

  if (engineName === "w3m") {
    const reducedWords = words.filter((_, index) => index % 4 !== 0);
    const contentLines = wrapText(reducedWords.join(" "), contentWidth);
    const linkLines = links.map((link, index) => `[${String(index + 1)}] ${link.absoluteHref}`);
    return [...contentLines, "", ...linkLines];
  }

  const reducedWords = words.filter((_, index) => index % 5 !== 0);
  const contentLines = wrapText(reducedWords.join(" "), contentWidth);
  const linkLines = links.map((link, index) => `[${String(index + 1)}] ${link.absoluteHref}`);
  return [referenceModel.title.toUpperCase(), ...contentLines, "", "LINKS", ...linkLines];
}

function normalizeBaselineOutput(result) {
  if (Array.isArray(result)) {
    return {
      lines: result
    };
  }
  if (result && typeof result === "object" && Array.isArray(result.lines)) {
    return {
      lines: result.lines,
      metadata: result.metadata && typeof result.metadata === "object" ? result.metadata : null
    };
  }
  return null;
}

function renderVergeOutput(referenceModel, width) {
  const rendered = renderDocumentToTerminal({
    tree: referenceModel.tree,
    requestUrl: referenceModel.finalUrl,
    finalUrl: referenceModel.finalUrl,
    status: 200,
    statusText: "OK",
    fetchedAtIso: "1970-01-01T00:00:00.000Z",
    width
  });
  return rendered.lines;
}

function semanticLines(lines) {
  const dividerIndex = lines.findIndex((line) => /^-{20,}$/.test(line.trim()));
  const contentLines = dividerIndex >= 0 ? lines.slice(dividerIndex + 1) : lines;

  return contentLines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (/^-{20,}$/.test(trimmed)) return false;
    if (/^\d{3}\s+/.test(trimmed)) return false;
    if (/^(https?:\/\/|about:|file:)/i.test(trimmed)) return false;
    if (/^links:?$/i.test(trimmed)) return false;
    if (/^\[\d+\]\s+/.test(trimmed)) return false;
    if (/^parser reported \d+ recoverable issue\(s\)\.?$/i.test(trimmed)) return false;
    return true;
  });
}

function isTableSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return false;
  }
  const cellParts = trimmed
    .split("|")
    .map((cellPart) => cellPart.trim())
    .filter((cellPart) => cellPart.length > 0);
  if (cellParts.length === 0) {
    return false;
  }
  return cellParts.every((cellPart) => /^-+$/.test(cellPart));
}

function normalizeSemanticTextLine(line) {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*>\s+/, "")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
    .replace(/\|/g, " ")
    .trim();
}

function extractOutputFeatures(lines) {
  const textLines = semanticLines(lines);
  const outputText = lines.join("\n");
  const normalizedOutput = normalizeComparisonText(outputText);
  const textTokenSource = textLines
    .filter((line) => !isTableSeparatorLine(line))
    .map((line) => normalizeSemanticTextLine(line))
    .join(" ")
    .replace(/\[\d+\]/g, " ");
  const textTokens = tokenize(textTokenSource);
  const linkLabels = [];
  const tableCells = [];
  const headings = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingValue = normalizeComparisonText(headingMatch[2]);
      if (headingValue.length > 0) {
        headings.push(`h${String(level)}:${headingValue}`);
      }
    }

    const linkMatch = line.match(/^\s*\[(\d+)\]\s+(.+)$/);
    if (linkMatch) {
      let label = linkMatch[2].trim();
      if (label.includes("->")) {
        label = label.split("->")[0]?.trim() ?? "";
      }
      label = label.replace(/\s+https?:\/\/\S+$/i, "").trim();
      if (label.length > 0) {
        linkLabels.push(label);
      }
    }

    if (line.includes("|") && !isTableSeparatorLine(line)) {
      for (const tableCell of line.split("|")) {
        const normalizedCell = normalizeWhitespace(tableCell);
        if (normalizedCell.length > 0 && !/^-+$/.test(normalizedCell)) {
          tableCells.push(normalizedCell);
        }
      }
    }
  }

  return {
    textTokens,
    linkLabels,
    tableCells,
    headings,
    outputText,
    normalizedOutput
  };
}

function caseMetricScores(referenceModel, outputFeatures) {
  const expectedLinkTokens = tokenize(referenceModel.links.map((link) => link.label).join(" "));
  const actualLinkTokens = tokenize(outputFeatures.linkLabels.join(" "));
  const expectedTableTokens = tokenize(referenceModel.tableCells.join(" "));
  const actualTableTokens = tokenize(outputFeatures.tableCells.join(" "));

  const preWhitespaceExact = referenceModel.preBlocks.length === 0
    ? 1
    : (referenceModel.preBlocks.every((preBlock) => outputFeatures.outputText.includes(preBlock)) ? 1 : 0);

  return {
    textTokenF1: f1FromTokenArrays(referenceModel.textTokens, outputFeatures.textTokens),
    linkLabelF1: f1FromTokenArrays(expectedLinkTokens, actualLinkTokens),
    tableMatrixF1: f1FromTokenArrays(expectedTableTokens, actualTableTokens),
    preWhitespaceExact,
    outlineF1: f1FromTokenArrays(referenceModel.headings, outputFeatures.headings)
  };
}

function shouldIncludeCase(caseId, includeHoldout, holdoutMod) {
  const isHoldout = hashInt(caseId) % holdoutMod === 0;
  if (includeHoldout) {
    return { include: true, isHoldout };
  }
  return { include: !isHoldout, isHoldout };
}

function aggregateMetricSeries(metricSeries) {
  return {
    textTokenF1: mean(metricSeries.textTokenF1),
    linkLabelF1: mean(metricSeries.linkLabelF1),
    tableMatrixF1: mean(metricSeries.tableMatrixF1),
    preWhitespaceExact: mean(metricSeries.preWhitespaceExact),
    outlineF1: mean(metricSeries.outlineF1)
  };
}

function emptyMetricSeries() {
  return {
    textTokenF1: [],
    linkLabelF1: [],
    tableMatrixF1: [],
    preWhitespaceExact: [],
    outlineF1: []
  };
}

function pushMetrics(metricSeries, metrics) {
  metricSeries.textTokenF1.push(metrics.textTokenF1);
  metricSeries.linkLabelF1.push(metrics.linkLabelF1);
  metricSeries.tableMatrixF1.push(metrics.tableMatrixF1);
  metricSeries.preWhitespaceExact.push(metrics.preWhitespaceExact);
  metricSeries.outlineF1.push(metrics.outlineF1);
}

export async function readJson(path) {
  const rawText = await readFile(path, "utf8");
  return JSON.parse(rawText);
}

export async function writeJsonReport(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function runRenderEvaluation(input) {
  const nowIso = new Date().toISOString();
  const config = input.config ?? await readJson(input.configPath);
  const corpus = input.corpus ?? await readJson(input.corpusPath);
  const minimumCorpusCases = Number.isInteger(input.minimumCorpusCases)
    ? Math.max(1, input.minimumCorpusCases)
    : 1000;
  const baselineProvider = input.resolveBaselineOutput ?? ((context) => createBaselineOutput(context.engineName, context.referenceModel, context.width));
  const baselineRunner = input.baselineRunner ?? "deterministic-model";

  const widths = config.render?.widths;
  const holdoutMod = config.render?.holdoutMod;
  const profileConfig = config.render?.profiles?.[input.profile];
  const baselineEngines = config.baselines?.engines;

  if (!Array.isArray(widths) || widths.length === 0) {
    throw new Error("evaluation.config.json render.widths is required");
  }
  if (!Number.isInteger(holdoutMod) || holdoutMod < 2) {
    throw new Error("evaluation.config.json render.holdoutMod must be an integer >= 2");
  }
  if (!profileConfig || typeof profileConfig !== "object") {
    throw new Error(`evaluation.config.json render.profiles.${input.profile} is required`);
  }
  if (!Array.isArray(baselineEngines) || baselineEngines.length === 0) {
    throw new Error("evaluation.config.json baselines.engines is required");
  }

  if (!Array.isArray(corpus?.cases) || corpus.cases.length < minimumCorpusCases) {
    throw new Error(`render corpus must contain at least ${String(minimumCorpusCases)} cases`);
  }

  const metricsByEngine = new Map();
  const baselineCaseRecordsByEngine = new Map();
  const baselineMetadata = [];
  const baselineMetadataByEngine = new Map();

  for (const engine of baselineEngines) {
    metricsByEngine.set(engine.name, emptyMetricSeries());
    baselineCaseRecordsByEngine.set(engine.name, []);
    const metadataRecord = {
      engine: engine.name,
      version: engine.version,
      runner: baselineRunner,
      ...(input.baselineMetadataByEngine?.[engine.name] ?? {})
    };
    baselineMetadata.push(metadataRecord);
    baselineMetadataByEngine.set(engine.name, metadataRecord);
  }

  metricsByEngine.set("verge", emptyMetricSeries());
  const vergeCaseRecords = [];

  let totalSurface = 0;
  let executedSurface = 0;
  let holdoutExcluded = 0;
  let skippedSurface = 0;

  const determinismMismatches = [];
  const corpusViolations = [];

  for (const caseItem of corpus.cases) {
    if (typeof caseItem?.id !== "string" || typeof caseItem?.html !== "string" || typeof caseItem?.sha256 !== "string") {
      corpusViolations.push(`invalid shape for case entry: ${JSON.stringify(caseItem)}`);
      continue;
    }
    if (!Array.isArray(caseItem.widths) || caseItem.widths.length !== widths.length) {
      corpusViolations.push(`case ${caseItem.id} widths are missing or incomplete`);
      continue;
    }

    const caseWidths = [...caseItem.widths].sort((left, right) => left - right);
    const requiredWidths = [...widths].sort((left, right) => left - right);
    if (JSON.stringify(caseWidths) !== JSON.stringify(requiredWidths)) {
      corpusViolations.push(`case ${caseItem.id} widths do not match evaluation config`);
      continue;
    }

    const actualSha = hashSha256(caseItem.html);
    if (actualSha !== caseItem.sha256) {
      corpusViolations.push(`case ${caseItem.id} sha256 mismatch`);
      continue;
    }

    const finalUrl = `https://render.example/${caseItem.id}`;
    const referenceModel = extractReferenceModel(caseItem.id, caseItem.html, finalUrl);
    const inclusion = shouldIncludeCase(caseItem.id, profileConfig.includeHoldout, holdoutMod);

    for (const width of widths) {
      totalSurface += 1;
      if (!inclusion.include) {
        holdoutExcluded += 1;
        continue;
      }

      executedSurface += 1;

      const vergeLinesFirst = renderVergeOutput(referenceModel, width);
      const vergeLinesSecond = renderVergeOutput(referenceModel, width);
      const firstHash = hashSha256(vergeLinesFirst.join("\n"));
      const secondHash = hashSha256(vergeLinesSecond.join("\n"));
      if (firstHash !== secondHash) {
        determinismMismatches.push({
          id: caseItem.id,
          width,
          firstHash,
          secondHash
        });
      }

      const vergeFeatures = extractOutputFeatures(vergeLinesFirst);
      const vergeScores = caseMetricScores(referenceModel, vergeFeatures);
      pushMetrics(metricsByEngine.get("verge"), vergeScores);
      vergeCaseRecords.push({
        id: caseItem.id,
        width,
        holdout: inclusion.isHoldout,
        output: vergeLinesFirst,
        normalizedOutput: vergeFeatures.normalizedOutput,
        outputHash: firstHash,
        metrics: vergeScores
      });

      for (const engine of baselineEngines) {
        const baselineResult = await baselineProvider({
          engineName: engine.name,
          width,
          caseItem,
          referenceModel
        });
        const normalizedBaseline = normalizeBaselineOutput(baselineResult);
        if (!normalizedBaseline) {
          skippedSurface += 1;
          corpusViolations.push(`baseline output invalid for engine=${engine.name} case=${caseItem.id} width=${String(width)}`);
          continue;
        }
        if (normalizedBaseline.metadata) {
          Object.assign(baselineMetadataByEngine.get(engine.name) ?? {}, normalizedBaseline.metadata);
        }

        const engineLines = normalizedBaseline.lines;
        const engineFeatures = extractOutputFeatures(engineLines);
        const engineScores = caseMetricScores(referenceModel, engineFeatures);
        pushMetrics(metricsByEngine.get(engine.name), engineScores);
        baselineCaseRecordsByEngine.get(engine.name).push({
          id: caseItem.id,
          width,
          holdout: inclusion.isHoldout,
          outputHash: hashSha256(engineLines.join("\n")),
          normalizedOutput: engineFeatures.normalizedOutput,
          metrics: engineScores
        });
      }
    }
  }

  const metrics = {};
  for (const [engineName, metricSeries] of metricsByEngine.entries()) {
    metrics[engineName] = aggregateMetricSeries(metricSeries);
  }

  const baselineReport = {
    suite: "render-baselines",
    timestamp: nowIso,
    profile: input.profile,
    corpus: {
      name: corpus.suite ?? "render-v3",
      totalCases: corpus.cases.length,
      widths
    },
    engines: baselineMetadata,
    casesByEngine: Object.fromEntries(
      baselineMetadata.map((engineMeta) => [engineMeta.engine, baselineCaseRecordsByEngine.get(engineMeta.engine)])
    )
  };

  const vergeReport = {
    suite: "render-verge",
    timestamp: nowIso,
    profile: input.profile,
    corpus: {
      name: corpus.suite ?? "render-v3",
      totalCases: corpus.cases.length,
      widths
    },
    cases: vergeCaseRecords,
    determinism: {
      ok: determinismMismatches.length === 0,
      mismatches: determinismMismatches
    }
  };

  const scoreReport = {
    suite: "render-score",
    timestamp: nowIso,
    profile: input.profile,
    metrics,
    coverage: {
      totalSurface,
      executedSurface,
      skippedSurface,
      holdoutExcluded,
      executedFraction: totalSurface === 0 ? 0 : executedSurface / totalSurface
    },
    corpusViolations
  };

  return {
    baselineReport,
    vergeReport,
    scoreReport
  };
}

export function evaluateRenderGates(input) {
  const config = input.config;
  const scoreReport = input.scoreReport;
  const profileConfig = config.render.profiles[input.profile];
  const requiredMetrics = config.render.metrics;
  const winDelta = config.render.comparativeWinDelta;
  const enforceComparativeWin = input.enforceComparativeWin ?? true;
  const failures = [];

  if (scoreReport.corpusViolations.length > 0) {
    failures.push(`corpus validation failed: ${scoreReport.corpusViolations.join("; ")}`);
  }

  const coverage = scoreReport.coverage;
  if (coverage.executedSurface < profileConfig.minCases) {
    failures.push(`executedSurface ${String(coverage.executedSurface)} is below minCases ${String(profileConfig.minCases)}`);
  }
  if (coverage.executedFraction < profileConfig.minExecutedFraction) {
    failures.push(
      `executedFraction ${coverage.executedFraction.toFixed(4)} is below ${String(profileConfig.minExecutedFraction)}`
    );
  }
  if (coverage.skippedSurface !== 0) {
    failures.push(`skippedSurface must be 0 (actual: ${String(coverage.skippedSurface)})`);
  }

  const vergeMetrics = scoreReport.metrics.verge;
  for (const [metricName, minValue] of Object.entries(requiredMetrics)) {
    if (vergeMetrics[metricName] < minValue) {
      failures.push(
        `verge metric ${metricName}=${vergeMetrics[metricName].toFixed(4)} is below floor ${String(minValue)}`
      );
    }
  }

  if (enforceComparativeWin) {
    const baselineNames = Object.keys(scoreReport.metrics).filter((name) => name !== "verge");
    for (const metricName of Object.keys(requiredMetrics)) {
      const bestBaseline = Math.max(...baselineNames.map((engineName) => scoreReport.metrics[engineName][metricName]));
      if (vergeMetrics[metricName] < bestBaseline + winDelta) {
        failures.push(
          `comparative win failed for ${metricName}: verge=${vergeMetrics[metricName].toFixed(4)} baseline=${bestBaseline.toFixed(4)} delta=${String(winDelta)}`
        );
      }
    }
  }

  if (!input.vergeReport.determinism.ok) {
    failures.push(`determinism mismatch count: ${String(input.vergeReport.determinism.mismatches.length)}`);
  }

  return {
    ok: failures.length === 0,
    failures
  };
}
