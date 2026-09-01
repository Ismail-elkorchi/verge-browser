import assert from "node:assert/strict";
import test from "node:test";
import { clearInterval, setInterval } from "node:timers";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import {
  cssCoordinate,
  cssLengthFromFixed,
  cssNonNegativeLength,
  cssPx,
  cssRect,
} from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore, RenderStageMetrics } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";
import { RenderWorkerClient } from "../../dist/ui/render-worker/index.js";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);

function contexts(columns, rows, colorDepth = 24, ambiguousWidth = 1) {
  const width = cssLengthFromFixed(columns * CELL_WIDTH);
  const height = cssLengthFromFixed(rows * ROW_HEIGHT);
  const viewport = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), width, height);
  return {
    mediaEnvironment: {
      viewportWidthCssPx: columns * 8,
      viewportHeightCssPx: rows * 16,
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine",
    },
    layoutContext: {
      viewport: { width: cssNonNegativeLength(width), height: cssNonNegativeLength(height) },
      initialContainingBlock: viewport,
      scrollport: viewport,
      textMeasurer: terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT, ambiguousWidth),
    },
    terminalContext: {
      columns,
      rows,
      cellWidthCssPx: CELL_WIDTH,
      rowHeightCssPx: ROW_HEIGHT,
      unicode: true,
      ambiguousWidth,
      colorDepth,
      cellMeasurer: terminalCellMeasurer(),
    },
  };
}

function attachedStore(html, instrumentation = new RenderStageMetrics()) {
  const document = parseWebDocument(html, {
    requestUrl: "https://retained.example/",
    finalUrl: "https://retained.example/",
  });
  const state = createDocumentState(document);
  const store = new RenderArtifactStore({ instrumentation });
  store.attach({
    documentId: "document",
    documentRevision: 1,
    stateRevision: 1,
    document,
    state,
    resources: embeddedStylesheetSources(document),
  });
  return { document, state, store, instrumentation };
}

function render(store, viewportRevision, options = {}) {
  const renderContexts = contexts(
    options.columns ?? 80,
    options.rows ?? 24,
    options.colorDepth ?? 24,
    options.ambiguousWidth ?? 1,
  );
  return store.renderViewport({
    documentId: "document",
    documentRevision: 1,
    viewportRevision,
    ...renderContexts,
    window: {
      scrollRow: options.scrollRow ?? 0,
      viewportRows: options.rows ?? 24,
      overscanBefore: options.overscanBefore ?? 2,
      overscanAfter: options.overscanAfter ?? 3,
    },
    ...(options.searchQuery === undefined ? {} : { searchQuery: options.searchQuery }),
  });
}

function invocation(result, stage) {
  return result.stageMetrics.find((entry) => entry.stage === stage)?.invocations ?? 0;
}

const immutableStages = [
  "computed-style-resolution",
  "box-tree-construction",
  "inline-item-stream-construction",
  "logical-search-index-construction",
  "normal-flow-layout",
  "document-display-list-construction",
  "display-list-spatial-index-construction",
  "document-geometry-index-construction",
];

test("scroll requests retain immutable artifacts and rasterize only the viewport window", () => {
  const paragraphs = Array.from({ length: 600 }, (_, index) =>
    `<p id="p${String(index)}"><a href="/${String(index)}">paragraph ${String(index)}</a></p>`).join("");
  const { store } = attachedStore(`<style>p{margin:0;height:16px}</style>${paragraphs}`);
  const cold = render(store, 1);
  for (const stage of immutableStages) assert.equal(invocation(cold, stage), 1, stage);

  const scrolled = render(store, 2, { scrollRow: 300, rows: 24, overscanBefore: 4, overscanAfter: 6 });
  for (const stage of immutableStages) assert.equal(invocation(scrolled, stage), 0, stage);
  for (const stage of [
    "spatial-query",
    "fixed-sticky-resolution",
    "viewport-display-list-construction",
    "cell-rasterization",
    "terminal-index-construction",
  ]) assert.equal(invocation(scrolled, stage), 1, stage);
  assert.ok(scrolled.terminal.cellBuffer.rows.length <= 24 + 4 + 6);
  assert.ok(scrolled.displayList.spatialQuery.visitedIntervals
    < scrolled.displayList.documentDisplayList.commands.length);

  for (let row = 0; row < 1_000; row += 10) render(store, row + 3, { scrollRow: row });
  assert.equal(store.metrics().retainedAnalyses, 1);
  store.dispose();
});

