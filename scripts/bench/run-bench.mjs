import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate as yieldImmediate } from "node:timers";

import { parse } from "@ismail-elkorchi/html-parser";

import { BrowserSession } from "../../dist/app/session.js";
import { createDocumentState } from "../../dist/document/index.js";
import { createIndexedWebDocumentSnapshot } from "../../dist/document/snapshot.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import {
  buildLayoutFragmentTree,
  cssCoordinate,
  cssLengthFromFixed,
  cssPx,
  cssRect,
  selectLogicalLines
} from "../../dist/presentation/layout/index.js";
import { buildTextSearchIndex } from "../../dist/presentation/search/index.js";
import { embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import {
  buildTerminalDisplayList,
  buildTerminalIndexes,
  rasterizeTerminalCells,
  rasterizeTerminalDisplayList
} from "../../dist/presentation/terminal/index.js";
import {
  bidiClass,
  bidiItemsFromText,
  bidiVisualOrderForLine,
  buildLineBreakMap,
  resolveBidiParagraph,
  resolveBidiText,
  segmentGraphemeClusters
} from "../../dist/unicode/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const SAMPLE_CASES = 60;
const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);
const CSS_TEXT_MEASURER = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);
const CELL_MEASURER = terminalCellMeasurer();
const LIMITS_MS = Object.freeze({
  htmlParseP95: 75,
  documentIndexP95: 75,
  styleP95: 300,
  formattingP95: 150,
  usedValueHeavyLayoutP95: 75,
  deepBlockFlowLayoutP95: 50,
  manyInlineLineBoxesP95: 150,
  completeCssLayoutP95: 75,
  displayListP95: 25,
  cellRasterizationP95: 75,
  indexConstructionP95: 75,
  resizeP95: 150,
  searchP95: 25,
  largeNestedTotal: 5_000,
  deeplyNestedContainingBlocks: 50,
  manyInlineTextBoxes: 4_000,
  longUnbreakableText: 1_000,
  largeTable: 3_000,
  manyFlexItems: 500,
  manyGridItems: 250,
  emptyHugeHeightBox: 100,
  hugeBorder: 100,
  manyActionBearingBoxes: 5_000,
  manySplitInlineBoxes: 5_000,
  compatibilityCorpusP95: 500,
  unicodePropertyLookupP95: 50,
  graphemeSegmentationP95: 250,
  bidiParagraphResolutionP95: 500,
  lineBreakMapConstructionP95: 500,
  lineSelectionP95: 150,
  visualRunConstructionP95: 100,
  unicodeLayoutIntegrationP95: 2_000,
  unicodeDisplayListConstructionP95: 100,
  unicodeCellRasterizationP95: 250
});
const LIMITS_MEMORY_MIB = Object.freeze({
  hundredThousandNodePeakHeapGrowth: 384,
  hundredThousandNodeRetainedHeap: 256,
  largeSourceAttributePeakHeapGrowth: 384,
  largeSourceAttributeRetainedHeap: 256,
  peakRssGrowth: 768,
  repeatedTabRetainedHeap: 64,
  closedSessionRetainedHeap: 32,
  layoutFragmentPeakHeapGrowth: 128,
  layoutFragmentRetainedHeap: 32,
  repeatedResizeRetainedHeap: 64
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
    <p>Deterministic structural rendering benchmark with links, lists, tables, and wrapping.</p>
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

async function layoutFragmentMemory(formatting) {
  await collectGarbage();
  const before = memory();
  const retainedLayouts = [];
  const peak = (() => {
    const layout = layoutFragments(formatting, 100);
    if (layout.outcome.status === "rejected") throw new Error("layout memory fixture was rejected");
    retainedLayouts.push(layout);
    return memory();
  })();
  await collectGarbage();
  const retained = memory();
  const releasedLayout = new WeakRef(retainedLayouts[0]);
  retainedLayouts.length = 0;
  await collectGarbage();
  const released = memory();
  return {
    peakHeapGrowth: mebibytes(Math.max(0, peak.heapUsed - before.heapUsed)),
    retainedHeap: mebibytes(Math.max(0, released.heapUsed - before.heapUsed)),
    liveHeap: mebibytes(Math.max(0, retained.heapUsed - before.heapUsed)),
    released: releasedLayout.deref() === undefined
  };
}

async function repeatedResizeMemory(formatting) {
  await collectGarbage();
  const before = memory();
  const inlineItemStreams = buildInlineItemStreamSet(formatting);
  for (let index = 0; index < 40; index += 1) {
    const columns = 40 + index * 2;
    const layout = layoutFragments(formatting, columns, inlineItemStreams);
    cellBuffer(displayList(layout, columns));
  }
  await collectGarbage();
  return mebibytes(Math.max(0, memory().heapUsed - before.heapUsed));
}

function styles(document, state) {
  return resolveStyles({
    document,
    state,
    resources: embeddedStylesheetSources(document),
    environment: {
      viewportWidthCssPx: 640,
      viewportHeightCssPx: 384,
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine"
    }
  });
}

function formattingFixture(html, name) {
  const document = createIndexedWebDocumentSnapshot(parse(html, {
    scriptingMode: "disabled",
    captureSpans: true,
    sourceRetention: "text",
    trace: "none"
  }), {
    requestUrl: `https://bench.example/${name}`,
    finalUrl: `https://bench.example/${name}`
  });
  const state = createDocumentState(document);
  return buildFormattingTree({ document, state, styles: styles(document, state) });
}

function layoutContext(columns, rows = 24) {
  const width = cssLengthFromFixed(columns * CELL_WIDTH);
  const height = cssLengthFromFixed(rows * ROW_HEIGHT);
  return {
    viewport: { width, height },
    textMeasurer: CSS_TEXT_MEASURER,
    initialContainingBlock: cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), width, height),
    scrollport: cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), width, height)
  };
}

