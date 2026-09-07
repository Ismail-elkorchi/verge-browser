import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
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

function analysis(store, columns = 80, rows = 24) {
  return store.analyze({ documentId: "document", documentRevision: 1, ...contexts(columns, rows) });
}

function layoutFragments(layout) {
  const pending = [layout.root];
  const fragments = [];
  while (pending.length > 0) {
    const fragment = layout.fragment(pending.pop());
    fragments.push(fragment);
    pending.push(...fragment.children);
  }
  return fragments;
}

function comparableRendering(store, result, columns, rows) {
  const artifacts = analysis(store, columns, rows);
  return {
    styles: artifacts.stylesheetProgram.elementNodes.map((node) => {
      const style = artifacts.computedStyles.style(node);
      return { node, ...style, customProperties: [...style.customProperties] };
    }),
    geometry: layoutFragments(artifacts.documentLayout),
    commands: artifacts.documentDisplayList.commands,
    cells: result.terminal.cellBuffer,
    actions: result.terminal.hitTestIndex.regions,
    focus: result.terminal.focusMap.targets,
    accessibility: result.terminal.accessibilityBounds,
    sourceRects: [...result.terminal.cellRectsByDocumentNode],
    anchors: result.scrollAnchors,
    focusOrder: result.focusOrder,
    extent: result.documentExtentRows,
  };
}

for (const [name, css, columns, rows, computed, layout] of [
  ["computed vw font", "html{font-size:5vw}", 40, 24, 1, 1],
  ["computed vh font", "html{font-size:5vh}", 80, 40, 1, 1],
  ["substituted clamp font", "html{--size:clamp(12px,3vw,40px);font-size:var(--size)}", 40, 24, 1, 1],
  ["substituted percentage height", "html{--page-height:50%;height:var(--page-height)}", 80, 40, 0, 1],
  ["substituted fixed position", ".fixed{--placement:fixed;position:var(--placement);bottom:0}", 80, 40, 0, 1],
  ["nested variables", "html{--a:var(--b);--b:5vh;font-size:var(--a)}", 80, 40, 1, 1],
  ["variable fallback", "html{font-size:var(--missing,var(--also-missing,5vh))}", 80, 40, 1, 1],
  ["root font rem", "html{font-size:5vh}p{font-size:2rem;width:10rem}", 80, 40, 1, 1],
  ["independent height", "html{font-size:5vw}p{width:50%}", 80, 40, 0, 0],
  ["independent width", "html{font-size:5vh}", 40, 24, 0, 1],
]) {
  test(`retained and fresh agree after resize: ${name}`, () => {
    const html = `<style>${css}</style><p id="text"><a href="/target">alpha beta gamma delta</a></p><button class="fixed">action</button>`;
    const retained = attachedStore(html);
    const fresh = attachedStore(html);
    try {
      render(retained.store, 1);
      const resized = render(retained.store, 2, { columns, rows });
      const initial = render(fresh.store, 2, { columns, rows });
      assert.deepEqual(comparableRendering(retained.store, resized, columns, rows),
        comparableRendering(fresh.store, initial, columns, rows));
      assert.equal(invocation(resized, "computed-style-resolution"), computed);
      assert.equal(invocation(resized, "normal-flow-layout"), layout);
      assert.equal(retained.instrumentation.snapshot().find((entry) => entry.stage === "stylesheet-program-compilation").invocations, 1);
    } finally {
      retained.store.dispose();
      fresh.store.dispose();
    }
  });
}

test("attachment admission charges documents before any analysis", () => {
  const store = new RenderArtifactStore({ maxRetainedArtifactBytes: 1 });
  const document = parseWebDocument("<p>attachment</p>", { requestUrl: "https://budget.test/", finalUrl: "https://budget.test/" });
  try {
    assert.throws(() => store.attach({ documentId: "budget", documentRevision: 1, stateRevision: 1,
      document, state: createDocumentState(document), resources: embeddedStylesheetSources(document),
    }), { name: "RenderBudgetExceededError" });
    assert.equal(store.metrics().attachedDocuments, 0);
    assert.equal(store.metrics().retainedCost, 0);
  } finally { store.dispose(); }
});