test("artifact dependency keys preserve style and text work across downstream viewport changes", () => {
  const { store } = attachedStore(`<style>.item{color:red}</style><p class="item">alpha beta</p>`);
  render(store, 1, { columns: 80, rows: 20 });

  const heightOnly = render(store, 2, { columns: 80, rows: 40 });
  for (const stage of immutableStages) assert.equal(invocation(heightOnly, stage), 0, `height ${stage}`);

  const colorOnly = render(store, 3, { columns: 80, rows: 40, colorDepth: 1 });
  for (const stage of immutableStages) assert.equal(invocation(colorOnly, stage), 0, `color ${stage}`);

  const ambiguousWidth = render(store, 4, { columns: 80, rows: 40, ambiguousWidth: 2 });
  assert.equal(invocation(ambiguousWidth, "normal-flow-layout"), 1);
  for (const stage of [
    "computed-style-resolution",
    "box-tree-construction",
    "inline-item-stream-construction",
    "logical-search-index-construction",
  ]) assert.equal(invocation(ambiguousWidth, stage), 0, `ambiguous width ${stage}`);

  const width = render(store, 5, { columns: 40, rows: 40 });
  for (const stage of [
    "computed-style-resolution",
    "box-tree-construction",
    "inline-item-stream-construction",
    "logical-search-index-construction",
  ]) assert.equal(invocation(width, stage), 0, `width ${stage}`);
  assert.equal(invocation(width, "normal-flow-layout"), 1);

  const queried = render(store, 6, { columns: 40, rows: 40, searchQuery: "beta" });
  for (const stage of immutableStages) assert.equal(invocation(queried, stage), 0, `search ${stage}`);
  assert.equal(queried.terminal.search?.matches.length, 1);
  store.dispose();
});

test("selector sessions retain structural matches and invalidate only relevant dynamic dependencies", () => {
  const { document, state, store } = attachedStore(`<style>
    p.note{color:red} p:focus{color:blue}
  </style><p id="target" class="note">focus target</p><div id="plain">plain</div>`);
  const cold = render(store, 1);
  const initialArtifacts = store.analyze({
    documentId: "document",
    documentRevision: 1,
    ...contexts(80, 24),
  });
  const initialAuthorSession = initialArtifacts.stylesheetProgram.selectorRuntime.authorSession;
  assert.ok(initialAuthorSession);
  const initialSession = cold.artifactKey;
  const target = document.elementById("target");
  assert.ok(target);
  store.updateState({
    documentId: "document",
    documentRevision: 1,
    stateRevision: 2,
    state: Object.freeze({ ...state, focus: target }),
    changed: new Set(["focus"]),
  });
  const focused = render(store, 2);
  assert.ok(invocation(focused, "selector-matching") > 0);
  assert.ok(invocation(focused, "selector-matching") < invocation(cold, "selector-matching"));
  assert.notEqual(focused.artifactKey.computedStyleMap, initialSession.computedStyleMap);
  const focusedArtifacts = store.analyze({
    documentId: "document",
    documentRevision: 1,
    ...contexts(80, 24),
  });
  assert.equal(focusedArtifacts.stylesheetProgram.selectorRuntime.authorSession, initialAuthorSession);
  assert.equal(focusedArtifacts.computedStyles.style(target).text.color.b, 255);

  const plain = document.elementById("plain");
  assert.ok(plain);
  store.updateState({
    documentId: "document",
    documentRevision: 1,
    stateRevision: 3,
    state: Object.freeze({ ...state, focus: plain }),
    changed: new Set(["focus"]),
  });
  const plainFocus = render(store, 3);
  assert.ok(invocation(plainFocus, "computed-style-resolution") > 0);
  const plainArtifacts = store.analyze({
    documentId: "document",
    documentRevision: 1,
    ...contexts(80, 24),
  });
  assert.equal(plainArtifacts.computedStyles.style(target).text.color.r, 255);
  assert.equal(
    plainArtifacts.computedStyles.style(plain),
    initialArtifacts.computedStyles.style(plain),
    "a node outside the old/new dynamic match subtrees must retain its computed style object",
  );
  store.dispose();

  const unrelated = attachedStore(`<style>p.note{color:red}</style><p class="note">text</p><div id="plain">plain</div>`);
  render(unrelated.store, 1);
  const unrelatedTarget = unrelated.document.elementById("plain");
  assert.ok(unrelatedTarget);
  unrelated.store.updateState({
    documentId: "document",
    documentRevision: 1,
    stateRevision: 2,
    state: Object.freeze({ ...unrelated.state, focus: unrelatedTarget }),
    changed: new Set(["focus"]),
  });
  const unrelatedFocus = render(unrelated.store, 2);
  for (const stage of immutableStages) assert.equal(invocation(unrelatedFocus, stage), 0, stage);
  unrelated.store.dispose();
});