function terminalContext(columns, rows = 24) {
  return {
    columns,
    rows,
    cellWidthCssPx: CELL_WIDTH,
    rowHeightCssPx: ROW_HEIGHT,
    colorDepth: 24,
    unicode: true,
    ambiguousWidth: 1,
    cellMeasurer: CELL_MEASURER
  };
}

const INLINE_ITEM_STREAM_CACHE = new WeakMap();
const TEXT_SEARCH_INDEX_CACHE = new WeakMap();

function inlineItemStreams(formatting) {
  let streams = INLINE_ITEM_STREAM_CACHE.get(formatting);
  if (streams === undefined) {
    streams = buildInlineItemStreamSet(formatting);
    INLINE_ITEM_STREAM_CACHE.set(formatting, streams);
  }
  return streams;
}

function textSearchIndex(formatting) {
  let index = TEXT_SEARCH_INDEX_CACHE.get(formatting);
  if (index === undefined) {
    index = buildTextSearchIndex(formatting, inlineItemStreams(formatting));
    TEXT_SEARCH_INDEX_CACHE.set(formatting, index);
  }
  return index;
}

function layoutFragments(formatting, columns, streams = inlineItemStreams(formatting)) {
  return buildLayoutFragmentTree({
    formatting,
    inlineItemStreams: streams,
    context: layoutContext(columns)
  });
}

function displayList(layout, columns) {
  return buildTerminalDisplayList({ layout, context: terminalContext(columns) });
}

function cellBuffer(list) {
  return rasterizeTerminalDisplayList({
    displayList: list,
    textSearchIndex: textSearchIndex(list.layout.formatting)
  });
}

function cellRasterization(list) {
  return rasterizeTerminalCells({
    displayList: list,
    textSearchIndex: textSearchIndex(list.layout.formatting)
  });
}

function terminalIndexes(list) {
  return buildTerminalIndexes({
    displayList: list,
    textSearchIndex: textSearchIndex(list.layout.formatting)
  });
}

