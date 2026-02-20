import { readFile, writeFile } from "node:fs/promises";

import { parseBytes } from "html-parser";

import {
  corpusPath,
  ensureCorpusDirs,
  readNdjson,
  resolveCorpusDir,
  sha256HexString,
  writeJson
} from "./lib.mjs";

const FEATURE_TEMPLATES = Object.freeze({
  "interactive-aria-label-only": {
    title: "Interactive element uses aria-label fallback",
    syntheticHtml: "<main><button aria-label=\"Open menu\"></button><p>Next</p></main>",
    expectedDefaultText: "Next",
    expectedCandidateText: "Open menu Next",
    notes: "Verifies optional accessible-name fallback for unlabeled button content."
  },
  "interactive-title-only": {
    title: "Interactive element uses title fallback",
    syntheticHtml: "<main><a title=\"Open details\"></a><p>Next</p></main>",
    expectedDefaultText: "Next",
    expectedCandidateText: "Open details Next",
    notes: "Verifies title fallback when aria-label is absent."
  },
  "input-value-fallback": {
    title: "Input value contributes when no visible label exists",
    syntheticHtml: "<main><input type=\"submit\" value=\"Search\"><p>Done</p></main>",
    expectedDefaultText: "Done",
    expectedCandidateText: "Search Done",
    notes: "Validates input value contribution in fallback mode."
  },
  "aria-hidden-subtree-suppression": {
    title: "aria-hidden subtree stays excluded",
    syntheticHtml: "<main><div aria-hidden=\"true\">Hidden text</div><p>Shown</p></main>",
    expectedDefaultText: "Shown",
    expectedCandidateText: "Shown",
    notes: "Ensures fallback does not leak hidden subtree text."
  },
  "hidden-subtree-suppression": {
    title: "hidden subtree stays excluded",
    syntheticHtml: "<main><section hidden>Hidden block</section><p>Shown</p></main>",
    expectedDefaultText: "Shown",
    expectedCandidateText: "Shown",
    notes: "Ensures hidden attribute suppression remains stable."
  },
  "table-separator-shape": {
    title: "Table cell and row separators remain deterministic",
    syntheticHtml: "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>",
    expectedDefaultText: "A\tB\nC\tD",
    expectedCandidateText: "A\tB\nC\tD",
    notes: "Protects table separator semantics while fallback option is enabled."
  },
  "foreign-content-inline-text": {
    title: "SVG and MathML inline text stays visible",
    syntheticHtml: "<p><svg><text>X</text></svg><math><mi>y</mi></math></p>",
    expectedDefaultText: "Xy",
    expectedCandidateText: "Xy",
    notes: "Protects foreign-content visible text extraction."
  },
  "pre-whitespace-preservation": {
    title: "Preformatted whitespace remains preserved",
    syntheticHtml: "<pre>line 1\n  line 2</pre>",
    expectedDefaultText: "line 1\n  line 2",
    expectedCandidateText: "line 1\n  line 2",
    notes: "Ensures whitespace preservation remains unchanged by fallback behavior."
  },
  "template-exclusion": {
    title: "Template content remains excluded",
    syntheticHtml: "<main><template><p>Hidden</p></template><p>Shown</p></main>",
    expectedDefaultText: "Shown",
    expectedCandidateText: "Shown",
    notes: "Guards template exclusion contract."
  },
  "script-style-exclusion": {
    title: "Script and style content remain excluded",
    syntheticHtml: "<main><style>.x{}</style><script>var x = 1;</script><p>Shown</p></main>",
    expectedDefaultText: "Shown",
    expectedCandidateText: "Shown",
    notes: "Guards script/style exclusion contract."
  }
});

function getAttribute(node, name) {
  if (!node || node.kind !== "element") {
    return null;
  }
  const lowerName = name.toLowerCase();
  for (const attribute of node.attributes) {
    if (attribute.name.toLowerCase() === lowerName) {
      return attribute.value;
    }
  }
  return null;
}

function subtreeHasVisibleText(node) {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (node.kind === "text") {
    return node.value.trim().length > 0;
  }
  if (node.kind !== "element") {
    return false;
  }
  if (getAttribute(node, "hidden") !== null) {
    return false;
  }
  if ((getAttribute(node, "aria-hidden") ?? "").trim().toLowerCase() === "true") {
    return false;
  }
  return node.children.some((child) => subtreeHasVisibleText(child));
}