test("an oversized analysis cannot be permanently exempt from retention admission", () => {
  const html = "<style>p{margin:0}</style>" + "<p>oversized analysis with words</p>".repeat(100);
  const measured = attachedStore(html);
  const attachmentCost = measured.store.metrics().retainedCost;
  assert.ok(attachmentCost > 0);
  render(measured.store, 1);
  const analysisCost = measured.store.metrics().retainedCost;
  assert.ok(analysisCost > attachmentCost);
  measured.store.dispose();
  const store = new RenderArtifactStore({ maxRetainedArtifactBytes: attachmentCost + 1 });
  const document = measured.document;
  store.attach({ documentId: "document", documentRevision: 1, stateRevision: 1, document,
    state: measured.state, resources: embeddedStylesheetSources(document) });
  try {
    assert.throws(() => render(store, 1), { name: "RenderBudgetExceededError" });
    assert.ok(store.metrics().retainedCost <= attachmentCost + 1);
    assert.equal(store.metrics().retainedAnalyses, 0);
  } finally { store.dispose(); }
});

test("sticky paint preserves the owner of an ancestor clip contained inside its normal rectangle", () => {
  const { store } = attachedStore(`<style>
    html,body,main,p{margin:0} .outside{height:32px;overflow:hidden}
    .container{height:400px}.sticky{position:sticky;top:0;height:64px}
    main{height:1000px}
  </style><div class="outside"><div class="container"><div class="sticky"><a href="/sticky">sticky clipped action</a></div></div></div><main>normal content</main>`);
  try {
    render(store, 1);
    const scrolled = render(store, 2, { scrollRow: 3, overscanBefore: 0, overscanAfter: 0 });
    assert.ok(!scrolled.displayList.commands.some((command) => command.kind === "text" && command.text.includes("sticky")));
    assert.ok(!scrolled.terminal.hitTestIndex.regions.some((region) => region.action?.destination?.includes("sticky")));
  } finally { store.dispose(); }
});

test("focus-dependent custom properties rebuild geometry and agree with a fresh attachment", () => {
  const html = `<style>html{--size:16px}html:focus{--size:32px}p{font-size:var(--size);width:10rem}</style><p id="text">alpha beta gamma</p>`;
  const retained = attachedStore(html);
  const fresh = attachedStore(html);
  try {
    render(retained.store, 1);
    for (const fixture of [retained, fresh]) fixture.store.updateState({ documentId: "document", documentRevision: 1,
      stateRevision: 2, state: { ...fixture.state, focus: fixture.document.documentElement }, changed: new Set(["focus"]) });
    const changed = render(retained.store, 2);
    const initial = render(fresh.store, 2);
    assert.deepEqual(comparableRendering(retained.store, changed, 80, 24), comparableRendering(fresh.store, initial, 80, 24));
    assert.equal(invocation(changed, "computed-style-resolution"), 1);
    assert.equal(invocation(changed, "normal-flow-layout"), 1);
    assert.equal(retained.instrumentation.snapshot().find((entry) => entry.stage === "stylesheet-program-compilation").invocations, 1);
  } finally { retained.store.dispose(); fresh.store.dispose(); }
});

for (const [name, content] of [
  ["fixed header", '<header style="position:fixed;top:0;background:red"><a href="/fixed">fixed header</a></header>'],
  ["sticky containing limit", '<div style="height:100px"><div style="position:sticky;top:0">sticky</div></div>'],
  ["nested positioned", '<div style="position:relative;height:200px"><div style="position:absolute;top:40px"><span style="position:relative;left:10px">positioned</span></div></div>'],
  ["inner and outer sticky clips", '<div style="height:90px;overflow:hidden"><div style="height:300px"><div style="position:sticky;top:0;height:32px;overflow:hidden">sticky<br>clipped<br>hidden</div></div></div>'],
  ["RTL bidi", '<p dir="rtl">العربية abc עברית 123</p>'],
  ["inline backgrounds", '<p><span style="background:red">wrapped inline background text '.repeat(3) + '</span></p>'.repeat(3)],
  ["collapsed tables", '<table style="border-collapse:collapse"><tr><td style="border:1px solid red">A</td><td style="border:2px solid blue">B</td></tr></table>'],
  ["grid overlap", '<div style="display:grid;grid-template-columns:80px"><a href="/first" style="grid-area:1/1">first</a><span style="grid-area:1/1;background:blue">second</span></div>'],
]) {
  test(`retained and fresh viewport paint agree: ${name}`, () => {
    const html = `<style>body{margin:0}p{margin:0}</style>${content}<button id="control">focus</button>${'<p>document content</p>'.repeat(80)}`;
    const retained = attachedStore(html);
    const fresh = attachedStore(html);
    try {
      render(retained.store, 1, { columns: 80, rows: 20 });
      for (const scrollRow of [0, 3, 10, 35]) {
        const final = { columns: 40, rows: 16, scrollRow, colorDepth: 4 };
        const changed = render(retained.store, scrollRow + 2, final);
        fresh.store.dispose();
        fresh.store.attach({ documentId: "document", documentRevision: 1, stateRevision: 1, document: fresh.document, state: fresh.state, resources: embeddedStylesheetSources(fresh.document) });
        const initial = render(fresh.store, scrollRow + 2, final);
        assert.deepEqual(comparableRendering(retained.store, changed, 40, 16), comparableRendering(fresh.store, initial, 40, 16));
        if (scrollRow > 0) for (const stage of immutableStages) assert.equal(invocation(changed, stage), 0, stage);
        assert.ok(changed.terminal.cellBuffer.rows.length <= 21);
      }
    } finally { retained.store.dispose(); fresh.store.dispose(); }
  });
}

