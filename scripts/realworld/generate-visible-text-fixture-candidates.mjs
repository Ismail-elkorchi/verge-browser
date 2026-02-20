import { readFile, writeFile } from "node:fs/promises";

import { corpusPath, ensureCorpusDirs, resolveCorpusDir, sha256HexString, writeJson } from "./lib.mjs";

const FIXTURE_TEMPLATES = Object.freeze({
  "missing:text-node": {
    title: "Inline text node retention",
    residualClassId: "missing-text-node",
    syntheticHtml: "<main><p>alpha <strong>beta</strong> gamma</p></main>",
    expectedText: "alpha beta gamma",
    notes: "Covers plain text-node loss across inline boundaries."
  },
  "missing:noscript-fallback": {
    title: "Noscript visible text retention",
    residualClassId: "missing-noscript-fallback",
    syntheticHtml: "<main><noscript>fallback text</noscript><p>tail</p></main>",
    expectedText: "fallback text tail",
    notes: "Covers noscript fallback text extraction in visible flow."
  },
  "missing:img-alt": {
    title: "Image alt contribution",
    residualClassId: "missing-img-alt",
    syntheticHtml: "<main><img alt=\"brand logo\"><p>end</p></main>",
    expectedText: "brand logo end",
    notes: "Covers alt text contribution contract."
  },
  "missing:input-value": {
    title: "Input value contribution",
    residualClassId: "missing-input-value",
    syntheticHtml: "<main><input type=\"submit\" value=\"send\"><p>end</p></main>",
    expectedText: "send end",
    notes: "Covers input value contribution for unlabeled controls."
  },
  "missing:button-value": {
    title: "Button value attribute contribution",
    residualClassId: "missing-button-value",
    syntheticHtml: "<main><button value=\"Continue\"></button><p>end</p></main>",
    expectedText: "Continue end",
    notes: "Covers value attribute contribution on unlabeled button elements."
  },
  "missing:block-break": {
    title: "Block break preservation",
    residualClassId: "missing-block-break",
    syntheticHtml: "<main><div>alpha</div><div>beta</div></main>",
    expectedText: "alpha\n\nbeta",
    notes: "Covers deterministic block boundary breaks."
  },
  "missing:paragraph-break": {
    title: "Paragraph break preservation",
    residualClassId: "missing-paragraph-break",
    syntheticHtml: "<main><p>alpha</p><p>beta</p></main>",
    expectedText: "alpha\n\nbeta",
    notes: "Covers deterministic paragraph boundary breaks."
  },
  "missing:table-row-break": {
    title: "Table row separator",
    residualClassId: "missing-table-row-break",
    syntheticHtml: "<table><tr><td>A</td></tr><tr><td>B</td></tr></table>",
    expectedText: "A\nB",
    notes: "Covers row separator semantics."
  },
  "missing:table-cell-separator": {
    title: "Table cell separator",
    residualClassId: "missing-table-cell-separator",
    syntheticHtml: "<table><tr><td>A</td><td>B</td></tr></table>",
    expectedText: "A\tB",
    notes: "Covers tab separator semantics for table cells."
  },
  "missing:br-break": {
    title: "Line break element",
    residualClassId: "missing-br-break",
    syntheticHtml: "<main>alpha<br>beta</main>",
    expectedText: "alpha\nbeta",
    notes: "Covers explicit `<br>` newline semantics."
  }
});

async function readRequiredJson(path) {
  const source = await readFile(path, "utf8");
  return JSON.parse(source);
}

function createFixtureCandidate(bucket) {
  const template = FIXTURE_TEMPLATES[bucket.bucketId] ?? null;
  if (!template) {
    return {
      bucketId: bucket.bucketId,
      residualClassId: bucket.residualClassId,
      action: "classify-not-in-scope",
      reason: "No deterministic synthetic fixture template for this residual class.",
      evidence: {
        residualShare: bucket.residualShare,
        tokenCount: bucket.tokenCount,
        sampleCount: bucket.examples.length
      },
      samplePages: bucket.examples.map((entry) => ({
        pageSha256: entry.pageSha256,
        finalUrl: entry.finalUrl,
        tool: entry.tool,
        width: entry.width,
        contribution: entry.contribution
      }))
    };
  }

  return {
    bucketId: bucket.bucketId,
    residualClassId: template.residualClassId,
    action: "fixture",
    title: template.title,
    syntheticHtml: template.syntheticHtml,
    expectedText: template.expectedText,
    notes: template.notes,
    evidence: {
      residualShare: bucket.residualShare,
      tokenCount: bucket.tokenCount,
      sampleCount: bucket.examples.length
    },
    samplePages: bucket.examples.map((entry) => ({
      pageSha256: entry.pageSha256,
      finalUrl: entry.finalUrl,
      tool: entry.tool,
      width: entry.width,
      contribution: entry.contribution
    }))
  };
}

