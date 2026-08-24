import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "@ismail-elkorchi/html-parser";

import { createDocumentState } from "../../dist/document/index.js";
import { createWebDocumentSnapshot } from "../../dist/document/snapshot.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { resolveStyles } from "../../dist/presentation/style/index.js";
import { buildFragmentTree } from "../../dist/presentation/terminal/index.js";
import { terminalTextMeasurer } from "../../dist/ui/terminal-measure.js";

const SAMPLE_CASES = 60;
const PROFILE = Object.freeze({
  cellWidthPx: 8,
  rowHeightPx: 16,
  colorDepth: 24,
  unicode: true,
  ambiguousWidth: 1
});
const LIMITS_MS = Object.freeze({
  htmlParseP95: 75,
  documentIndexP95: 75,
  styleP95: 300,
  formattingP95: 150,
  fragmentationP95: 150,
  resizeP95: 150,
  searchP95: 25,
  largeNestedTotal: 5_000
});

function createBenchmarkHtml(index) {
  const listItems = Array.from(
    { length: 4 + (index % 5) },
    (_, itemIndex) => `<li>Item ${String(itemIndex + 1)} for case ${String(index)} <a href="/items/${String(index)}/${String(itemIndex)}">open</a></li>`
  ).join("");
  const tableRows = Array.from(
    { length: 3 + (index % 4) },
    (_, rowIndex) => `<tr><td>${String(rowIndex + 1)}</td><td>value-${String(index)}-${String(rowIndex)}</td></tr>`
  ).join("");
  return `<!doctype html><html><head><title>Benchmark ${String(index)}</title><style>
    :root { --ink: #18231f; --edge: #789186; }
    body { color: var(--ink); } main { display:block; max-width:60rem; margin-inline:auto; }
    .cards { display:grid; grid-template-columns:1fr 1fr; gap:1ch; }
    .card { border:1px solid var(--edge); padding-inline:1ch; }
    @media (max-width:50rem) { .cards { grid-template-columns:1fr; } }
  </style></head><body><main><h1>Case ${String(index)}</h1>
    <p>Deterministic structural presentation benchmark with links, lists, tables, and wrapping.</p>
    <section class="cards"><article class="card"><h2>Summary</h2><p>Responsive case.</p></article>
    <article class="card"><h2>Details</h2><p>Custom properties.</p></article></section>
    <ul>${listItems}</ul><table><thead><tr><th>Row</th><th>Value</th></tr></thead><tbody>${tableRows}</tbody></table>
    <pre>line one\n  line two\n\tline three</pre></main></body></html>`;
}

function nowNs() {
  return process.hrtime.bigint();
}

function durationMs(start) {
  return Number(nowNs() - start) / 1_000_000;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function time(values, operation) {
  const start = nowNs();
  const result = operation();
  values.push(durationMs(start));
  return result;
}

function styles(document, state) {
  return resolveStyles({
    document,
    state,
    resources: [],
    environment: {
      viewportWidthPx: 640,
      viewportHeightPx: 384,
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: true
    }
  });
}

function fragments(formatting, columns) {
  return buildFragmentTree({
    formatting,
    viewport: { columns, rows: 24 },
    measurer: terminalTextMeasurer(),
    profile: PROFILE
  });
}

const timings = {
  htmlParse: [],
  documentIndex: [],
  style: [],
  formatting: [],
  fragmentation: [],
  resize: [],
  search: []
};

for (let index = 1; index <= SAMPLE_CASES; index += 1) {
  const html = createBenchmarkHtml(index);
  const parsed = time(timings.htmlParse, () => parse(html, {
    scriptingMode: "disabled",
    captureSpans: true,
    sourceRetention: "text",
    trace: "none"
  }));
  const document = time(timings.documentIndex, () => createWebDocumentSnapshot(parsed, {
    requestUrl: `https://bench.example/case-${String(index)}`,
    finalUrl: `https://bench.example/case-${String(index)}`
  }));
  const state = createDocumentState(document);
  const style = time(timings.style, () => styles(document, state));
  const formatting = time(timings.formatting, () => buildFormattingTree({ document, state, styles: style }));
  const layout = time(timings.fragmentation, () => fragments(formatting, 80));
  const resized = time(timings.resize, () => fragments(formatting, 120));
  const matches = time(timings.search, () => layout.search("value"));
  if (style.outcome.status === "rejected" || formatting.outcome.status === "rejected"
    || layout.outcome.status === "rejected" || resized.outcome.status === "rejected"
    || layout.fragment(layout.root).kind !== "container" || matches.truncated) {
    throw new Error(`benchmark case ${String(index)} produced an invalid structural outcome`);
  }
}

const nestedDepth = 150;
const nestedHtml = `<main>${"<x-shell><div>".repeat(nestedDepth)}needle${"</div></x-shell>".repeat(nestedDepth)}</main>`;
const nestedStarted = nowNs();
const nestedDocument = createWebDocumentSnapshot(parse(nestedHtml, {
  scriptingMode: "disabled",
  captureSpans: true,
  sourceRetention: "text",
  trace: "none"
}), {
  requestUrl: "https://bench.example/nested",
  finalUrl: "https://bench.example/nested"
});
const nestedState = createDocumentState(nestedDocument);
const nestedStyle = styles(nestedDocument, nestedState);
const nestedFormatting = buildFormattingTree({ document: nestedDocument, state: nestedState, styles: nestedStyle });
const nestedFragments = fragments(nestedFormatting, 80);
const nestedSearch = nestedFragments.search("needle");
const largeNestedTotal = durationMs(nestedStarted);
if (nestedSearch.ranges.length !== 1) throw new Error("large nested benchmark lost searchable content");

const metrics = {
  htmlParseP95: percentile(timings.htmlParse, 0.95),
  documentIndexP95: percentile(timings.documentIndex, 0.95),
  styleP95: percentile(timings.style, 0.95),
  formattingP95: percentile(timings.formatting, 0.95),
  fragmentationP95: percentile(timings.fragmentation, 0.95),
  resizeP95: percentile(timings.resize, 0.95),
  searchP95: percentile(timings.search, 0.95),
  largeNestedTotal
};
const failures = Object.entries(LIMITS_MS)
  .filter(([name, limit]) => metrics[name] > limit)
  .map(([name, limit]) => `${name}=${metrics[name].toFixed(2)}ms exceeds ${String(limit)}ms`);
const report = {
  suite: "structural-pipeline-bench",
  timestamp: new Date().toISOString(),
  sampleCases: SAMPLE_CASES,
  nestedDepth,
  metricsMs: metrics,
  limitsMs: LIMITS_MS,
  ok: failures.length === 0,
  failures
};
const reportPath = resolve("reports/bench.json");
await mkdir(resolve("reports"), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(metrics)}\nbench report written: ${reportPath}\n`);
if (failures.length > 0) throw new Error(`performance controls failed: ${failures.join(", ")}`);