test("many unattached analyses cannot hide attachment costs beyond the retention budget", () => {
  const sample = attachedStore("<p>small attachment</p>");
  const limit = sample.store.metrics().retainedCost * 2;
  sample.store.dispose();
  const store = new RenderArtifactStore({ maxRetainedArtifactBytes: limit });
  let admitted = 0;
  try {
    for (let index = 0; index < 100; index += 1) {
      const document = parseWebDocument(`<p>small attachment ${index}</p>`, { requestUrl: `https://budget.test/${index}`, finalUrl: `https://budget.test/${index}` });
      try {
        store.attach({ documentId: `${index}`, documentRevision: 1, stateRevision: 1,
          document, state: createDocumentState(document), resources: embeddedStylesheetSources(document) });
        admitted += 1;
      } catch (error) { assert.equal(error.name, "RenderBudgetExceededError"); break; }
    }
    assert.ok(admitted > 0 && admitted < 100);
    assert.ok(store.metrics().retainedCost <= limit);
  } finally { store.dispose(); }
});

test("resize variants share upstream allocations and bounded logical query caches are charged", () => {
  const fixture = attachedStore("<p>alpha beta gamma</p>".repeat(80));
  try {
    const variants = [80, 60, 40].map((columns) => analysis(fixture.store, columns));
    assert.equal(variants[0].computedStyles, variants[2].computedStyles);
    assert.equal(variants[0].textSearchIndex, variants[2].textSearchIndex);
    assert.ok(fixture.store.metrics().retainedCost < variants.reduce((sum, variant) => sum + variant.retainedCost, 0));
    const before = fixture.store.metrics().retainedCost;
    for (let index = 0; index < 100; index += 1) fixture.store.search({ documentId: "document", documentRevision: 1, ...contexts(40, 24) }, `query ${index}`);
    assert.ok(fixture.store.metrics().retainedCost > before);
    const logical = variants[0].textSearchIndex.search("alpha", 2000);
    assert.equal(variants[2].textSearchIndex.search("alpha", 2000), logical);
  } finally { fixture.store.dispose(); }
});

test("truncated style, box, and layout prefixes retain a nonzero allocation cost", () => {
  const html = "<style>p{color:red}</style>" + "<p>prefix retained words</p>".repeat(200);
  const document = parseWebDocument(html, { requestUrl: "https://prefix.test/", finalUrl: "https://prefix.test/" });
  const store = new RenderArtifactStore();
  try {
    store.attach({ documentId: "document", documentRevision: 1, stateRevision: 1, document,
      state: createDocumentState(document), resources: embeddedStylesheetSources(document),
      budgets: { style: { maxStylesheetBytes: 1 }, formatting: { maxFormattingNodes: 100 }, layout: { maxFragments: 60 } } });
    const before = store.metrics().retainedCost;
    const artifacts = analysis(store);
    assert.equal(artifacts.computedStyles.outcome.status, "truncated");
    assert.equal(artifacts.boxTree.outcome.status, "truncated");
    assert.equal(artifacts.documentLayout.outcome.status, "truncated");
    assert.ok(artifacts.retainedCost > before);
    assert.ok(store.metrics().retainedCost > before);
  } finally { store.dispose(); }
});

test("forced GC graph reachability after release", async () => {
  if (globalThis.gc === undefined) {
    await promisify(execFile)(process.execPath, ["--expose-gc", "--test", "--test-name-pattern=forced GC graph reachability", fileURLToPath(import.meta.url)]);
    return;
  }
  function released() {
    const { store } = attachedStore("<style>p{--x:20px;height:var(--x)}</style>" + "<p>released</p>".repeat(200));
    const artifacts = analysis(store);
    const weak = [artifacts.stylesheetProgram, artifacts.computedStyles, artifacts.boxTree, artifacts.documentLayout, artifacts.textSearchIndex]
      .map((owner) => new globalThis.WeakRef(owner));
    store.release("document");
    assert.equal(store.metrics().retainedCost, 0);
    return weak;
  }
  const weak = released();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await setImmediate();
    globalThis.gc();
  }
  assert.ok(weak.every((reference) => reference.deref() === undefined));
});