function markdownForCandidates(report) {
  const lines = [
    "# Visible-text fixture candidates",
    "",
    `runId: ${report.runId}`,
    `sourceTaxonomyRunId: ${report.sourceTaxonomyRunId}`,
    `decisionSurface: ${report.decisionSurface}`,
    `topBucketCoverageShare: ${String(report.topBucketCoverageShare)}`,
    `fixtureCandidates: ${String(report.fixtureCandidates.length)}`,
    `classificationsOnly: ${String(report.classificationsOnly.length)}`,
    "",
    "## Candidates"
  ];

  for (const candidate of report.fixtureCandidates) {
    lines.push(
      `### ${candidate.bucketId} -> ${candidate.residualClassId}`,
      `- action: ${candidate.action}`,
      `- title: ${candidate.title}`,
      `- residualShare: ${String(candidate.evidence.residualShare)}`,
      `- sampleCount: ${String(candidate.evidence.sampleCount)}`,
      "```html",
      candidate.syntheticHtml,
      "```",
      `- expectedText: ${candidate.expectedText}`,
      `- notes: ${candidate.notes}`,
      ""
    );
  }

  if (report.classificationsOnly.length > 0) {
    lines.push("## Classified without fixture template");
    for (const candidate of report.classificationsOnly) {
      lines.push(
        `- ${candidate.bucketId} (${candidate.residualClassId}): ${candidate.reason} ` +
        `[residualShare=${String(candidate.evidence.residualShare)}]`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const corpusDir = resolveCorpusDir();
  await ensureCorpusDirs(corpusDir);

  const taxonomyReport = await readRequiredJson(
    corpusPath(corpusDir, "reports/visible-text-residual-taxonomy.json")
  );
  if (taxonomyReport?.taxonomyCoverage?.pass !== true) {
    throw new Error("taxonomy coverage failed; run npm run field:triage:taxonomy first");
  }

  const sourceBuckets = Array.isArray(taxonomyReport.topBuckets) ? taxonomyReport.topBuckets : [];
  if (sourceBuckets.length === 0) {
    throw new Error("taxonomy report has no top buckets");
  }

  const candidates = sourceBuckets.map((bucket) => createFixtureCandidate(bucket));
  const fixtureCandidates = candidates.filter((entry) => entry.action === "fixture");
  const classificationsOnly = candidates.filter((entry) => entry.action !== "fixture");
  const linkagePass = candidates.every((entry) =>
    typeof entry.bucketId === "string"
    && entry.bucketId.length > 0
    && typeof entry.residualClassId === "string"
    && entry.residualClassId.length > 0
  );
  if (!linkagePass) {
    throw new Error("fixture candidate linkage failed: bucketId/residualClassId missing");
  }

  const report = {
    suite: "visible-text-fixture-candidates",
    runId: sha256HexString(
      JSON.stringify({
        script: "generate-visible-text-fixture-candidates-v2",
        taxonomyRunId: taxonomyReport.runId,
        buckets: sourceBuckets.map((entry) => entry.bucketId)
      })
    ),
    generatedAtIso: new Date().toISOString(),
    sourceTaxonomyRunId: taxonomyReport.runId,
    decisionSurface: taxonomyReport.decisionSurface,
    topBucketCoverageShare: taxonomyReport.taxonomyCoverage.topBucketsResidualShare,
    linkagePass,
    fixtureCandidates,
    classificationsOnly
  };

  await writeJson(corpusPath(corpusDir, "triage/visible-text-fixture-candidates.json"), report);
  await writeFile(
    corpusPath(corpusDir, "triage/visible-text-fixture-candidates.md"),
    markdownForCandidates(report),
    "utf8"
  );
  process.stdout.write(
    `visible-text-fixture-candidates ok: fixtures=${String(fixtureCandidates.length)} ` +
    `classified=${String(classificationsOnly.length)} runId=${report.runId}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`visible-text-fixture-candidates failed: ${message}\n`);
  process.exit(1);
});