const timings = {
  htmlParse: [],
  documentIndex: [],
  style: [],
  formatting: [],
  usedValueHeavyLayout: [],
  deepBlockFlowLayout: [],
  manyInlineLineBoxes: [],
  completeCssLayout: [],
  displayList: [],
  cellRasterization: [],
  indexConstruction: [],
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
  const streams = inlineItemStreams(formatting);
  textSearchIndex(formatting);
  const layout = time(timings.completeCssLayout, () => layoutFragments(formatting, 80, streams));
  const list = time(timings.displayList, () => displayList(layout, 80));
  time(timings.cellRasterization, () => cellRasterization(list));
  time(timings.indexConstruction, () => terminalIndexes(list));
  const terminal = cellBuffer(list);
  const resized = time(timings.resize, () => {
    const resizedLayout = layoutFragments(formatting, 120, streams);
    return cellBuffer(displayList(resizedLayout, 120));
  });
  const matches = time(timings.search, () => terminal.search("value"));
  if (style.outcome.status === "rejected" || formatting.outcome.status === "rejected"
    || layout.outcome.status === "rejected" || resized.cellBuffer.outcome.status === "rejected"
    || layout.fragment(layout.root).kind !== "box" || matches.truncated) {
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
const nestedLayout = layoutFragments(nestedFormatting, 80);
const nestedTerminal = cellBuffer(displayList(nestedLayout, 80));
const nestedSearch = nestedTerminal.search("needle");
const largeNestedTotal = durationMs(nestedStarted);
if (nestedSearch.matches.length !== 1 || nestedSearch.ranges.length === 0) {
  throw new Error("large nested benchmark lost its logical search match or visible cell spans");
}

const usedValueFormatting = formattingFixture(`<main>${Array.from(
  { length: 1_000 },
  (_, index) => `<div style="width:${String(20 + index % 70)}%;min-width:2ch;max-width:40ch;
    margin:${String(index % 5 - 2)}px auto;padding:2%;box-sizing:${index % 2 === 0 ? "content-box" : "border-box"}"></div>`
).join("")}</main>`, "computed-to-used-values");
const blockFormatting = formattingFixture(`<main>${"<div style='margin:1px 0;padding:1%'>".repeat(200)}block${"</div>".repeat(200)}</main>`, "block-layout");
const inlineFormatting = formattingFixture(`<p>${Array.from(
  { length: 2_000 },
  (_, index) => `<span style="font-size:${String(12 + index % 8)}px;vertical-align:${index % 2 === 0 ? "baseline" : "super"}">word </span>`
).join("")}</p>`, "line-boxes");
const usedValueInlineItemStreams = inlineItemStreams(usedValueFormatting);
const blockInlineItemStreams = inlineItemStreams(blockFormatting);
const inlineInlineItemStreams = inlineItemStreams(inlineFormatting);
for (let warmup = 0; warmup < 2; warmup += 1) {
  layoutFragments(usedValueFormatting, 100, usedValueInlineItemStreams);
  layoutFragments(blockFormatting, 100, blockInlineItemStreams);
  layoutFragments(inlineFormatting, 100, inlineInlineItemStreams);
}
for (let index = 0; index < 12; index += 1) {
  time(timings.usedValueHeavyLayout, () => layoutFragments(usedValueFormatting, 100, usedValueInlineItemStreams));
  time(timings.deepBlockFlowLayout, () => layoutFragments(blockFormatting, 100, blockInlineItemStreams));
  time(timings.manyInlineLineBoxes, () => layoutFragments(inlineFormatting, 100, inlineInlineItemStreams));
}

const workloadFormatting = {
  deeplyNestedContainingBlocks: formattingFixture(`<main>${"<div style='width:99%'>".repeat(300)}deep${"</div>".repeat(300)}</main>`, "deep-containing-blocks"),
  manyInlineTextBoxes: inlineFormatting,
  longUnbreakableText: formattingFixture(`<p>${"x".repeat(100_000)}</p>`, "long-unbreakable-text"),
  largeTable: formattingFixture(`<table>${Array.from({ length: 200 }, (_, row) => `<tr>${Array.from(
    { length: 10 }, (_, column) => `<td>${String(row)}-${String(column)}</td>`
  ).join("")}</tr>`).join("")}</table>`, "large-table"),
  manyFlexItems: formattingFixture(`<div style="display:flex;flex-wrap:wrap">${"<span>item</span>".repeat(1_000)}</div>`, "many-flex-items"),
  manyGridItems: formattingFixture(`<div style="display:grid;grid-template-columns:1fr 1fr 1fr">${"<span>item</span>".repeat(1_000)}</div>`, "many-grid-items"),
  emptyHugeHeightBox: formattingFixture(`<div style="height:1000000000px"></div>`, "empty-huge-height-box"),
  hugeBorder: formattingFixture(`<div style="height:1000000000px;border:1000000000px solid"></div>`, "huge-border"),
  manyActionBearingBoxes: formattingFixture(`<main>${Array.from(
    { length: 2_000 },
    (_, index) => `<a href="/${String(index)}" style="display:inline-block;padding:1px">action ${String(index)}</a>`
  ).join("")}</main>`, "many-action-bearing-boxes"),
  manySplitInlineBoxes: formattingFixture(`<main>${Array.from(
    { length: 1_000 },
    (_, index) => `<span style="padding:1px;border:1px solid">split inline ${String(index)} across lines </span>`
  ).join("")}</main>`, "many-split-inline-boxes")
};
const workloadMetrics = {};
const workloadStageMetrics = {};
for (const [name, formatting] of Object.entries(workloadFormatting)) {
  const streams = inlineItemStreams(formatting);
  for (let warmup = 0; warmup < 2; warmup += 1) {
    const layout = layoutFragments(formatting, 100, streams);
    cellBuffer(displayList(layout, 100));
  }
  const samples = {
    layoutFragmentConstruction: [],
    displayListConstruction: [],
    cellRasterization: [],
    indexConstruction: [],
    completeRendering: []
  };
  for (let sample = 0; sample < 7; sample += 1) {
    const layout = time(samples.layoutFragmentConstruction, () => layoutFragments(formatting, 100, streams));
    const list = time(samples.displayListConstruction, () => displayList(layout, 100));
    const cells = time(samples.cellRasterization, () => cellRasterization(list));
    time(samples.indexConstruction, () => terminalIndexes(list));
    const completeStarted = nowNs();
    const completeLayout = layoutFragments(formatting, 100, streams);
    const terminal = cellBuffer(displayList(completeLayout, 100));
    samples.completeRendering.push(durationMs(completeStarted));
    if (layout.outcome.status === "rejected" || cells.cellBuffer.outcome.status === "rejected"
      || terminal.cellBuffer.outcome.status === "rejected") {
      throw new Error(`${name} workload was rejected`);
    }
  }
  const stages = Object.fromEntries(Object.entries(samples).map(([stage, values]) => [stage, {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95)
  }]));
  workloadStageMetrics[name] = stages;
  workloadMetrics[name] = stages.completeRendering.p95;
}

const compatibilityCorpus = JSON.parse(await readFile(resolve("scripts/compat/corpus.json"), "utf8"));
const realPageCompatibilityMetrics = {};
const realPageCompatibilitySamples = [];
const compatibilityFormatting = async (fixture) => {
  const html = await readFile(resolve("scripts/compat", fixture.file), "utf8");
  const requestUrl = fixture.requestUrl ?? `https://compat.verge.test/${fixture.id}/index.html`;
  const declaredResources = fixture.resources
    ?? compatibilityCorpus.resourceSets?.[fixture.resourceSet]
    ?? [];
  const resourceByUrl = new Map(declaredResources.map((resource) => [resource.requestUrl, resource]));
  const session = new BrowserSession({
    defaultParseMode: "text",
    ...(fixture.stylesheetPolicy === undefined ? {} : { stylesheetPolicy: fixture.stylesheetPolicy }),
    loader: async (url) => ({
      requestUrl: url,
      finalUrl: url,
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      html,
      responseFields: [],
      networkOutcome: {
        kind: "ok", finalUrl: url, status: 200, statusText: "OK",
        detailCode: "HTTP_200", detailMessage: "200 OK"
      },
      fetchedAtIso: "2026-08-27T00:00:00.000Z"
    }),
    streamLoader: async () => {
      throw new Error("Compatibility benchmarks use buffered offline fixtures.");
    },
    stylesheetLoader: async (url) => {
      const resource = resourceByUrl.get(url);
      if (resource === undefined) throw new Error(`Unexpected compatibility stylesheet request: ${url}`);
      return {
        requestUrl: url,
        finalUrl: resource.finalUrl ?? url,
        contentType: "text/css",
        bytes: await readFile(resolve("scripts/compat", resource.file)),
        responseFields: [],
        ...(resource.transportEncodingLabel === undefined
          ? {}
          : { transportEncodingLabel: resource.transportEncodingLabel })
      };
    }
  });
  try {
    const snapshot = await session.open(requestUrl);
    const state = createDocumentState(snapshot.document);
    const style = resolveStyles({
      document: snapshot.document,
      state,
      resources: snapshot.stylesheets,
      initialDiagnostics: snapshot.styleDiagnostics,
      environment: {
        viewportWidthCssPx: 960,
        viewportHeightCssPx: 384,
        mediaType: "screen",
        prefersColorScheme: "dark",
        reducedMotion: false,
        hover: "hover",
        pointer: "fine"
      }
    });
    return buildFormattingTree({ document: snapshot.document, state, styles: style });
  } finally {
    await session.close();
  }
};
for (const fixture of compatibilityCorpus.fixtures) {
  const formatting = await compatibilityFormatting(fixture);
  const streams = inlineItemStreams(formatting);
  const render = () => {
    const layout = layoutFragments(formatting, 120, streams);
    const terminal = cellBuffer(displayList(layout, 120));
    if (layout.outcome.status === "rejected" || terminal.cellBuffer.outcome.status === "rejected") {
      throw new Error(`${fixture.id} compatibility benchmark was rejected`);
    }
  };
  for (let warmup = 0; warmup < 2; warmup += 1) render();
  const samples = [];
  for (let sample = 0; sample < 7; sample += 1) time(samples, render);
  realPageCompatibilitySamples.push(...samples);
  realPageCompatibilityMetrics[fixture.id] = Object.freeze({
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95)
  });
}