test("state admission rolls back oversized control text and keeps the previous document revision usable", () => {
  const fixture = attachedStore('<input value="before">');
  const limit = fixture.store.metrics().retainedCost + 1000;
  const store = new RenderArtifactStore({ maxRetainedArtifactBytes: limit });
  try {
    store.attach({ documentId: "document", documentRevision: 1, stateRevision: 1, document: fixture.document,
      state: fixture.state, resources: embeddedStylesheetSources(fixture.document) });
    assert.throws(() => store.updateState({ documentId: "document", documentRevision: 1, stateRevision: 2,
      state: { ...fixture.state, controls: new Map([[fixture.document.controls[0].node, { value: "x".repeat(limit) }]]) },
      changed: new Set(["control-content"]) }), { name: "RenderBudgetExceededError" });
    assert.ok(store.metrics().retainedCost <= limit);
    store.updateState({ documentId: "document", documentRevision: 1, stateRevision: 1,
      state: fixture.state, changed: new Set() });
  } finally { store.dispose(); fixture.store.dispose(); }
});

test("eviction releases program caches and reanalysis matches a new attachment", () => {
  const fixture = attachedStore('<p>evicted text</p>'.repeat(20));
  const first = analysis(fixture.store, 80);
  const limit = fixture.store.metrics().retainedCost + 1000;
  const store = new RenderArtifactStore({ maxRetainedArtifactBytes: limit });
  const attach = () => store.attach({ documentId: "document", documentRevision: 1, stateRevision: 1,
    document: fixture.document, state: fixture.state, resources: embeddedStylesheetSources(fixture.document) });
  try {
    attach();
    analysis(store, 80);
    try { analysis(store, 20); } catch (error) { assert.equal(error.name, "RenderBudgetExceededError"); }
    assert.ok(store.metrics().evictions > 0);
    assert.ok(store.metrics().retainedCost <= limit);
    const rebuilt = analysis(store, 80);
    assert.deepEqual(layoutFragments(rebuilt.documentLayout), layoutFragments(first.documentLayout));
    store.release("document");
    assert.equal(store.metrics().retainedCost, 0);
    attach();
    assert.deepEqual(layoutFragments(analysis(store, 80).documentLayout), layoutFragments(first.documentLayout));
  } finally { store.dispose(); fixture.store.dispose(); }
});


for (const phase of ["compilation", "layout", "admission", "rasterization"]) {
  test(`active ${phase} observes a cancellation checkpoint without retaining partial artifacts`, () => {
    const document = parseWebDocument('<style>p{color:red}</style>' + '<p>checkpoint words</p>'.repeat(100),
      { requestUrl: "https://checkpoint.test/", finalUrl: "https://checkpoint.test/" });
    let activePhase = "compilation";
    let checkpoints = 0;
    const cancellation = new globalThis.AbortController();
    const signal = {
      get aborted() { return cancellation.signal.aborted; },
      throwIfAborted() {
        if (activePhase === phase && ++checkpoints === 20) cancellation.abort();
        cancellation.signal.throwIfAborted();
      },
    };
    const store = new RenderArtifactStore({ instrumentation: { record(stage) {
      if (stage === "stylesheet-program-compilation") activePhase = "analysis";
      if (stage === "logical-search-index-construction") activePhase = "layout";
      if (stage === "document-geometry-index-construction") activePhase = "admission";
      if (stage === "viewport-display-list-construction") activePhase = "rasterization";
    } } });
    try {
      assert.throws(() => {
        store.attach({ documentId: "document", documentRevision: 1, stateRevision: 1, document,
          state: createDocumentState(document), resources: embeddedStylesheetSources(document), signal });
        store.renderViewport({ documentId: "document", documentRevision: 1, viewportRevision: 1, ...contexts(80, 24),
          window: { scrollRow: 0, viewportRows: 24, overscanBefore: 2, overscanAfter: 3 }, signal, analysisSignal: signal });
      }, { name: "AbortError" });
      assert.equal(checkpoints, 20);
      assert.equal(store.metrics().retainedAnalyses, phase === "rasterization" ? 1 : 0);
    } finally { store.dispose(); }
  });
}
