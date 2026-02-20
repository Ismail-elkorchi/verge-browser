import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TextDecoder, TextEncoder } from "node:util";

import { parseBytes, visibleTextTokens } from "html-parser";

import {
  corpusPath,
  ensureCorpusDirs,
  readNdjson,
  resolveCorpusDir,
  sha256HexString,
  writeJson
} from "./lib.mjs";

const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();
const BASELINE_POLICY_ID = "baseline";
const DECISION_SURFACE = "meaningful-content";
const MAX_CASES = 12;
const MAX_MINIMIZATION_PASSES = 64;

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

function transformHtmlByPolicyId(html, policyId) {
  if (policyId === "baseline" || policyId === "fallback-all") {
    return html;
  }
  const stripAriaLabelFromTags = new Set(
    policyId === "fallback-aria-only"
      ? []
      : policyId === "fallback-controls-aria-only"
        ? ["a"]
        : policyId === "fallback-input-only-aria"
          ? ["a", "button"]
          : []
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
    const attributesToStrip = ["title"];
    if (stripAriaLabelFromTags.has(tagName)) {
      attributesToStrip.push("aria-label");
    }
    return removeAttributesFromTagMarkup(tagMarkup, attributesToStrip);
  });
}

function policyText(html, policyId, optionsByPolicyId) {
  const transformedHtml = transformHtmlByPolicyId(html, policyId);
  const tree = parseBytes(UTF8_ENCODER.encode(transformedHtml), {
    captureSpans: false,
    trace: false
  });
  const options = optionsByPolicyId.get(policyId) ?? {};
  const mergedText = visibleTextTokens(tree, options)
    .map((token) => (token.kind === "text" ? token.value : " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return mergedText;
}

function collectInputElementSpans(node, spans) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.kind === "document" || node.kind === "fragment") {
    for (const child of node.children) {
      collectInputElementSpans(child, spans);
    }
    return;
  }
  if (node.kind === "element") {
    if (
      node.span &&
      node.spanProvenance === "input" &&
      Number.isInteger(node.span.start) &&
      Number.isInteger(node.span.end) &&
      node.span.end > node.span.start
    ) {
      spans.push({
        start: node.span.start,
        end: node.span.end
      });
    }
    for (const child of node.children) {
      collectInputElementSpans(child, spans);
    }
  }
}

function sortedUniqueSpans(spans, textLength) {
  const unique = new Map();
  for (const span of spans) {
    if (
      !Number.isInteger(span.start)
      || !Number.isInteger(span.end)
      || span.start < 0
      || span.end <= span.start
      || span.end > textLength
    ) {
      continue;
    }
    const key = `${String(span.start)}:${String(span.end)}`;
    if (!unique.has(key)) {
      unique.set(key, {
        start: span.start,
        end: span.end,
        length: span.end - span.start
      });
    }
  }
  return [...unique.values()].sort((left, right) => {
    if (right.length !== left.length) {
      return right.length - left.length;
    }
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.end - right.end;
  });
}

function evaluateDifference(html, candidatePolicyId, optionsByPolicyId) {
  const baselineText = policyText(html, BASELINE_POLICY_ID, optionsByPolicyId);
  const candidateText = policyText(html, candidatePolicyId, optionsByPolicyId);
  return {
    differs: baselineText !== candidateText,
    baselineText,
    candidateText
  };
}

function minimizeHtml(inputHtml, candidatePolicyId, optionsByPolicyId) {
  let currentHtml = inputHtml;
  let passes = 0;
  let changed = true;

  const originalDifference = evaluateDifference(currentHtml, candidatePolicyId, optionsByPolicyId);
  if (!originalDifference.differs) {
    return {
      minimizedHtml: currentHtml,
      passes,
      preserved: false,
      baselineText: originalDifference.baselineText,
      candidateText: originalDifference.candidateText
    };
  }

  while (changed && passes < MAX_MINIMIZATION_PASSES) {
    changed = false;
    passes += 1;

    const tree = parseBytes(UTF8_ENCODER.encode(currentHtml), {
      captureSpans: true,
      trace: false
    });
    const spanCandidates = [];
    collectInputElementSpans(tree, spanCandidates);
    const spans = sortedUniqueSpans(spanCandidates, currentHtml.length);

    for (const span of spans) {
      if (span.start === 0 && span.end === currentHtml.length) {
        continue;
      }
      const nextHtml = `${currentHtml.slice(0, span.start)}${currentHtml.slice(span.end)}`;
      if (nextHtml.trim().length === 0) {
        continue;
      }
      const nextDifference = evaluateDifference(nextHtml, candidatePolicyId, optionsByPolicyId);
      if (nextDifference.differs) {
        currentHtml = nextHtml;
        changed = true;
        break;
      }
    }
  }

  const finalDifference = evaluateDifference(currentHtml, candidatePolicyId, optionsByPolicyId);
  return {
    minimizedHtml: currentHtml,
    passes,
    preserved: finalDifference.differs,
    baselineText: finalDifference.baselineText,
    candidateText: finalDifference.candidateText
  };
}