test("the rendering worker keeps the main event loop live and commits only the latest viewport generation", async () => {
  const rules = Array.from({ length: 80 }, (_, index) =>
    `.group-${String(index)} p:nth-child(3n+1){color:rgb(${String(index % 255)},0,0)}`
  ).join("");
  const body = Array.from({ length: 4_000 }, (_, index) =>
    `<section class="group-${String(index % 80)}"><p id="p${String(index)}">worker paragraph ${String(index)}</p></section>`
  ).join("");
  const document = parseWebDocument(`<style>${rules}</style>${body}`, {
    requestUrl: "https://worker.example/",
    finalUrl: "https://worker.example/",
  });
  const state = createDocumentState(document);
  const client = new RenderWorkerClient();
  const browserDocument = {
    id: "worker-document",
    documentRevision: 1,
    stateRevision: 1,
    documentState: state,
    snapshot: {
      requestUrl: document.requestUrl,
      finalUrl: document.finalUrl,
      document,
      stylesheets: embeddedStylesheetSources(document),
      styleDiagnostics: [],
    },
  };
  const parameters = {
    columns: 80,
    rows: 24,
    scrollRow: 0,
    overscanBefore: 2,
    overscanAfter: 3,
    preferences: {
      unicode: true,
      ambiguousWidth: 1,
      colorDepth: 24,
      colorScheme: "dark",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine",
    },
    searchQuery: null,
  };
  try {
    let timerTicks = 0;
    const timer = setInterval(() => { timerTicks += 1; }, 2);
    await client.attach(browserDocument);
    const first = client.renderViewport(browserDocument, 1, parameters);
    const latest = client.renderViewport(browserDocument, 2, { ...parameters, scrollRow: 100 });
    const [firstResult, latestResult] = await Promise.allSettled([first, latest]);
    clearInterval(timer);
    assert.equal(firstResult.status, "rejected");
    assert.equal(firstResult.reason.name, "AbortError");
    assert.equal(latestResult.status, "fulfilled");
    assert.equal(latestResult.value.viewportRevision, 2);
    assert.ok(timerTicks >= 2, `expected event-loop progress while worker rendered, observed ${String(timerTicks)} ticks`);
    const searches = Array.from({ length: 20 }, (_, index) =>
      client.search(browserDocument, index === 19 ? "worker paragraph" : `superseded-${String(index)}`, parameters)
    );
    const searchResults = await Promise.allSettled(searches);
    assert.equal(searchResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(searchResults.at(-1)?.status, "fulfilled");
    const metrics = await client.metrics();
    assert.equal(metrics.attachedDocuments, 1);
    assert.equal(metrics.retainedAnalyses, 1);
    assert.equal(metrics.viewportRequests, 2);
    assert.equal(metrics.completedViewportRequests, 1);
    assert.equal(metrics.supersededViewportRequests, 1);
    await client.release(browserDocument.id);
    assert.equal((await client.metrics()).attachedDocuments, 0);
  } finally {
    await client.close();
  }
});

test("the rendering worker accepts repeated and nested custom-property expansions", async () => {
  const document = parseWebDocument(`<style>
    main {
      --channel: 10;
      --nested: var(--missing, var(--channel));
      color: rgb(var(--nested) var(--nested) var(--nested));
      background-color: rgb(var(--channel) var(--channel) var(--channel) / 50%);
    }
  </style><main>custom property tree</main>`, {
    requestUrl: "https://worker.example/custom-properties",
    finalUrl: "https://worker.example/custom-properties",
  });
  const browserDocument = {
    id: "custom-property-document",
    documentRevision: 1,
    stateRevision: 1,
    documentState: createDocumentState(document),
    snapshot: {
      requestUrl: document.requestUrl,
      finalUrl: document.finalUrl,
      document,
      stylesheets: embeddedStylesheetSources(document),
      styleDiagnostics: [],
    },
  };
  const client = new RenderWorkerClient();
  try {
    await client.attach(browserDocument);
    const viewport = await client.renderViewport(browserDocument, 1, {
      columns: 80,
      rows: 24,
      scrollRow: 0,
      overscanBefore: 2,
      overscanAfter: 3,
      preferences: {
        unicode: true,
        ambiguousWidth: 1,
        colorDepth: 24,
        colorScheme: "dark",
        reducedMotion: false,
        hover: "hover",
        pointer: "fine",
      },
      searchQuery: null,
    });
    assert.match(viewport.cellBuffer.rows.map((row) => row.text).join("\n"), /custom property tree/u);
  } finally {
    await client.close();
  }
});

test("document attachment observes tab-lifetime cancellation before retaining artifacts", async () => {
  const document = parseWebDocument(`<main>${"<p>cancel attachment</p>".repeat(500)}</main>`, {
    requestUrl: "https://worker.example/cancel",
    finalUrl: "https://worker.example/cancel",
  });
  const browserDocument = {
    id: "cancelled-document",
    documentRevision: 1,
    stateRevision: 1,
    documentState: createDocumentState(document),
    snapshot: {
      requestUrl: document.requestUrl,
      finalUrl: document.finalUrl,
      document,
      stylesheets: embeddedStylesheetSources(document),
      styleDiagnostics: [],
    },
  };
  const client = new RenderWorkerClient();
  try {
    const attachment = client.attach(browserDocument);
    client.cancelDocument(browserDocument.id);
    await assert.rejects(attachment, { name: "AbortError" });
    await client.release(browserDocument.id);
    assert.equal((await client.metrics()).attachedDocuments, 0);
  } finally {
    await client.close();
  }
});