function detectFeatures(tree) {
  const features = new Set();

  function visit(node) {
    if (!node || typeof node !== "object" || node.kind !== "element") {
      return;
    }

    const tagName = node.tagName.toLowerCase();
    const hiddenValue = getAttribute(node, "hidden");
    const ariaHiddenValue = (getAttribute(node, "aria-hidden") ?? "").trim().toLowerCase();
    const ariaLabelValue = (getAttribute(node, "aria-label") ?? "").trim();
    const titleValue = (getAttribute(node, "title") ?? "").trim();
    const valueValue = (getAttribute(node, "value") ?? "").trim();
    const typeValue = (getAttribute(node, "type") ?? "").trim().toLowerCase();

    if (hiddenValue !== null) {
      features.add("hidden-subtree-suppression");
    }
    if (ariaHiddenValue === "true") {
      features.add("aria-hidden-subtree-suppression");
    }
    if (tagName === "table" || tagName === "tr" || tagName === "td" || tagName === "th") {
      features.add("table-separator-shape");
    }
    if (tagName === "template") {
      features.add("template-exclusion");
    }
    if (tagName === "script" || tagName === "style") {
      features.add("script-style-exclusion");
    }
    if (tagName === "svg" || tagName === "math") {
      features.add("foreign-content-inline-text");
    }
    if (tagName === "pre" || tagName === "code" || tagName === "textarea") {
      features.add("pre-whitespace-preservation");
    }
    if ((tagName === "a" || tagName === "button") && !subtreeHasVisibleText(node)) {
      if (ariaLabelValue.length > 0) {
        features.add("interactive-aria-label-only");
      } else if (titleValue.length > 0) {
        features.add("interactive-title-only");
      }
    }
    if (tagName === "input" && typeValue !== "hidden" && !subtreeHasVisibleText(node)) {
      if (ariaLabelValue.length > 0) {
        features.add("interactive-aria-label-only");
      } else if (titleValue.length > 0) {
        features.add("interactive-title-only");
      } else if (valueValue.length > 0) {
        features.add("input-value-fallback");
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  for (const node of tree.children) {
    visit(node);
  }
  return features;
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

async function main() {
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const compareRecords = await readNdjson(corpusPath(corpusDir, "reports/visible-text-policy-compare.ndjson"));
  if (compareRecords.length === 0) {
    throw new Error("policy compare report missing; run npm run field:visible-text:ab first");
  }

  const pageScores = new Map();
  for (const record of compareRecords) {
    const key = record.pageSha256;
    if (!pageScores.has(key)) {
      pageScores.set(key, {
        pageSha256: record.pageSha256,
        finalUrl: record.finalUrl,
        scores: []
      });
    }
    pageScores.get(key).scores.push(record.delta.normalizedTokenF1);
  }

  const pageFeatures = new Map();
  for (const [pageSha256, scoreEntry] of pageScores.entries()) {
    const htmlBytes = new Uint8Array(await readFile(corpusPath(corpusDir, `cache/html/${pageSha256}.bin`)));
    const tree = parseBytes(htmlBytes, {
      captureSpans: false,
      trace: false
    });
    const features = [...detectFeatures(tree)].sort((left, right) => left.localeCompare(right));
    const meanDelta = fixed6(mean(scoreEntry.scores));
    pageFeatures.set(pageSha256, {
      pageSha256,
      finalUrl: scoreEntry.finalUrl,
      meanDelta,
      features
    });
  }

  const featureEvidence = new Map();
  for (const page of pageFeatures.values()) {
    for (const featureId of page.features) {
      if (!FEATURE_TEMPLATES[featureId]) {
        continue;
      }
      if (!featureEvidence.has(featureId)) {
        featureEvidence.set(featureId, {
          featureId,
          pages: [],
          deltas: []
        });
      }
      const bucket = featureEvidence.get(featureId);
      bucket.pages.push({
        pageSha256: page.pageSha256,
        finalUrl: page.finalUrl,
        meanDeltaNormalizedTokenF1: page.meanDelta
      });
      bucket.deltas.push(page.meanDelta);
    }
  }

  const evidenceList = [...featureEvidence.values()]
    .map((entry) => ({
      featureId: entry.featureId,
      pagesWithFeature: entry.pages.length,
      meanDeltaNormalizedTokenF1: fixed6(mean(entry.deltas)),
      maxDeltaNormalizedTokenF1: fixed6(Math.max(...entry.deltas)),
      minDeltaNormalizedTokenF1: fixed6(Math.min(...entry.deltas)),
      samplePages: [...entry.pages]
        .sort((left, right) => right.meanDeltaNormalizedTokenF1 - left.meanDeltaNormalizedTokenF1)
        .slice(0, 5)
    }))
    .sort((left, right) => {
      if (right.meanDeltaNormalizedTokenF1 !== left.meanDeltaNormalizedTokenF1) {
        return right.meanDeltaNormalizedTokenF1 - left.meanDeltaNormalizedTokenF1;
      }
      if (right.pagesWithFeature !== left.pagesWithFeature) {
        return right.pagesWithFeature - left.pagesWithFeature;
      }
      return left.featureId.localeCompare(right.featureId);
    });

  const candidateList = evidenceList
    .filter((entry) => FEATURE_TEMPLATES[entry.featureId])
    .map((entry, index) => {
      const template = FEATURE_TEMPLATES[entry.featureId];
      return {
        candidateId: `candidate-${String(index + 1).padStart(3, "0")}`,
        featureId: entry.featureId,
        title: template.title,
        evidence: {
          pagesWithFeature: entry.pagesWithFeature,
          meanDeltaNormalizedTokenF1: entry.meanDeltaNormalizedTokenF1
        },
        syntheticHtml: template.syntheticHtml,
        expectedDefaultText: template.expectedDefaultText,
        expectedCandidateText: template.expectedCandidateText,
        notes: template.notes
      };
    });

  const runId = sha256HexString(
    JSON.stringify({
      script: "generate-visible-text-fixture-candidates-v1",
      sourceRunIds: [...new Set(compareRecords.map((record) => record.runId))].sort(),
      candidateFeatureIds: candidateList.map((candidate) => candidate.featureId)
    })
  );

  const report = {
    suite: "visible-text-fixture-candidates",
    runId,
    generatedAtIso: new Date().toISOString(),
    comparedPages: pageFeatures.size,
    comparedRecords: compareRecords.length,
    featureEvidence: evidenceList,
    candidates: candidateList
  };

  const markdownLines = [
    "# Visible-text fixture candidates",
    "",
    `runId: ${runId}`,
    `comparedPages: ${String(report.comparedPages)}`,
    `comparedRecords: ${String(report.comparedRecords)}`,
    "",
    "## Candidate list",
    ...candidateList.flatMap((candidate) => ([
      `### ${candidate.candidateId} ${candidate.featureId}`,
      `- title: ${candidate.title}`,
      `- evidence pages: ${String(candidate.evidence.pagesWithFeature)}`,
      `- evidence meanDeltaNormalizedTokenF1: ${String(candidate.evidence.meanDeltaNormalizedTokenF1)}`,
      `- notes: ${candidate.notes}`,
      "- syntheticHtml:",
      "```html",
      candidate.syntheticHtml,
      "```",
      `- expectedDefaultText: ${candidate.expectedDefaultText}`,
      `- expectedCandidateText: ${candidate.expectedCandidateText}`,
      ""
    ]))
  ];

  await writeJson(corpusPath(corpusDir, "triage/visible-text-fixture-candidates.json"), report);
  await writeJson(corpusPath(corpusDir, "triage/visible-text-feature-evidence.json"), {
    suite: report.suite,
    runId: report.runId,
    featureEvidence: report.featureEvidence
  });
  await writeFile(
    corpusPath(corpusDir, "triage/visible-text-fixture-candidates.md"),
    `${markdownLines.join("\n")}\n`,
    "utf8"
  );
  process.stdout.write(`visible-text-fixture-candidates ok: candidates=${String(candidateList.length)} runId=${runId}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`visible-text-fixture-candidates failed: ${message}\n`);
  process.exit(1);
});
