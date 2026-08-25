import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate as yieldImmediate } from "node:timers";

import { parse } from "@ismail-elkorchi/html-parser";

import { BrowserSession } from "../../dist/app/session.js";
import { createDocumentState } from "../../dist/document/index.js";
import { createIndexedWebDocumentSnapshot } from "../../dist/document/snapshot.js";
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
const LIMITS_MEMORY_MIB = Object.freeze({
  hundredThousandNodePeakHeapGrowth: 384,
  hundredThousandNodeRetainedHeap: 256,
  largeSourceAttributePeakHeapGrowth: 384,
  largeSourceAttributeRetainedHeap: 256,
  peakRssGrowth: 768,
  repeatedTabRetainedHeap: 64,
  closedSessionRetainedHeap: 32
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

function memory() {
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss };
}

async function collectGarbage() {
  if (typeof globalThis.gc !== "function") throw new Error("memory controls require node --expose-gc");
  for (let index = 0; index < 4; index += 1) {
    globalThis.gc();
    await new Promise((resolvePromise) => yieldImmediate(resolvePromise));
  }
}

function mebibytes(bytes) {
  return bytes / (1024 * 1024);
}

function countDocumentNodes(document) {
  let count = 0;
  const pending = [document.root];
  while (pending.length > 0) {
    const ref = pending.pop();
    if (ref === undefined) continue;
    count += 1;
    pending.push(...document.node(ref).children);
  }
  return count;
}

function releaseRetainedDocument(documents, url) {
  const document = documents[0];
  if (document === undefined) throw new Error(`${url} did not retain its authoritative document`);
  const released = new WeakRef(document);
  documents.length = 0;
  return released;
}

async function documentMemory(html, url, expectedNodes) {
  await collectGarbage();
  const before = memory();
  const retainedDocuments = [];
  const peak = (() => {
    const parsed = parse(html, {
      scriptingMode: "disabled",
      captureSpans: true,
      sourceRetention: "text",
      trace: "none",
      budgets: {
        maxInputBytes: 64 * 1024 * 1024,
        maxDecodedUtf8Bytes: 64 * 1024 * 1024,
        maxNodes: 150_000,
        maxSteps: 20_000_000,
        maxAttributesPerElement: 32,
        maxAttributeBytes: 2 * 1024
      }
    });
    const document = createIndexedWebDocumentSnapshot(parsed, { requestUrl: url, finalUrl: url });
    const nodes = countDocumentNodes(document);
    if (nodes < expectedNodes) {
      throw new Error(`${url} retained ${String(nodes)} nodes; expected ${String(expectedNodes)}`);
    }
    retainedDocuments.push(document);
    return memory();
  })();
  await collectGarbage();
  const retained = memory();
  const releasedDocument = releaseRetainedDocument(retainedDocuments, url);
  await collectGarbage();
  const released = memory();
  return {
    peakHeapGrowth: mebibytes(Math.max(0, peak.heapUsed - before.heapUsed)),
    retainedHeap: mebibytes(Math.max(0, retained.heapUsed - before.heapUsed)),
    releasedHeap: mebibytes(Math.max(0, released.heapUsed - before.heapUsed)),
    rssGrowth: mebibytes(Math.max(0, peak.rss - before.rss)),
    released: releasedDocument.deref() === undefined
  };
}

async function sessionLifecycleMemory() {
  const pageHtml = `<title>Lifecycle</title><main>${"<p data-value='retained'>tab content</p>".repeat(500)}</main>`;
  const loader = async (requestUrl) => ({
    requestUrl,
    finalUrl: requestUrl,
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    html: pageHtml,
    responseFields: [],
    networkOutcome: {
      kind: "ok",
      finalUrl: requestUrl,
      status: 200,
      statusText: "OK",
      detailCode: "HTTP_200",
      detailMessage: "200 OK"
    },
    fetchedAtIso: "2026-01-01T00:00:00.000Z"
  });
  const openAndClose = async (index) => {
    const session = new BrowserSession({ loader, defaultParseMode: "text" });
    const snapshot = await session.open(`https://bench.example/tab-${String(index)}`);
    const document = new WeakRef(snapshot.document);
    await session.close();
    return document;
  };
  await collectGarbage();
  const before = memory();
  let lastDocument = null;
  for (let index = 0; index < 30; index += 1) {
    lastDocument = await openAndClose(index);
  }
  await collectGarbage();
  const afterTabs = memory();
  for (let index = 0; index < 8; index += 1) await collectGarbage();
  const afterClose = memory();
  return {
    repeatedTabRetainedHeap: mebibytes(Math.max(0, afterTabs.heapUsed - before.heapUsed)),
    closedSessionRetainedHeap: mebibytes(Math.max(0, afterClose.heapUsed - before.heapUsed)),
    closedSessionCollected: lastDocument?.deref() === undefined
  };
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
  const document = time(timings.documentIndex, () => createIndexedWebDocumentSnapshot(parsed, {
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
const nestedDocument = createIndexedWebDocumentSnapshot(parse(nestedHtml, {
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

const hundredThousandNodeHtml = `<main>${"<span>x</span>".repeat(50_000)}</main>`;
const hundredThousandNodes = await documentMemory(
  hundredThousandNodeHtml,
  "https://bench.example/100k-nodes",
  100_000
);
const largeSourceAttributeHtml = `<main>${Array.from(
  { length: 10_000 },
  (_, index) => `<div data-index="${String(index)}" data-payload="${"a".repeat(512)}">value</div>`
).join("")}</main>`;
const largeSourceAttributes = await documentMemory(
  largeSourceAttributeHtml,
  "https://bench.example/large-source-attributes",
  20_000
);
const lifecycle = await sessionLifecycleMemory();

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
const memoryMetrics = {
  hundredThousandNodePeakHeapGrowth: hundredThousandNodes.peakHeapGrowth,
  hundredThousandNodeRetainedHeap: hundredThousandNodes.retainedHeap,
  largeSourceAttributePeakHeapGrowth: largeSourceAttributes.peakHeapGrowth,
  largeSourceAttributeRetainedHeap: largeSourceAttributes.retainedHeap,
  peakRssGrowth: Math.max(hundredThousandNodes.rssGrowth, largeSourceAttributes.rssGrowth),
  repeatedTabRetainedHeap: lifecycle.repeatedTabRetainedHeap,
  closedSessionRetainedHeap: lifecycle.closedSessionRetainedHeap
};
const failures = Object.entries(LIMITS_MS)
  .filter(([name, limit]) => metrics[name] > limit)
  .map(([name, limit]) => `${name}=${metrics[name].toFixed(2)}ms exceeds ${String(limit)}ms`);
for (const [name, limit] of Object.entries(LIMITS_MEMORY_MIB)) {
  if (memoryMetrics[name] > limit) failures.push(`${name}=${memoryMetrics[name].toFixed(2)}MiB exceeds ${String(limit)}MiB`);
}
if (!lifecycle.closedSessionCollected) failures.push("closed BrowserSession retained its final document after forced GC");
if (!hundredThousandNodes.released || !largeSourceAttributes.released) {
  failures.push("a released large document remained reachable after forced GC");
}
const report = {
  suite: "structural-pipeline-bench",
  timestamp: new Date().toISOString(),
  sampleCases: SAMPLE_CASES,
  nestedDepth,
  metricsMs: metrics,
  limitsMs: LIMITS_MS,
  metricsMemoryMiB: memoryMetrics,
  limitsMemoryMiB: LIMITS_MEMORY_MIB,
  closedSessionCollected: lifecycle.closedSessionCollected,
  releasedLargeDocumentsCollected: hundredThousandNodes.released && largeSourceAttributes.released,
  ok: failures.length === 0,
  failures
};
const reportPath = resolve("reports/bench.json");
await mkdir(resolve("reports"), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ metricsMs: metrics, metricsMemoryMiB: memoryMetrics })}\nbench report written: ${reportPath}\n`);
if (failures.length > 0) throw new Error(`performance controls failed: ${failures.join(", ")}`);