function repeatedStage(operation, samples = 7) {
  for (let warmup = 0; warmup < 2; warmup += 1) operation();
  const values = [];
  for (let sample = 0; sample < samples; sample += 1) time(values, operation);
  return Object.freeze({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
}

const unicodePropertyPoints = Array.from(
  { length: 100_000 },
  (_, index) => [0x41, 0x5d0, 0x627, 0x1f469, 0x4e00][index % 5]
);
const unicodeGraphemeText = "a\u0301👩🏽‍🚀🇲🇦界".repeat(5_000);
const unicodeMixedText = "Latin العربية עברית 123 (text) ".repeat(1_000);
const unicodeBidiItems = bidiItemsFromText(unicodeMixedText, () => null);
const unicodeResolvedParagraph = resolveBidiParagraph(unicodeBidiItems, "auto");
if (unicodeResolvedParagraph.outcome.status !== "complete") {
  throw new Error("Unicode bidi benchmark paragraph was not complete");
}
const unicodeLineItems = Array.from({ length: 50_000 }, (_, logicalIndex) => Object.freeze({
  logicalIndex,
  advance: CELL_WIDTH,
  tabInterval: null,
  breakBefore: logicalIndex === 0 ? "prohibited" : "allowed",
  forcedBreak: false,
  collapsibleSpace: false,
  wrappingAllowed: true
}));
const unicodeLayoutFormatting = formattingFixture(`<p>${Array.from(
  { length: 500 },
  (_, index) => `<span>${index % 3 === 0 ? "العربية" : index % 3 === 1 ? "עברית" : "Latin"} ${String(index)} </span>`
).join("")}</p>`, "unicode-inline-layout");
const unicodeLayoutInlineItemStreams = inlineItemStreams(unicodeLayoutFormatting);
const unicodeLayout = layoutFragments(unicodeLayoutFormatting, 100, unicodeLayoutInlineItemStreams);
const unicodeDisplayList = displayList(unicodeLayout, 100);
const unicodeStageMetrics = {
  unicodePropertyLookup: repeatedStage(() => {
    let strong = 0;
    for (const point of unicodePropertyPoints) if (bidiClass(point) === "L") strong += 1;
    if (strong === 0) throw new Error("Unicode property benchmark produced no strong left-to-right values");
  }),
  graphemeSegmentation: repeatedStage(() => {
    const stream = segmentGraphemeClusters(unicodeGraphemeText);
    if (stream.outcome.status !== "complete") throw new Error("Unicode grapheme benchmark was truncated");
  }),
  bidiParagraphResolution: repeatedStage(() => {
    const paragraph = resolveBidiParagraph(unicodeBidiItems, "auto");
    if (paragraph.outcome.status !== "complete") throw new Error("Unicode bidi benchmark was truncated");
  }),
  lineBreakMapConstruction: repeatedStage(() => {
    const map = buildLineBreakMap(unicodeMixedText);
    if (map.outcome.status !== "complete") throw new Error("Unicode line-break benchmark was truncated");
  }),
  lineSelection: repeatedStage(() => {
    const selection = selectLogicalLines(unicodeLineItems, cssPx(800), cssPx(800));
    if (selection.outcome.status !== "complete") throw new Error("Unicode line-selection benchmark was truncated");
  }),
  visualRunConstruction: repeatedStage(() => {
    const visual = bidiVisualOrderForLine(
      unicodeResolvedParagraph,
      0,
      unicodeResolvedParagraph.items.length
    );
    if (visual.runs.length === 0) throw new Error("Unicode visual-run benchmark produced no runs");
  }),
  unicodeLayoutIntegration: repeatedStage(() => {
    const layout = layoutFragments(unicodeLayoutFormatting, 100, unicodeLayoutInlineItemStreams);
    if (layout.outcome.status === "rejected") throw new Error("Unicode layout integration benchmark was rejected");
  }),
  unicodeDisplayListConstruction: repeatedStage(() => {
    const list = displayList(unicodeLayout, 100);
    if (list.outcome.status === "rejected") throw new Error("Unicode display-list benchmark was rejected");
  }),
  unicodeCellRasterization: repeatedStage(() => {
    const cells = cellRasterization(unicodeDisplayList);
    if (cells.cellBuffer.outcome.status === "rejected") throw new Error("Unicode cell-rasterization benchmark was rejected");
  })
};

const unicodeStressControls = {};
{
  const started = nowNs();
  const paragraph = resolveBidiText("a".repeat(1_000_000), "ltr");
  if (paragraph.outcome.status !== "complete" || paragraph.items.length !== 1_000_000) {
    throw new Error("one-million-code-point bidi stress control was not complete");
  }
  unicodeStressControls.oneMillionLtrCodePoints = durationMs(started);
}
{
  const cases = {
    mixedArabicLatin: "Latin العربية 123 עברית ".repeat(10_000),
    manyIsolates: "\u2067עברית\u2069\u2066Latin\u2069".repeat(10_000),
    maximumEmbeddingDepth: `${"\u202b".repeat(63)}A${"\u202c".repeat(63)}`
  };
  for (const [name, value] of Object.entries(cases)) {
    const started = nowNs();
    const paragraph = resolveBidiText(value, "auto");
    if (paragraph.outcome.status !== "complete") throw new Error(`${name} bidi stress control was truncated`);
    unicodeStressControls[name] = durationMs(started);
  }
}
for (const [name, value] of Object.entries({
  largeCjk: "漢字仮名交じり文。".repeat(10_000),
  emojiHeavy: "👩🏽‍🚀🇲🇦👍🏽".repeat(10_000)
})) {
  const started = nowNs();
  const clusters = segmentGraphemeClusters(value);
  const breaks = buildLineBreakMap(value, { preserveGraphemeClusters: true }, {
    graphemeClusterBoundaries: [0, ...clusters.clusters.map((cluster) => cluster.endCodeUnit)]
  });
  if (clusters.outcome.status !== "complete" || breaks.outcome.status !== "complete") {
    throw new Error(`${name} Unicode stress control was truncated`);
  }
  unicodeStressControls[name] = durationMs(started);
}
{
  const started = nowNs();
  const formatting = formattingFixture(`<p>${Array.from(
    { length: 2_000 },
    (_, index) => `<span>${index % 2 === 0 ? "العربية" : "Latin"} ${String(index)} </span>`
  ).join("")}</p>`, "many-short-bidi-inline-boxes");
  const streams = inlineItemStreams(formatting);
  const layout = layoutFragments(formatting, 100, streams);
  if (layout.outcome.status === "rejected") throw new Error("many short bidi inline boxes were rejected");
  unicodeStressControls.manyShortInlineBoxes = durationMs(started);
}
{
  const started = nowNs();
  for (let index = 0; index < 30; index += 1) {
    const columns = 40 + index * 2;
    const layout = layoutFragments(unicodeLayoutFormatting, columns, unicodeLayoutInlineItemStreams);
    cellBuffer(displayList(layout, columns));
  }
  unicodeStressControls.repeatedResizeWithInvariantAnalysis = durationMs(started);
}
await collectGarbage();

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
const layoutFragmentsMemory = await layoutFragmentMemory(inlineFormatting);
const repeatedResizeRetainedHeap = await repeatedResizeMemory(inlineFormatting);

const metrics = {
  htmlParseP95: percentile(timings.htmlParse, 0.95),
  documentIndexP95: percentile(timings.documentIndex, 0.95),
  styleP95: percentile(timings.style, 0.95),
  formattingP95: percentile(timings.formatting, 0.95),
  usedValueHeavyLayoutP95: percentile(timings.usedValueHeavyLayout, 0.95),
  deepBlockFlowLayoutP95: percentile(timings.deepBlockFlowLayout, 0.95),
  manyInlineLineBoxesP95: percentile(timings.manyInlineLineBoxes, 0.95),
  completeCssLayoutP95: percentile(timings.completeCssLayout, 0.95),
  displayListP95: percentile(timings.displayList, 0.95),
  cellRasterizationP95: percentile(timings.cellRasterization, 0.95),
  indexConstructionP95: percentile(timings.indexConstruction, 0.95),
  resizeP95: percentile(timings.resize, 0.95),
  searchP95: percentile(timings.search, 0.95),
  largeNestedTotal,
  unicodePropertyLookupP95: unicodeStageMetrics.unicodePropertyLookup.p95,
  graphemeSegmentationP95: unicodeStageMetrics.graphemeSegmentation.p95,
  bidiParagraphResolutionP95: unicodeStageMetrics.bidiParagraphResolution.p95,
  lineBreakMapConstructionP95: unicodeStageMetrics.lineBreakMapConstruction.p95,
  lineSelectionP95: unicodeStageMetrics.lineSelection.p95,
  visualRunConstructionP95: unicodeStageMetrics.visualRunConstruction.p95,
  unicodeLayoutIntegrationP95: unicodeStageMetrics.unicodeLayoutIntegration.p95,
  unicodeDisplayListConstructionP95: unicodeStageMetrics.unicodeDisplayListConstruction.p95,
  unicodeCellRasterizationP95: unicodeStageMetrics.unicodeCellRasterization.p95,
  compatibilityCorpusP95: percentile(realPageCompatibilitySamples, 0.95),
  ...workloadMetrics
};
const memoryMetrics = {
  hundredThousandNodePeakHeapGrowth: hundredThousandNodes.peakHeapGrowth,
  hundredThousandNodeRetainedHeap: hundredThousandNodes.retainedHeap,
  largeSourceAttributePeakHeapGrowth: largeSourceAttributes.peakHeapGrowth,
  largeSourceAttributeRetainedHeap: largeSourceAttributes.retainedHeap,
  peakRssGrowth: Math.max(hundredThousandNodes.rssGrowth, largeSourceAttributes.rssGrowth),
  repeatedTabRetainedHeap: lifecycle.repeatedTabRetainedHeap,
  closedSessionRetainedHeap: lifecycle.closedSessionRetainedHeap,
  layoutFragmentPeakHeapGrowth: layoutFragmentsMemory.peakHeapGrowth,
  layoutFragmentRetainedHeap: layoutFragmentsMemory.retainedHeap,
  repeatedResizeRetainedHeap
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
if (!layoutFragmentsMemory.released) failures.push("released layout fragments remained reachable after forced GC");
const report = {
  suite: "structural-pipeline-bench",
  timestamp: new Date().toISOString(),
  sampleCases: SAMPLE_CASES,
  nestedDepth,
  metricsMs: metrics,
  stressWorkloadStageMetricsMs: workloadStageMetrics,
  realPageCompatibilityMetricsMs: realPageCompatibilityMetrics,
  unicodeTextStageMetricsMs: unicodeStageMetrics,
  unicodeStressControlsMs: unicodeStressControls,
  limitsMs: LIMITS_MS,
  metricsMemoryMiB: memoryMetrics,
  limitsMemoryMiB: LIMITS_MEMORY_MIB,
  closedSessionCollected: lifecycle.closedSessionCollected,
  releasedLargeDocumentsCollected: hundredThousandNodes.released && largeSourceAttributes.released,
  releasedLayoutFragmentsCollected: layoutFragmentsMemory.released,
  reviewedPr129BaselineMs: {
    fragmentationP95: 7.148973,
    resizeP95: 5.855096,
    searchP95: 0.342621,
    largeNestedTotal: 118.338073
  },
  thresholdBasis: {
    existingControls: "PR #129 limits for parsing, indexing, style, formatting, resize, search, nested work, and lifecycle memory are unchanged.",
    fixedPointControls: "PR #130 fixed-point workload limits remain unchanged; cell rasterization and index construction are now measured independently.",
    stressControls: "Every rendering stress workload is warmed and reports p50 and p95 separately for layout fragment construction, display-list construction, cell rasterization, index construction, and complete rendering.",
    unicodeTextControls: "Unicode stage limits are new workload-specific controls measured after two warmups; PR #130 thresholds remain unchanged. One-shot controls cover one million LTR code points, mixed scripts, isolates, maximum valid embedding depth, CJK, emoji, and repeated resize with cached invariant text analysis.",
    compatibilityCorpus: "Every offline compatibility fixture is warmed twice and measured over seven complete native renderings; the new 500ms p95 control is above the measured corpus distribution without changing an existing threshold."
  },
  ok: failures.length === 0,
  failures
};
const reportPath = resolve("reports/bench.json");
await mkdir(resolve("reports"), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ metricsMs: metrics, metricsMemoryMiB: memoryMetrics })}\nbench report written: ${reportPath}\n`);
if (failures.length > 0) throw new Error(`performance controls failed: ${failures.join(", ")}`);
