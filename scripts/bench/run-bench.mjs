import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate as yieldImmediate } from "node:timers";

import { parse } from "@ismail-elkorchi/html-parser";

import { BrowserSession } from "../../dist/app/session.js";
import { createDocumentState } from "../../dist/document/index.js";
import { createIndexedWebDocumentSnapshot } from "../../dist/document/snapshot.js";
import { associateTableHeaders } from "../../dist/document/table/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import {
  buildLayoutFragmentTree,
  cssCoordinate,
  cssLengthFromFixed,
  cssMultiply,
  cssPx,
  cssRect,
  selectLogicalLines
} from "../../dist/presentation/layout/index.js";
import {
  expandExplicitGridAxis,
  placeGridItems,
  sizeGridTracks
} from "../../dist/presentation/layout/grid/index.js";
import {
  buildCollapsedTableBorderGraph,
  buildCollapsedTableBorderSegments,
  buildTableSlotGrid,
  distributeTableWidth,
  measureTableColumns,
  resolveCollapsedBorderConflictSets,
  sizeTableRows
} from "../../dist/presentation/layout/table/index.js";
import { buildTextSearchIndex, projectTextSearchToLayout } from "../../dist/presentation/search/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import {
  GRID_AUTO_LINE,
  parseGridLine,
  parseGridTrackList
} from "../../dist/presentation/style/grid/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import {
  buildDisplayListSpatialIndex,
  buildDocumentGeometryIndex,
  buildDocumentDisplayList,
  buildViewportDisplayList,
  buildViewportTerminalResult,
  rasterizeViewportDisplayList
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
const PERCENTILE_SAMPLE_COUNT = 21;
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
  unicodeCellRasterizationP95: 250,
  gridValueParsingP95: 100,
  explicitGridConstructionP95: 100,
  gridNamedLineResolutionP95: 250,
  gridAutoPlacementP95: 500,
  gridSparseLockedAxisPlacementP95: 500,
  gridDensePlacementP95: 1_000,
  gridNonSpanningIntrinsicSizingP95: 500,
  gridSpanningIntrinsicSizingP95: 500,
  gridPlannedIncreaseDistributionP95: 500,
  gridFlexibleTrackSizingP95: 500,
  gridCollapsedGutterConstructionP95: 500,
  gridColumnTrackSizingP95: 500,
  gridRowTrackSizingP95: 500,
  gridItemLayoutP95: 2_000,
  gridContainerOrchestrationP95: 2_000,
  completeGridLayoutP95: 2_000,
  gridDisplayListConstructionP95: 500,
  gridCellRasterizationP95: 1_000,
  gridAutoRepeatResizeP95: 2_000,
  gridAutoPlacement1000: 5_000,
  gridDensePlacement1000: 5_000,
  gridSpanningItems500: 5_000,
  gridExplicitTracks1000: 5_000,
  nestedGrids: 5_000,
  gridAutoFitProductListing: 5_000,
  gridOverlappingItems: 5_000,
  gridManyNamedLines: 5_000,
  gridEqualSpanItems: 5_000,
  gridOverlappingSpans: 5_000,
  gridSpanGroups: 5_000,
  gridGrowthLimits: 5_000,
  gridSparseFrontiers: 5_000,
  gridCollapsedAutoFitTracks: 5_000,
  tableMetadataIndexingP95: 500,
  tableHeaderAssociationP95: 500,
  tableAutomaticHeaderAssociationP95: 500,
  tableSlotGridConstructionP95: 500,
  tableCellIntrinsicMeasurementP95: 500,
  tableColumnMeasureAggregationP95: 1_000,
  tableColspanPlanningP95: 1_000,
  tableAutomaticWidthDistributionP95: 500,
  tableFixedWidthDistributionP95: 500,
  tableFirstCellLayoutPassP95: 3_000,
  tableRowHeightAndRowspanDistributionP95: 1_000,
  tableRowspanPlanningP95: 1_000,
  tableSecondCellLayoutPassP95: 3_000,
  tableCollapsedBorderGraphConstructionP95: 2_000,
  tableCollapsedBorderConflictSetsP95: 2_000,
  tablePaintSegmentGenerationP95: 1_000,
  tableDisplayListConstructionP95: 1_000,
  tableCellRasterizationP95: 2_000,
  completeTableLayoutP95: 3_000,
  tableRepeatedResizeP95: 5_000,
  tableOrdinaryCells10000P95: 15_000,
  tableColspanStressP95: 5_000,
  tableRowspanStressP95: 5_000,
  tableWideStressP95: 5_000,
  tableNestedStressP95: 5_000,
  tableColumnGroupStressP95: 5_000,
  tableCollapsedBorderStressP95: 5_000
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
  repeatedResizeRetainedHeap: 64,
  gridLayoutFragmentPeakHeapGrowth: 192,
  gridLayoutFragmentRetainedHeap: 48,
  gridRepeatedResizeRetainedHeap: 64,
  tableLayoutFragmentPeakHeapGrowth: 256,
  tableLayoutFragmentRetainedHeap: 64,
  tableRepeatedResizeRetainedHeap: 64
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

function retainArtifactGraphForRelease() {
  const parsed = parse(`<style>p{margin:0}</style><main>${"<p>retained artifact graph</p>".repeat(500)}</main>`, {
    scriptingMode: "disabled",
    captureSpans: true,
    sourceRetention: "text",
    trace: "none",
  });
  const document = createIndexedWebDocumentSnapshot(parsed, {
    requestUrl: "https://bench.example/artifact-release",
    finalUrl: "https://bench.example/artifact-release",
  });
  const store = new RenderArtifactStore();
  store.attach({
    documentId: "artifact-release",
    documentRevision: 1,
    stateRevision: 1,
    document,
    state: createDocumentState(document),
    resources: embeddedStylesheetSources(document),
  });
  const artifacts = store.analyze({
    documentId: "artifact-release",
    documentRevision: 1,
    mediaEnvironment: {
      viewportWidthCssPx: 640,
      viewportHeightCssPx: 384,
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine",
    },
    layoutContext: layoutContext(80),
    terminalContext: terminalContext(80),
  });
  return { store, artifacts: new WeakRef(artifacts), retainedCost: artifacts.retainedCost };
}