function fixed6(value) {
  return Number(value.toFixed(6));
}

function utf8ByteLength(value) {
  return UTF8_ENCODER.encode(value).length;
}

async function main() {
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const summaryPath = corpusPath(corpusDir, "reports/visible-text-policy-compare.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const compareRecords = await readNdjson(corpusPath(corpusDir, "reports/visible-text-policy-compare.ndjson"));
  if (compareRecords.length === 0) {
    throw new Error("visible-text policy comparison data missing");
  }

  const primaryCandidatePolicyId = summary?.policySelection?.primaryCandidatePolicyId;
  if (typeof primaryCandidatePolicyId !== "string" || primaryCandidatePolicyId.length === 0) {
    throw new Error("primary candidate policy id missing from compare summary");
  }

  const optionsByPolicyId = new Map(
    (Array.isArray(summary?.policies) ? summary.policies : [])
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => [entry.id, entry.options ?? {}])
  );

  const perPage = new Map();
  for (const record of compareRecords) {
    if (record.pageSurface !== DECISION_SURFACE) {
      continue;
    }
    const candidateDelta = record?.deltasFromBaseline?.[primaryCandidatePolicyId]?.normalizedTokenF1;
    if (typeof candidateDelta !== "number" || candidateDelta === 0) {
      continue;
    }
    if (!perPage.has(record.pageSha256)) {
      perPage.set(record.pageSha256, {
        pageSha256: record.pageSha256,
        finalUrl: record.finalUrl,
        deltas: []
      });
    }
    perPage.get(record.pageSha256).deltas.push(candidateDelta);
  }

  const selectedPages = [...perPage.values()]
    .map((entry) => ({
      pageSha256: entry.pageSha256,
      finalUrl: entry.finalUrl,
      meanDeltaNormalizedTokenF1: fixed6(entry.deltas.reduce((sum, value) => sum + value, 0) / entry.deltas.length),
      absoluteMeanDelta: fixed6(Math.abs(entry.deltas.reduce((sum, value) => sum + value, 0) / entry.deltas.length))
    }))
    .sort((left, right) => {
      if (right.absoluteMeanDelta !== left.absoluteMeanDelta) {
        return right.absoluteMeanDelta - left.absoluteMeanDelta;
      }
      return left.pageSha256.localeCompare(right.pageSha256);
    })
    .slice(0, MAX_CASES);

  const minimizedDir = corpusPath(corpusDir, "triage/minimized");
  await mkdir(minimizedDir, { recursive: true });

  const minimizedCases = [];
  for (const entry of selectedPages) {
    const htmlPath = corpusPath(corpusDir, `cache/html/${entry.pageSha256}.bin`);
    const htmlBytes = new Uint8Array(await readFile(htmlPath));
    const htmlText = UTF8_DECODER.decode(htmlBytes);
    const originalDiff = evaluateDifference(htmlText, primaryCandidatePolicyId, optionsByPolicyId);
    const minimized = minimizeHtml(htmlText, primaryCandidatePolicyId, optionsByPolicyId);
    const minimizedSha256 = sha256HexString(minimized.minimizedHtml);
    await writeFile(corpusPath(minimizedDir, `${minimizedSha256}.html`), minimized.minimizedHtml, "utf8");

    const minimizedBytes = utf8ByteLength(minimized.minimizedHtml);
    minimizedCases.push({
      pageSha256: entry.pageSha256,
      finalUrl: entry.finalUrl,
      meanDeltaNormalizedTokenF1: entry.meanDeltaNormalizedTokenF1,
      preservedDifference: minimized.preserved,
      originalBytes: htmlBytes.length,
      minimizedBytes,
      reductionFraction: fixed6(1 - (minimizedBytes / Math.max(1, htmlBytes.length))),
      minimizationPasses: minimized.passes,
      minimizedSha256,
      originalDifference: {
        baselineLength: originalDiff.baselineText.length,
        candidateLength: originalDiff.candidateText.length
      },
      minimizedDifference: {
        baselineLength: minimized.baselineText.length,
        candidateLength: minimized.candidateText.length
      }
    });
  }

  const report = {
    suite: "visible-text-residual-minimization",
    runId: sha256HexString(
      JSON.stringify({
        script: "minimize-visible-text-residuals-v1",
        compareRunId: summary.runId ?? null,
        decisionSurface: DECISION_SURFACE,
        primaryCandidatePolicyId,
        selectedPages: selectedPages.map((entry) => entry.pageSha256)
      })
    ),
    generatedAtIso: new Date().toISOString(),
    decisionSurface: DECISION_SURFACE,
    primaryCandidatePolicyId,
    selectedPageCount: selectedPages.length,
    minimizedCases
  };

  await writeJson(corpusPath(corpusDir, "reports/visible-text-residual-minimization.json"), report);
  process.stdout.write(
    `visible-text-residual-minimization ok: pages=${String(selectedPages.length)} policy=${primaryCandidatePolicyId}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`visible-text-residual-minimization failed: ${message}\n`);
  process.exit(1);
});