async function artifactStoreLifecycleMemory() {
  await collectGarbage();
  const before = memory();
  const retained = retainArtifactGraphForRelease();
  await collectGarbage();
  const live = memory();
  retained.store.release("artifact-release");
  retained.store.dispose();
  await collectGarbage();
  const released = memory();
  return {
    estimatedRetainedBytes: retained.retainedCost,
    liveHeap: mebibytes(Math.max(0, live.heapUsed - before.heapUsed)),
    releasedHeap: mebibytes(Math.max(0, released.heapUsed - before.heapUsed)),
    released: retained.artifacts.deref() === undefined,
    metricsAfterRelease: retained.store.metrics(),
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
  const resources = embeddedStylesheetSources(document);
  return resolveStyles({
    program: compileStylesheetProgram({ document, resources }),
    state,
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

function formattingNodeOfKind(formatting, kind) {
  const pending = [formatting.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) continue;
    const node = formatting.node(id);
    if (node.kind === kind) return node;
    pending.push(...node.children);
  }
  throw new Error(`benchmark formatting tree has no ${kind} box`);
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
  return buildDocumentDisplayList({ layout, context: terminalContext(columns) });
}

function viewportDisplayList(list, scrollRow = 0) {
  return buildViewportDisplayList({
    documentDisplayList: list,
    spatialIndex: buildDisplayListSpatialIndex(list),
    context: list.context,
    window: {
      scrollRow,
      viewportRows: list.context.rows,
      overscanBefore: 0,
      overscanAfter: 0
    }
  });
}

function cellRasterization(list) {
  return rasterizeViewportDisplayList({ displayList: viewportDisplayList(list) });
}

function terminalIndexes(list, query = null) {
  const viewport = viewportDisplayList(list);
  const cells = rasterizeViewportDisplayList({ displayList: viewport });
  return buildViewportTerminalResult({
    displayList: viewport,
    cellBuffer: cells.cellBuffer,
    documentGeometry: buildDocumentGeometryIndex(list),
    ...(query === null ? {} : {
      searchProjection: projectTextSearchToLayout(
        textSearchIndex(list.layout.formatting),
        list.layout,
        query,
        10_000
      )
    }),
    truncations: cells.truncations
  });
}

function cellBuffer(list, query = null) {
  return terminalIndexes(list, query);
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
  const terminal = cellBuffer(list, "value");
  const resized = time(timings.resize, () => {
    const resizedLayout = layoutFragments(formatting, 120, streams);
    return cellBuffer(displayList(resizedLayout, 120));
  });
  const matches = time(timings.search, () => terminal.search);
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
const nestedTerminal = cellBuffer(displayList(nestedLayout, 80), "needle");
const nestedSearch = nestedTerminal.search;
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
for (let index = 0; index < PERCENTILE_SAMPLE_COUNT; index += 1) {
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
  ).join("")}</main>`, "many-split-inline-boxes"),
  gridAutoPlacement1000: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(20,1fr);grid-auto-rows:16px">${Array.from(
    { length: 1_000 }, (_, index) => `<span>auto ${String(index)}</span>`
  ).join("")}</div>`, "grid-auto-placement-1000"),
  gridDensePlacement1000: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(20,1fr);grid-auto-rows:16px;grid-auto-flow:row dense">${Array.from(
    { length: 1_000 },
    (_, index) => `<span style="${index % 7 === 0 ? "grid-column:span 3" : index % 7 === 1 ? "grid-column:2" : ""}">dense ${String(index)}</span>`
  ).join("")}</div>`, "grid-dense-placement-1000"),
  gridSpanningItems500: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(50,minmax(8px,1fr));grid-auto-rows:16px">${Array.from(
    { length: 500 }, (_, index) => `<span style="grid-column:span ${String(2 + index % 9)}">span ${String(index)}</span>`
  ).join("")}</div>`, "grid-spanning-items-500"),
  gridExplicitTracks1000: formattingFixture(`<div style="display:grid;width:1000px;grid-template-columns:repeat(1000,1px)"><span>explicit tracks</span></div>`, "grid-explicit-tracks-1000"),
  nestedGrids: formattingFixture(`${"<div style='display:grid;grid-template-columns:minmax(8px,1fr) 1fr'>".repeat(30)}nested Grid${"</div>".repeat(30)}`, "nested-grids"),
  gridAutoFitProductListing: formattingFixture(`<main style="display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:8px">${Array.from(
    { length: 1_000 }, (_, index) => `<article>product ${String(index)}</article>`
  ).join("")}</main>`, "grid-auto-fit-product-listing"),
  gridOverlappingItems: formattingFixture(`<div style="display:grid;grid-template-columns:1fr;grid-template-rows:32px">${Array.from(
    { length: 1_000 }, (_, index) => `<span style="grid-column:1;grid-row:1;z-index:${String(index % 7)}">overlap ${String(index)}</span>`
  ).join("")}</div>`, "grid-overlapping-items"),
  gridManyNamedLines: formattingFixture(`<div style="display:grid;width:1000px;grid-template-columns:${Array.from(
    { length: 1_000 }, (_, index) => `[line-${String(index)}] 1px`
  ).join(" ")} [line-end]"><span style="grid-column:line-500/line-end">named lines</span></div>`, "grid-many-named-lines"),
  gridEqualSpanItems: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(50,minmax(auto,1fr))">${Array.from(
    { length: 500 }, (_, index) => `<span style="grid-column:span 5">equal span ${String(index)}</span>`
  ).join("")}</div>`, "grid-equal-span-items"),
  gridOverlappingSpans: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(50,minmax(auto,1fr))">${Array.from(
    { length: 500 }, (_, index) => `<span style="grid-column:${String(1 + index % 10)}/span 25">overlap span ${String(index)}</span>`
  ).join("")}</div>`, "grid-overlapping-spans"),
  gridSpanGroups: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(50,minmax(auto,1fr))">${Array.from(
    { length: 500 }, (_, index) => `<span style="grid-column:span ${String(1 + index % 50)}">span group ${String(index)}</span>`
  ).join("")}</div>`, "grid-span-groups"),
  gridGrowthLimits: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(50,minmax(auto,40px))">${Array.from(
    { length: 500 }, (_, index) => `<span style="grid-column:span ${String(2 + index % 8)}">growth limit ${String(index)} ${"x".repeat(index % 32)}</span>`
  ).join("")}</div>`, "grid-growth-limits"),
  gridSparseFrontiers: formattingFixture(`<div style="display:grid;grid-template-columns:repeat(4,20px);grid-auto-flow:row">${Array.from(
    { length: 500 }, (_, index) => `<span style="grid-row:${String(1 + Math.floor(index / 3))};grid-column:span ${index % 3 === 0 ? "2" : "1"}">frontier ${String(index)}</span>`
  ).join("")}</div>`, "grid-sparse-frontiers"),
  gridCollapsedAutoFitTracks: formattingFixture(`<div style="display:grid;width:1000px;grid-template-columns:repeat(auto-fit,minmax(8px,1fr));gap:2px">${Array.from(
    { length: 60 }, (_, index) => `<span style="grid-column:${String(1 + index * 2)}">auto-fit ${String(index)}</span>`
  ).join("")}</div>`, "grid-collapsed-auto-fit-tracks")
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
  for (let sample = 0; sample < PERCENTILE_SAMPLE_COUNT; sample += 1) {
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
      program: compileStylesheetProgram({
        document: snapshot.document,
        resources: snapshot.stylesheets,
        initialDiagnostics: snapshot.styleDiagnostics
      }),
      state,
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
  for (let sample = 0; sample < PERCENTILE_SAMPLE_COUNT; sample += 1) time(samples, render);
  realPageCompatibilitySamples.push(...samples);
  realPageCompatibilityMetrics[fixture.id] = Object.freeze({
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95)
  });
}

function repeatedStage(operation, samples = PERCENTILE_SAMPLE_COUNT) {
  for (let warmup = 0; warmup < 2; warmup += 1) operation();
  const values = [];
  for (let sample = 0; sample < samples; sample += 1) time(values, operation);
  return Object.freeze({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
}

const GRID_WORK_LIMITS = Object.freeze({
  maxGridItems: 100_000,
  maxExplicitGridTracks: 2_048,
  maxImplicitGridTracks: 4_096,
  maxGridOccupancyIntervals: 250_000,
  maxGridPlacementSteps: 2_000_000,
  maxGridNamedLineResolutions: 250_000,
  maxGridAutoRepeatTracks: 2_048,
  maxGridTrackSizingWork: 2_000_000
});
const GRID_NONE_AREAS = Object.freeze({ kind: "none" });
const GRID_SPAN_ONE = parseGridLine("span 1");
if (GRID_SPAN_ONE === null) throw new Error("Grid benchmark could not parse a one-track span");
function gridBenchmarkLength(value, basis) {
  if (value.kind === "zero") return cssPx(0);
  if (value.kind !== "length") return null;
  if (value.unit === "px") return cssPx(value.value);
  if (value.unit === "%") return basis === null ? null : Math.round(basis * value.value / 100);
  if (value.unit === "ch") return cssPx(value.value * 8);
  if (value.unit === "em" || value.unit === "rem") return cssPx(value.value * 16);
  if (value.unit === "vw") return cssPx(value.value * 9.6);
  if (value.unit === "vh") return cssPx(value.value * 3.84);
  return null;
}
function requireGridTrackList(source) {
  const parsed = parseGridTrackList(source);
  if (parsed === null) throw new Error("Grid benchmark track list was invalid");
  return parsed;
}
function benchmarkGridAxis(list, availableSize = cssPx(960), gap = cssPx(0)) {
  return expandExplicitGridAxis({
    list,
    areas: GRID_NONE_AREAS,
    areaAxis: "column",
    automaticTrackSizing: [{ kind: "breadth", breadth: { kind: "auto" } }],
    availableSize,
    gap,
    limits: GRID_WORK_LIMITS,
    resolveLength: gridBenchmarkLength,
    signal: undefined
  });
}
const gridNamedTrackSource = `${Array.from(
  { length: 1_000 }, (_, index) => `[line-${String(index)}] 1px`
).join(" ")} [line-end]`;
const gridNamedTrackList = requireGridTrackList(gridNamedTrackSource);
const gridNamedAxis = benchmarkGridAxis(gridNamedTrackList, cssPx(1_000));
const gridRows = benchmarkGridAxis(requireGridTrackList("repeat(50,16px)"), cssPx(800));
const gridAutoItems = Object.freeze(Array.from({ length: 1_000 }, (_, sourceIndex) => Object.freeze({
  formattingNode: `auto-${String(sourceIndex)}`,
  sourceIndex,
  order: 0,
  columnStart: GRID_AUTO_LINE,
  columnEnd: GRID_AUTO_LINE,
  rowStart: GRID_AUTO_LINE,
  rowEnd: GRID_AUTO_LINE
})));
const gridDenseItems = Object.freeze(gridAutoItems.map((item, sourceIndex) => Object.freeze({
  ...item,
  formattingNode: `dense-${String(sourceIndex)}`,
  columnEnd: sourceIndex % 7 === 0 ? Object.freeze({ kind: "line", span: true, index: 3, name: null }) : GRID_AUTO_LINE,
  columnStart: sourceIndex % 7 === 1 ? Object.freeze({ kind: "line", span: false, index: 2, name: null }) : GRID_AUTO_LINE
})));
const gridPlacementColumns = benchmarkGridAxis(requireGridTrackList("repeat(20,1fr)"), cssPx(960));
const gridNamedItems = Object.freeze(Array.from({ length: 1_000 }, (_, sourceIndex) => {
  const start = parseGridLine(`line-${String(sourceIndex)}`);
  if (start === null) throw new Error("Grid named-line benchmark value was invalid");
  return Object.freeze({
    formattingNode: `named-${String(sourceIndex)}`,
    sourceIndex,
    order: 0,
    columnStart: start,
    columnEnd: GRID_SPAN_ONE,
    rowStart: GRID_AUTO_LINE,
    rowEnd: GRID_AUTO_LINE
  });
}));
const gridSizingTracks = benchmarkGridAxis(requireGridTrackList("repeat(1000,minmax(8px,1fr))"), cssPx(12_000));
const gridSizingContributions = Object.freeze(Array.from({ length: 500 }, (_, index) => Object.freeze({
  formattingNode: `sizing-${String(index)}`,
  start: index * 2,
  end: Math.min(1_000, index * 2 + 2 + index % 9),
  minimumContribution: cssPx(24 + index % 32),
  minContent: cssPx(24 + index % 32),
  maxContent: cssPx(64 + index % 64)
})));
const gridIntrinsicTracks = benchmarkGridAxis(requireGridTrackList("repeat(1000,auto)"), cssPx(12_000));
const gridNonSpanningContributions = Object.freeze(Array.from({ length: 1_000 }, (_, index) => Object.freeze({
  formattingNode: `non-spanning-${String(index)}`,
  start: index,
  end: index + 1,
  minimumContribution: cssPx(8 + index % 24),
  minContent: cssPx(8 + index % 24),
  maxContent: cssPx(32 + index % 64)
})));
const gridPlannedIncreaseTracks = benchmarkGridAxis(requireGridTrackList("repeat(200,minmax(auto,max-content))"), cssPx(4_000));
const gridPlannedIncreaseContributions = Object.freeze(Array.from({ length: 500 }, (_, index) => {
  const start = index % 180;
  const span = 2 + index % 20;
  return Object.freeze({
    formattingNode: `planned-increase-${String(index)}`,
    start,
    end: Math.min(200, start + span),
    minimumContribution: cssPx(40 + index % 80),
    minContent: cssPx(40 + index % 80),
    maxContent: cssPx(120 + index % 160)
  });
}));
const gridSparseLockedItems = Object.freeze(Array.from({ length: 1_000 }, (_, sourceIndex) => Object.freeze({
  formattingNode: `locked-${String(sourceIndex)}`,
  sourceIndex,
  order: 0,
  columnStart: GRID_AUTO_LINE,
  columnEnd: sourceIndex % 5 === 0
    ? Object.freeze({ kind: "line", span: true, index: 2, name: null })
    : GRID_AUTO_LINE,
  rowStart: Object.freeze({ kind: "line", span: false, index: 1 + Math.floor(sourceIndex / 20), name: null }),
  rowEnd: GRID_SPAN_ONE
})));
const gridCollapsedTracks = new Set(Array.from({ length: 1_000 }, (_, index) => index).filter((index) => index % 2 === 1));
const gridItemLayoutFormatting = workloadFormatting.gridAutoPlacement1000;
const completeGridFormatting = workloadFormatting.nestedGrids;
const gridContainerFormatting = workloadFormatting.gridSpanningItems500;
const gridResizeFormatting = workloadFormatting.gridAutoFitProductListing;
const gridItemLayoutStreams = inlineItemStreams(gridItemLayoutFormatting);
const completeGridStreams = inlineItemStreams(completeGridFormatting);
const gridContainerStreams = inlineItemStreams(gridContainerFormatting);
const gridResizeStreams = inlineItemStreams(gridResizeFormatting);
const measuredGridLayout = layoutFragments(gridItemLayoutFormatting, 120, gridItemLayoutStreams);
const measuredGridDisplayList = displayList(measuredGridLayout, 120);
const gridStageMetrics = {
  gridValueParsing: repeatedStage(() => {
    if (parseGridTrackList(gridNamedTrackSource) === null) throw new Error("Grid parsing benchmark rejected its fixture");
  }),
  explicitGridConstruction: repeatedStage(() => {
    const axis = benchmarkGridAxis(gridNamedTrackList, cssPx(1_000));
    if (axis.tracks.length !== 1_000) throw new Error("explicit Grid benchmark lost tracks");
  }),
  gridNamedLineResolution: repeatedStage(() => {
    const placement = placeGridItems({
      items: gridNamedItems,
      columns: gridNamedAxis,
      rows: gridRows,
      autoFlow: { axis: "row", packing: "sparse" },
      limits: GRID_WORK_LIMITS,
      signal: undefined
    });
    if (placement.items.length !== 1_000) throw new Error("named-line benchmark lost Grid items");
  }),
  gridAutoPlacement: repeatedStage(() => {
    const placement = placeGridItems({
      items: gridAutoItems,
      columns: gridPlacementColumns,
      rows: gridRows,
      autoFlow: { axis: "row", packing: "sparse" },
      limits: GRID_WORK_LIMITS,
      signal: undefined
    });
    if (placement.items.length !== 1_000) throw new Error("auto-placement benchmark lost Grid items");
  }),
  gridSparseLockedAxisPlacement: repeatedStage(() => {
    const placement = placeGridItems({
      items: gridSparseLockedItems,
      columns: gridPlacementColumns,
      rows: gridRows,
      autoFlow: { axis: "row", packing: "sparse" },
      limits: GRID_WORK_LIMITS,
      signal: undefined
    });
    if (placement.items.length !== 1_000) throw new Error("sparse locked-axis benchmark lost Grid items");
  }),
  gridDensePlacement: repeatedStage(() => {
    const placement = placeGridItems({
      items: gridDenseItems,
      columns: gridPlacementColumns,
      rows: gridRows,
      autoFlow: { axis: "row", packing: "dense" },
      limits: GRID_WORK_LIMITS,
      signal: undefined
    });
    if (placement.items.length !== 1_000) throw new Error("dense-placement benchmark lost Grid items");
  }),
  gridNonSpanningIntrinsicSizing: repeatedStage(() => {
    const sizing = sizeGridTracks({
      tracks: gridIntrinsicTracks.tracks,
      contributions: gridNonSpanningContributions,
      availableSize: null,
      gap: cssPx(1),
      resolveLength: gridBenchmarkLength,
      alignment: { value: "start", overflow: "default" },
      maxWork: GRID_WORK_LIMITS.maxGridTrackSizingWork,
      signal: undefined
    });
    if (sizing.tracks.length !== 1_000) throw new Error("non-spanning intrinsic benchmark lost tracks");
  }),
  gridSpanningIntrinsicSizing: repeatedStage(() => {
    const sizing = sizeGridTracks({
      tracks: gridSizingTracks.tracks,
      contributions: gridSizingContributions,
      availableSize: null,
      gap: cssPx(1),
      resolveLength: gridBenchmarkLength,
      alignment: { value: "start", overflow: "default" },
      maxWork: GRID_WORK_LIMITS.maxGridTrackSizingWork,
      signal: undefined
    });
    if (sizing.tracks.length !== 1_000) throw new Error("spanning intrinsic benchmark lost tracks");
  }),
  gridPlannedIncreaseDistribution: repeatedStage(() => {
    const sizing = sizeGridTracks({
      tracks: gridPlannedIncreaseTracks.tracks,
      contributions: gridPlannedIncreaseContributions,
      availableSize: null,
      gap: cssPx(1),
      resolveLength: gridBenchmarkLength,
      alignment: { value: "start", overflow: "default" },
      maxWork: GRID_WORK_LIMITS.maxGridTrackSizingWork,
      signal: undefined
    });
    if (sizing.tracks.length !== 200) throw new Error("planned-increase benchmark lost tracks");
  }),
  gridFlexibleTrackSizing: repeatedStage(() => {
    const sizing = sizeGridTracks({
      tracks: gridSizingTracks.tracks,
      contributions: gridSizingContributions,
      availableSize: cssPx(12_000),
      gap: cssPx(1),
      resolveLength: gridBenchmarkLength,
      alignment: { value: "start", overflow: "default" },
      maxWork: GRID_WORK_LIMITS.maxGridTrackSizingWork,
      signal: undefined
    });
    if (sizing.tracks.length !== 1_000) throw new Error("flexible track-sizing benchmark lost tracks");
  }),
  gridCollapsedGutterConstruction: repeatedStage(() => {
    const sizing = sizeGridTracks({
      tracks: gridIntrinsicTracks.tracks,
      contributions: [],
      availableSize: cssPx(12_000),
      gap: cssPx(2),
      resolveLength: gridBenchmarkLength,
      alignment: { value: "space-evenly", overflow: "default" },
      collapsedTracks: gridCollapsedTracks,
      maxWork: GRID_WORK_LIMITS.maxGridTrackSizingWork,
      signal: undefined
    });
    if (sizing.activeGutterBoundaries.some((active) => active)) {
      throw new Error("collapsed-gutter benchmark retained a boundary adjacent to a collapsed track");
    }
  }),
  gridColumnTrackSizing: repeatedStage(() => {
    const sizing = sizeGridTracks({
      tracks: gridSizingTracks.tracks,
      contributions: gridSizingContributions,
      availableSize: cssPx(12_000),
      gap: cssPx(1),
      resolveLength: gridBenchmarkLength,
      alignment: { value: "stretch", overflow: "default" },
      maxWork: GRID_WORK_LIMITS.maxGridTrackSizingWork,
      signal: undefined
    });
    if (sizing.tracks.length !== 1_000) throw new Error("column track-sizing benchmark lost tracks");
  }),
  gridRowTrackSizing: repeatedStage(() => {
    const sizing = sizeGridTracks({
      tracks: gridSizingTracks.tracks,
      contributions: gridSizingContributions.map((entry) => Object.freeze({
        ...entry,
        minContent: cssPx(16 + (entry.start % 5) * 16),
        maxContent: cssPx(16 + (entry.start % 5) * 16)
      })),
      availableSize: null,
      gap: cssPx(1),
      resolveLength: gridBenchmarkLength,
      alignment: { value: "start", overflow: "default" },
      maxWork: GRID_WORK_LIMITS.maxGridTrackSizingWork,
      signal: undefined
    });
    if (sizing.tracks.length !== 1_000) throw new Error("row track-sizing benchmark lost tracks");
  }),
  gridItemLayout: repeatedStage(() => {
    const layout = layoutFragments(gridItemLayoutFormatting, 120, gridItemLayoutStreams);
    if (layout.outcome.status !== "complete") throw new Error("Grid item-layout workload was incomplete");
  }),
  gridContainerOrchestration: repeatedStage(() => {
    const layout = layoutFragments(gridContainerFormatting, 120, gridContainerStreams);
    if (layout.outcome.status !== "complete") throw new Error("Grid container orchestration workload was incomplete");
  }),
  completeGridLayout: repeatedStage(() => {
    const layout = layoutFragments(completeGridFormatting, 120, completeGridStreams);
    if (layout.outcome.status !== "complete") throw new Error("complete nested-Grid workload was incomplete");
  }),
  gridDisplayListConstruction: repeatedStage(() => {
    const list = displayList(measuredGridLayout, 120);
    if (list.outcome.status === "rejected") throw new Error("Grid display-list workload was rejected");
  }),
  gridCellRasterization: repeatedStage(() => {
    const cells = cellRasterization(measuredGridDisplayList);
    if (cells.cellBuffer.outcome.status === "rejected") throw new Error("Grid cell-rasterization workload was rejected");
  }),
  gridAutoRepeatResize: repeatedStage(() => {
    for (const columns of [40, 80, 120]) {
      const layout = layoutFragments(gridResizeFormatting, columns, gridResizeStreams);
      if (layout.outcome.status !== "complete") throw new Error("Grid auto-repeat resize workload was incomplete");
    }
  })
};

const tableBenchmarkHtml = `<table id="benchmark-table" style="width:960px;border-collapse:collapse"><caption>benchmark</caption>
  <colgroup><col span="10"></colgroup><tbody>${Array.from(
    { length: 100 },
    (_, row) => `<tr>${Array.from(
      { length: 10 },
      (_, column) => `<td style="border:${String(1 + column % 3)}px solid"${column === 0 && row % 10 === 0 ? " colspan=\"2\"" : ""}>${String(row)}:${String(column)} benchmark content</td>`
    ).join("")}</tr>`
  ).join("")}</tbody></table>`;
const tableParsedDocument = parse(tableBenchmarkHtml, {
  scriptingMode: "disabled",
  captureSpans: true,
  sourceRetention: "text",
  trace: "none"
});
const tableFormatting = formattingFixture(tableBenchmarkHtml, "table-stage");
const tableFormattingNode = formattingNodeOfKind(tableFormatting, "table");
const tableBudgets = Object.freeze({
  maxTableRoots: 10_000,
  maxTableRowGroups: 100_000,
  maxTableRows: 100_000,
  maxTableColumnGroups: 100_000,
  maxTableColumns: 4_096,
  maxTableCells: 100_000,
  maxTableSlotIntervals: 500_000,
  maxTableColspanWork: 2_000_000,
  maxTableRowspanWork: 2_000_000,
  maxTableAnonymousMissingCells: 500_000,
  maxTableIntrinsicMeasureWork: 2_000_000,
  maxTableColumnDistributionWork: 2_000_000,
  maxTableRowDistributionWork: 2_000_000,
  maxTableCollapsedBorderCandidates: 4_000_000,
  maxTableCollapsedBorderSegments: 1_000_000,
  maxTableHeaderAssociations: 2_000_000
});
function tableComputed(formatting, node) {
  if (node.styleNode === null) return null;
  return node.pseudo === null
    ? formatting.styles.style(node.styleNode)
    : formatting.styles.pseudo(node.styleNode, node.pseudo) ?? formatting.styles.style(node.styleNode);
}
function tableUsedLength(value, basis) {
  if (value.kind === "zero") return cssPx(0);
  if (value.kind !== "length") return null;
  if (value.unit === "px") return cssPx(value.value);
  if (value.unit === "%" && basis !== null) return cssMultiply(basis, value.value / 100);
  return null;
}
function syntheticTableContributions(id) {
  const variation = String(id).length % 8;
  const minimumInline = cssPx(16 + variation * 4);
  const maximumInline = cssPx(64 + variation * 8);
  const minimumBlock = cssPx(16 + variation * 2);
  const box = Object.freeze({
    minContentInlineSize: minimumInline,
    maxContentInlineSize: maximumInline,
    minimumBlockContribution: minimumBlock,
    maximumBlockContribution: minimumBlock
  });
  return Object.freeze({
    contentBox: box,
    borderBox: box,
    automaticMinimumSize: Object.freeze({ inline: minimumInline, block: minimumBlock }),
    percentageDependence: Object.freeze({ inline: false, block: false })
  });
}
function tableHost(formatting) {
  const work = new Map();
  return {
    budgets: tableBudgets,
    signal: undefined,
    formattingNode: (id) => formatting.node(id),
    computed: (node) => tableComputed(formatting, node),
    boxComputed: (node) => tableComputed(formatting, node),
    htmlTableCell: (node) => formatting.document.htmlTableCell(node),
    htmlTableColumn: (node) => formatting.document.htmlTableColumn(node),
    htmlTableColumnGroup: (node) => formatting.document.htmlTableColumnGroup(node),
    isOutOfFlow: (node) => {
      const position = tableComputed(formatting, node)?.box.position;
      return position === "absolute" || position === "fixed";
    },
    consume: (budget, amount = 1) => work.set(budget, (work.get(budget) ?? 0) + amount),
    usedLength: (value, basis) => tableUsedLength(value, basis),
    inlineBoxOffsets: () => cssPx(0),
    intrinsicContributions: (id) => syntheticTableContributions(id),
    registerCollapsedBorderOverride: () => {},
    paintStyle: () => Object.freeze({
      visible: true,
      foreground: null,
      background: null,
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      borderColors: Object.freeze({ top: null, right: null, bottom: null, left: null }),
      borderStyles: Object.freeze({ top: "none", right: "none", bottom: "none", left: "none" })
    })
  };
}
const measuredTableHost = tableHost(tableFormatting);
const measuredTableGrid = buildTableSlotGrid(measuredTableHost, tableFormattingNode);
const measuredTableStyle = tableComputed(tableFormatting, tableFormattingNode);
if (measuredTableStyle === null) throw new Error("table benchmark has no computed style");
const measuredTableColumns = measureTableColumns(measuredTableHost, measuredTableGrid, cssPx(960));
const measuredTableWidth = distributeTableWidth(measuredTableHost, measuredTableStyle, measuredTableColumns, cssPx(960), cssPx(0));
const measuredTableRows = sizeTableRows(
  measuredTableHost,
  measuredTableGrid,
  measuredTableWidth.columns,
  cssPx(0),
  cssPx(0),
  null
);
const measuredCollapsedGraph = buildCollapsedTableBorderGraph(
  measuredTableHost,
  measuredTableGrid,
  tableFormattingNode,
  cssPx(960)
);
const measuredCollapsedWinners = resolveCollapsedBorderConflictSets(
  measuredTableHost,
  measuredTableGrid,
  tableFormattingNode,
  measuredCollapsedGraph
);
const tableColspanFormatting = formattingFixture(`<table style="width:960px">${Array.from(
  { length: 100 }, (_, row) => `<tr>${Array.from(
    { length: 10 },
    (_, column) => `<td colspan="${String(1 + (row + column) % 5)}" style="width:${String(40 + column * 4)}px">${String(row)}:${String(column)}</td>`
  ).join("")}</tr>`
).join("")}</table>`, "table-colspan-planning");
const tableColspanNode = formattingNodeOfKind(tableColspanFormatting, "table");
const tableColspanGrid = buildTableSlotGrid(tableHost(tableColspanFormatting), tableColspanNode);
const tableHeaderDocument = createIndexedWebDocumentSnapshot(parse(`<table id="header-benchmark"><tr>${Array.from(
  { length: 100 }, (_, column) => `<th id="h${String(column)}" scope="col">H${String(column)}</th>`
).join("")}</tr>${Array.from(
  { length: 100 }, (_, row) => `<tr><th id="r${String(row)}" scope="row">R${String(row)}</th>${Array.from(
    { length: 99 }, (_, column) => `<td headers="r${String(row)} h${String(column + 1)}">${String(row)}:${String(column)}</td>`
  ).join("")}</tr>`
).join("")}</table>`), {
  requestUrl: "https://bench.example/table-headers",
  finalUrl: "https://bench.example/table-headers",
  limits: { maxHtmlTableHeaderAssociationWork: 5_000_000 }
});
const tableHeader = tableHeaderDocument.elementById("header-benchmark");
const tableHeaderModel = tableHeader === null ? null : tableHeaderDocument.htmlTable(tableHeader);
if (tableHeaderModel === null) throw new Error("table header-association benchmark has no HTML table model");
const tableAutomaticHeaderDocument = createIndexedWebDocumentSnapshot(parse(`<table id="automatic-header-benchmark"><tr>${Array.from(
  { length: 50 }, (_, column) => `<th>H${String(column)}</th>`
).join("")}</tr>${Array.from(
  { length: 49 }, (_, row) => `<tr><th>R${String(row)}</th>${Array.from(
    { length: 49 }, (_, column) => `<td>${String(row)}:${String(column)}</td>`
  ).join("")}</tr>`
).join("")}</table>`), {
  requestUrl: "https://bench.example/table-automatic-headers",
  finalUrl: "https://bench.example/table-automatic-headers"
});
const tableAutomaticHeader = tableAutomaticHeaderDocument.elementById("automatic-header-benchmark");
const tableAutomaticHeaderModel = tableAutomaticHeader === null
  ? null
  : tableAutomaticHeaderDocument.htmlTable(tableAutomaticHeader);
if (tableAutomaticHeaderModel === null) throw new Error("automatic header benchmark has no HTML table model");
const tableRowspanFormatting = formattingFixture(`<table style="width:960px">${Array.from(
  { length: 500 },
  (_, row) => `<tr><td rowspan="${String(1 + row % 8)}">${String(row)}</td><td>value</td></tr>`
).join("")}</table>`, "table-rowspan-planning");
const tableRowspanNode = formattingNodeOfKind(tableRowspanFormatting, "table");
const tableRowspanGrid = buildTableSlotGrid(tableHost(tableRowspanFormatting), tableRowspanNode);
const tableRowspanColumns = Object.freeze(tableRowspanGrid.columns.map((column) => Object.freeze({
  index: column.index,
  offset: cssPx(column.index * 120),
  size: cssPx(120),
  collapsed: column.collapsed
})));
const tableSimpleFormatting = formattingFixture(`<table style="width:960px">${Array.from(
  { length: 100 }, (_, row) => `<tr>${Array.from({ length: 10 }, (_, column) => `<td>${String(row)}:${String(column)}</td>`).join("")}</tr>`
).join("")}</table>`, "table-first-cell-pass");
const tableSecondPassFormatting = formattingFixture(`<table style="width:960px;height:800px">${Array.from(
  { length: 100 }, (_, row) => `<tr><td rowspan="${String(1 + row % 4)}" style="vertical-align:${row % 2 === 0 ? "middle" : "bottom"}">row ${String(row)} wrapped content</td><td><div style="height:50%">dependent</div></td></tr>`
).join("")}</table>`, "table-second-cell-pass");
const tableMeasuredLayout = layoutFragments(tableFormatting, 120);
const tableMeasuredDisplayList = displayList(tableMeasuredLayout, 120);
const tableStageMetrics = {
  tableMetadataIndexing: repeatedStage(() => {
    const document = createIndexedWebDocumentSnapshot(tableParsedDocument, {
      requestUrl: "https://bench.example/table-metadata",
      finalUrl: "https://bench.example/table-metadata"
    });
    const table = document.elementById("benchmark-table");
    if (table === null || document.htmlTable(table)?.cells.length !== 1_000) {
      throw new Error("table metadata benchmark lost cells");
    }
  }),
  tableHeaderAssociation: repeatedStage(() => {
    let work = 0;
    const associations = associateTableHeaders({
      cells: tableHeaderModel.cellPlacements,
      slotIntervals: tableHeaderModel.slotIntervals
    }, () => { work += 1; });
    if (associations.size < 10_000 || work === 0) {
      throw new Error("table header-association benchmark lost cells");
    }
  }),
  tableAutomaticHeaderAssociation: repeatedStage(() => {
    let work = 0;
    const associations = associateTableHeaders({
      cells: tableAutomaticHeaderModel.cellPlacements,
      slotIntervals: tableAutomaticHeaderModel.slotIntervals
    }, () => { work += 1; });
    if (associations.size !== 2_500 || work === 0) {
      throw new Error("automatic table header-association benchmark lost cells");
    }
  }),
  tableSlotGridConstruction: repeatedStage(() => {
    const grid = buildTableSlotGrid(tableHost(tableFormatting), tableFormattingNode);
    if (grid.cells.length !== 1_000) throw new Error("slot-grid benchmark lost cells");
  }),
  tableCellIntrinsicMeasurement: repeatedStage(() => {
    let total = 0;
    for (const cell of measuredTableGrid.cells) total += syntheticTableContributions(cell.formattingNode).borderBox.maxContentInlineSize;
    if (total <= 0) throw new Error("table intrinsic benchmark produced no contribution");
  }),
  tableColumnMeasureAggregation: repeatedStage(() => {
    const measures = measureTableColumns(tableHost(tableFormatting), measuredTableGrid, cssPx(960));
    if (measures.columns.length === 0) throw new Error("table column-measure benchmark produced no columns");
  }),
  tableColspanPlanning: repeatedStage(() => {
    const measures = measureTableColumns(tableHost(tableColspanFormatting), tableColspanGrid, cssPx(960));
    if (measures.spanningCellConstraints.length === 0) throw new Error("table colspan-planning benchmark produced no spanning constraints");
  }),
  tableAutomaticWidthDistribution: repeatedStage(() => {
    const width = distributeTableWidth(tableHost(tableFormatting), measuredTableStyle, measuredTableColumns, cssPx(960), cssPx(2));
    if (width.columns.length === 0) throw new Error("automatic table width benchmark produced no columns");
  }),
  tableFixedWidthDistribution: repeatedStage(() => {
    const style = Object.freeze({ ...measuredTableStyle, box: Object.freeze({ ...measuredTableStyle.box, tableLayout: "fixed" }) });
    const width = distributeTableWidth(tableHost(tableFormatting), style, measuredTableColumns, cssPx(960), cssPx(2));
    if (width.mode !== "fixed") throw new Error("fixed table width benchmark did not use fixed layout");
  }),
  tableFirstCellLayoutPass: repeatedStage(() => {
    if (layoutFragments(tableSimpleFormatting, 120).outcome.status !== "complete") throw new Error("first table cell-layout workload was incomplete");
  }),
  tableRowHeightAndRowspanDistribution: repeatedStage(() => {
    const result = sizeTableRows(tableHost(tableFormatting), measuredTableGrid, measuredTableWidth.columns, cssPx(0), cssPx(0), cssPx(1_600));
    if (result.rows.length !== 100) throw new Error("table row-sizing benchmark lost rows");
  }),
  tableRowspanPlanning: repeatedStage(() => {
    const result = sizeTableRows(
      tableHost(tableRowspanFormatting),
      tableRowspanGrid,
      tableRowspanColumns,
      cssPx(0),
      cssPx(0),
      null
    );
    if (result.rows.length !== 500) throw new Error("table rowspan-planning benchmark lost rows");
  }),
  tableSecondCellLayoutPass: repeatedStage(() => {
    if (layoutFragments(tableSecondPassFormatting, 120).outcome.status !== "complete") throw new Error("second table cell-layout workload was incomplete");
  }),
  tableCollapsedBorderGraphConstruction: repeatedStage(() => {
    const graph = buildCollapsedTableBorderGraph(tableHost(tableFormatting), measuredTableGrid, tableFormattingNode, cssPx(960));
    if (graph.edges.length === 0) throw new Error("collapsed-border graph benchmark produced no edges");
  }),
  tableCollapsedBorderConflictSets: repeatedStage(() => {
    const winners = resolveCollapsedBorderConflictSets(
      tableHost(tableFormatting),
      measuredTableGrid,
      tableFormattingNode,
      measuredCollapsedGraph
    );
    if (winners.length === 0) throw new Error("collapsed-border conflict-set benchmark produced no winners");
  }),
  tablePaintSegmentGeneration: repeatedStage(() => {
    const segments = buildCollapsedTableBorderSegments(
      tableHost(tableFormatting),
      measuredCollapsedWinners,
      measuredTableWidth.columns,
      measuredTableRows.rows,
      "ltr",
      cssCoordinate(cssPx(0)),
      cssCoordinate(cssPx(0)),
      measuredTableWidth.usedGridWidth,
      measuredTableRows.usedGridHeight,
      cssRect(
        cssCoordinate(cssPx(0)),
        cssCoordinate(cssPx(0)),
        measuredTableWidth.usedGridWidth,
        measuredTableRows.usedGridHeight
      )
    );
    if (segments.size === 0) throw new Error("collapsed-border paint-segment benchmark produced no segments");
  }),
  tableDisplayListConstruction: repeatedStage(() => {
    if (displayList(tableMeasuredLayout, 120).outcome.status === "rejected") throw new Error("table display-list benchmark was rejected");
  }),
  tableCellRasterization: repeatedStage(() => {
    if (cellRasterization(tableMeasuredDisplayList).cellBuffer.outcome.status === "rejected") throw new Error("table cell-rasterization benchmark was rejected");
  }),
  completeTableLayout: repeatedStage(() => {
    if (layoutFragments(tableFormatting, 120).outcome.status !== "complete") throw new Error("complete table layout benchmark was incomplete");
  }),
  tableRepeatedResize: repeatedStage(() => {
    for (const columns of [40, 80, 120]) {
      if (layoutFragments(tableFormatting, columns).outcome.status !== "complete") throw new Error("table resize benchmark was incomplete");
    }
  })
};

const tableStressFormatting = {
  tableOrdinaryCells10000: formattingFixture(`<table>${Array.from({ length: 100 }, (_, row) => `<tr>${Array.from(
    { length: 100 }, (_, column) => `<td>${String(row)}:${String(column)}</td>`
  ).join("")}</tr>`).join("")}</table>`, "table-ordinary-cells-10000"),
  tableColspanStress: formattingFixture(`<table>${Array.from({ length: 100 }, (_, row) => `<tr>${Array.from(
    { length: 10 }, (_, column) => `<td colspan="${String(1 + (row + column) % 10)}">span ${String(row)}:${String(column)}</td>`
  ).join("")}</tr>`).join("")}</table>`, "table-colspan-stress"),
  tableRowspanStress: formattingFixture(`<table>${Array.from({ length: 500 }, (_, row) => `<tr><td rowspan="${String(1 + row % 8)}">span ${String(row)}</td><td>value</td></tr>`).join("")}</table>`, "table-rowspan-stress"),
  tableWideStress: formattingFixture(`<table><tr>${Array.from({ length: 1_000 }, (_, column) => `<td>${String(column)}</td>`).join("")}</tr></table>`, "table-wide-stress"),
  tableNestedStress: formattingFixture(`${"<table><tr><td>".repeat(30)}nested${"</td></tr></table>".repeat(30)}`, "table-nested-stress"),
  tableColumnGroupStress: formattingFixture(`<table style="width:4000px"><colgroup>${Array.from(
    { length: 1_000 }, (_, column) => `<col style="width:${String(1 + column % 4)}px">`
  ).join("")}</colgroup><tr><td colspan="1000">many column constraints</td></tr></table>`, "table-column-group-stress"),
  tableCollapsedBorderStress: formattingFixture(`<table style="border-collapse:collapse">${Array.from({ length: 100 }, (_, row) => `<tr>${Array.from(
    { length: 10 }, (_, column) => `<td style="border:${String(1 + (row + column) % 4)}px solid">${String(row)}:${String(column)}</td>`
  ).join("")}</tr>`).join("")}</table>`, "table-collapsed-border-stress")
};
const tableStressMetrics = Object.fromEntries(Object.entries(tableStressFormatting).map(([name, formatting]) => [name, repeatedStage(() => {
  if (layoutFragments(formatting, 120).outcome.status !== "complete") throw new Error(`${name} table stress workload was incomplete`);
}, 5)]));

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
const artifactStoreLifecycle = await artifactStoreLifecycleMemory();
const layoutFragmentsMemory = await layoutFragmentMemory(inlineFormatting);
const repeatedResizeRetainedHeap = await repeatedResizeMemory(inlineFormatting);
const gridLayoutFragmentsMemory = await layoutFragmentMemory(gridItemLayoutFormatting);
const gridRepeatedResizeRetainedHeap = await repeatedResizeMemory(gridResizeFormatting);
const tableLayoutFragmentsMemory = await layoutFragmentMemory(tableFormatting);
const tableRepeatedResizeRetainedHeap = await repeatedResizeMemory(tableFormatting);

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
  gridValueParsingP95: gridStageMetrics.gridValueParsing.p95,
  explicitGridConstructionP95: gridStageMetrics.explicitGridConstruction.p95,
  gridNamedLineResolutionP95: gridStageMetrics.gridNamedLineResolution.p95,
  gridAutoPlacementP95: gridStageMetrics.gridAutoPlacement.p95,
  gridSparseLockedAxisPlacementP95: gridStageMetrics.gridSparseLockedAxisPlacement.p95,
  gridDensePlacementP95: gridStageMetrics.gridDensePlacement.p95,
  gridNonSpanningIntrinsicSizingP95: gridStageMetrics.gridNonSpanningIntrinsicSizing.p95,
  gridSpanningIntrinsicSizingP95: gridStageMetrics.gridSpanningIntrinsicSizing.p95,
  gridPlannedIncreaseDistributionP95: gridStageMetrics.gridPlannedIncreaseDistribution.p95,
  gridFlexibleTrackSizingP95: gridStageMetrics.gridFlexibleTrackSizing.p95,
  gridCollapsedGutterConstructionP95: gridStageMetrics.gridCollapsedGutterConstruction.p95,
  gridColumnTrackSizingP95: gridStageMetrics.gridColumnTrackSizing.p95,
  gridRowTrackSizingP95: gridStageMetrics.gridRowTrackSizing.p95,
  gridItemLayoutP95: gridStageMetrics.gridItemLayout.p95,
  gridContainerOrchestrationP95: gridStageMetrics.gridContainerOrchestration.p95,
  completeGridLayoutP95: gridStageMetrics.completeGridLayout.p95,
  gridDisplayListConstructionP95: gridStageMetrics.gridDisplayListConstruction.p95,
  gridCellRasterizationP95: gridStageMetrics.gridCellRasterization.p95,
  gridAutoRepeatResizeP95: gridStageMetrics.gridAutoRepeatResize.p95,
  tableMetadataIndexingP95: tableStageMetrics.tableMetadataIndexing.p95,
  tableHeaderAssociationP95: tableStageMetrics.tableHeaderAssociation.p95,
  tableAutomaticHeaderAssociationP95: tableStageMetrics.tableAutomaticHeaderAssociation.p95,
  tableSlotGridConstructionP95: tableStageMetrics.tableSlotGridConstruction.p95,
  tableCellIntrinsicMeasurementP95: tableStageMetrics.tableCellIntrinsicMeasurement.p95,
  tableColumnMeasureAggregationP95: tableStageMetrics.tableColumnMeasureAggregation.p95,
  tableColspanPlanningP95: tableStageMetrics.tableColspanPlanning.p95,
  tableAutomaticWidthDistributionP95: tableStageMetrics.tableAutomaticWidthDistribution.p95,
  tableFixedWidthDistributionP95: tableStageMetrics.tableFixedWidthDistribution.p95,
  tableFirstCellLayoutPassP95: tableStageMetrics.tableFirstCellLayoutPass.p95,
  tableRowHeightAndRowspanDistributionP95: tableStageMetrics.tableRowHeightAndRowspanDistribution.p95,
  tableRowspanPlanningP95: tableStageMetrics.tableRowspanPlanning.p95,
  tableSecondCellLayoutPassP95: tableStageMetrics.tableSecondCellLayoutPass.p95,
  tableCollapsedBorderGraphConstructionP95: tableStageMetrics.tableCollapsedBorderGraphConstruction.p95,
  tableCollapsedBorderConflictSetsP95: tableStageMetrics.tableCollapsedBorderConflictSets.p95,
  tablePaintSegmentGenerationP95: tableStageMetrics.tablePaintSegmentGeneration.p95,
  tableDisplayListConstructionP95: tableStageMetrics.tableDisplayListConstruction.p95,
  tableCellRasterizationP95: tableStageMetrics.tableCellRasterization.p95,
  completeTableLayoutP95: tableStageMetrics.completeTableLayout.p95,
  tableRepeatedResizeP95: tableStageMetrics.tableRepeatedResize.p95,
  ...Object.fromEntries(Object.entries(tableStressMetrics).map(([name, value]) => [`${name}P95`, value.p95])),
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
  repeatedResizeRetainedHeap,
  gridLayoutFragmentPeakHeapGrowth: gridLayoutFragmentsMemory.peakHeapGrowth,
  gridLayoutFragmentRetainedHeap: gridLayoutFragmentsMemory.retainedHeap,
  gridRepeatedResizeRetainedHeap,
  tableLayoutFragmentPeakHeapGrowth: tableLayoutFragmentsMemory.peakHeapGrowth,
  tableLayoutFragmentRetainedHeap: tableLayoutFragmentsMemory.retainedHeap,
  tableRepeatedResizeRetainedHeap,
  artifactGraphLiveHeap: artifactStoreLifecycle.liveHeap,
  artifactGraphReleasedHeap: artifactStoreLifecycle.releasedHeap,
};
const failures = Object.entries(LIMITS_MS)
  .filter(([name, limit]) => metrics[name] > limit)
  .map(([name, limit]) => `${name}=${metrics[name].toFixed(2)}ms exceeds ${String(limit)}ms`);
for (const [name, limit] of Object.entries(LIMITS_MEMORY_MIB)) {
  if (memoryMetrics[name] > limit) failures.push(`${name}=${memoryMetrics[name].toFixed(2)}MiB exceeds ${String(limit)}MiB`);
}
if (!lifecycle.closedSessionCollected) failures.push("closed BrowserSession retained its final document after forced GC");
if (!artifactStoreLifecycle.released || artifactStoreLifecycle.metricsAfterRelease.attachedDocuments !== 0) {
  failures.push("released render artifact graph remained reachable after forced GC");
}
if (!hundredThousandNodes.released || !largeSourceAttributes.released) {
  failures.push("a released large document remained reachable after forced GC");
}
if (!layoutFragmentsMemory.released) failures.push("released layout fragments remained reachable after forced GC");
if (!gridLayoutFragmentsMemory.released) failures.push("released Grid layout fragments remained reachable after forced GC");
if (!tableLayoutFragmentsMemory.released) failures.push("released table layout fragments remained reachable after forced GC");
const report = {
  suite: "structural-pipeline-bench",
  timestamp: new Date().toISOString(),
  sampleCases: SAMPLE_CASES,
  nestedDepth,
  metricsMs: metrics,
  stressWorkloadStageMetricsMs: workloadStageMetrics,
  realPageCompatibilityMetricsMs: realPageCompatibilityMetrics,
  unicodeTextStageMetricsMs: unicodeStageMetrics,
  gridStageMetricsMs: gridStageMetrics,
  tableStageMetricsMs: tableStageMetrics,
  tableStressMetricsMs: tableStressMetrics,
  unicodeStressControlsMs: unicodeStressControls,
  limitsMs: LIMITS_MS,
  metricsMemoryMiB: memoryMetrics,
  limitsMemoryMiB: LIMITS_MEMORY_MIB,
  closedSessionCollected: lifecycle.closedSessionCollected,
  releasedLargeDocumentsCollected: hundredThousandNodes.released && largeSourceAttributes.released,
  releasedLayoutFragmentsCollected: layoutFragmentsMemory.released,
  releasedRenderArtifactsCollected: artifactStoreLifecycle.released,
  artifactStoreLifecycle,
  releasedGridLayoutFragmentsCollected: gridLayoutFragmentsMemory.released,
  releasedTableLayoutFragmentsCollected: tableLayoutFragmentsMemory.released,
  reviewedPr129BaselineMs: {
    fragmentationP95: 7.148973,
    resizeP95: 5.855096,
    searchP95: 0.342621,
    largeNestedTotal: 118.338073
  },
  protectedMainGridBaselineMs: {
    sourceCommit: "d3a976c8b9132e862356e0b3797b0b3b5eb436c8",
    simpleManyGridItemsCompleteRenderingP95: 122.190417
  },
  thresholdBasis: {
    existingControls: "PR #129 limits for parsing, indexing, style, formatting, resize, search, nested work, and lifecycle memory are unchanged.",
    fixedPointControls: "PR #130 fixed-point workload limits remain unchanged; cell rasterization and index construction are now measured independently.",
    stressControls: "Every rendering stress workload is warmed and reports p50 and p95 separately for layout fragment construction, display-list construction, cell rasterization, index construction, and complete rendering.",
    unicodeTextControls: "Unicode stage limits are new workload-specific controls measured after two warmups; PR #130 thresholds remain unchanged. One-shot controls cover one million LTR code points, mixed scripts, isolates, maximum valid embedding depth, CJK, emoji, and repeated resize with cached invariant text analysis.",
    compatibilityCorpus: "Every offline compatibility fixture is warmed twice and measured over seven complete native renderings; the 500ms p95 control is unchanged.",
    gridControls: "Grid parsing, explicit-grid construction, named-line resolution, ordinary and locked-axis sparse placement, dense placement, non-spanning and spanning intrinsic sizing, planned-increase distribution, flexible-track sizing, collapsed-gutter construction, column and row sizing, container orchestration, item layout, complete nested-Grid layout, display-list construction, cell rasterization, and auto-repeat resize are each warmed and report p50/p95. Stress controls include equal and overlapping spans, every span group through the configured fixture track count, growth-limit saturation, sparse row frontiers, and collapsed auto-fit tracks. New Grid workload and memory limits do not alter prior controls.",
    tableControls: "HTML table-model indexing, explicit/transitive and automatic header assignment, sparse CSS slot-grid construction, synthetic cell intrinsic measurement, column-constraint collection, colspan planning, automatic and fixed width distribution, first row measurement, rowspan planning, final cell relayout, collapsed-border graph construction, connected conflict-set resolution, paint-segment generation, complete layout, display-list construction, cell rasterization, and resize are warmed and report p50/p95. Stress workloads cover 10,000 ordinary cells, many header references and automatic headers, colspan and rowspan constraints, 1,000 column-group constraints, nested tables, and collapsed-border edges. Existing limits are unchanged."
  },
  ok: failures.length === 0,
  failures
};
const reportPath = resolve("reports/bench.json");
await mkdir(resolve("reports"), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ metricsMs: metrics, metricsMemoryMiB: memoryMetrics })}\nbench report written: ${reportPath}\n`);
if (failures.length > 0) throw new Error(`performance controls failed: ${failures.join(", ")}`);
