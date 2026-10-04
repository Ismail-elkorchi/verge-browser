import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSession } from "../../dist/app/session.js";
import { applyDocumentAction, createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { estimatedRetainedCost, RetainedCostAccounting } from "../../dist/memory/retained-cost.js";
import { RenderArtifactStore, RenderStageMetrics } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { cssCoordinate, cssNonNegativeLength, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";
import { hydrateRenderDocument, hydrateRenderStylesheets, renderDocumentAttachment } from "../../dist/ui/render-worker/document-transfer.js";

const url = "https://ownership.test/";
function request(columns = 80) {
  const viewport = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(columns * 8), cssPx(24 * 16));
  return {
    documentId: "owner", documentRevision: 1,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: 384,
      mediaType: "screen", prefersColorScheme: "dark", reducedMotion: false, hover: "none", pointer: "none" },
    layoutContext: { viewport: { width: cssNonNegativeLength(viewport.width), height: cssNonNegativeLength(viewport.height) },
      initialContainingBlock: viewport, scrollport: viewport, textMeasurer: terminalCssTextMeasurer(cssPx(8), cssPx(16), 1) },
    terminalContext: { columns, rows: 24, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16),
      unicode: true, ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() },
  };
}
function fixture(html, options = {}) {
  const document = parseWebDocument(html, { requestUrl: url, finalUrl: url });
  const state = createDocumentState(document);
  const store = new RenderArtifactStore(options);
  store.attach({ documentId: "owner", documentRevision: 1, stateRevision: 1, document, state,
    resources: embeddedStylesheetSources(document) });
  return { document, state, store };
}
function assertConservative(store) {
  assert.ok(store.metrics().retainedCost >= store.recountRetainedCost(),
    `${store.metrics().retainedCost} owned bytes must cover ${store.recountRetainedCost()} recounted bytes`);
}

test("owner accounting shares immutable allocations and commits no cancelled measurement", () => {
  const accounting = new RetainedCostAccounting();
  const shared = { buffer: new Uint8Array(2048), values: ["shared allocation"] };
  const owner = accounting.immutable(shared);
  const first = accounting.immutable({ shared, label: "first" });
  const second = accounting.immutable({ shared, label: "second" });
  assert.ok(accounting.total([first, second]) >= estimatedRetainedCost([{ shared, label: "first" }, { shared, label: "second" }]));
  assert.ok(accounting.total([first, second]) < accounting.total([first]) + accounting.total([second]));
  assert.equal(accounting.total([owner, first, second]), accounting.total([first, second]));
  const root = { data: Array.from({ length: 3000 }, (_, index) => ({ index })) };
  let checks = 0;
  assert.throws(() => accounting.immutable(root, new Set(), { throwIfAborted() { if (++checks === 2) throw new Error("cancelled"); } }), /cancelled/u);
  assert.ok(accounting.total([accounting.immutable(root)]) >= estimatedRetainedCost([root]));
});

test("artifact owners conservatively cover cold, resize, search, state, rollback and release", () => {
  const metrics = new RenderStageMetrics();
  const f = fixture('<style>p{--c:red;color:var(--c)}p:focus{color:blue}</style><input value="initial">' + '<p><a href="/target">alpha beta gamma</a></p>'.repeat(80), { instrumentation: metrics });
  try {
    assertConservative(f.store);
    for (const columns of [80, 40, 60]) { f.store.analyze(request(columns)); assertConservative(f.store); }
    for (const query of ["alpha", "missing", "beta", ...Array.from({ length: 40 }, (_, index) => `query${index}`)]) {
      f.store.search(request(60), query); assertConservative(f.store);
    }
    const before = metrics.snapshot().find((entry) => entry.stage === "search-layout-projection").invocations;
    f.store.search(request(60), "alpha");
    f.store.renderViewport({ ...request(60), viewportRevision: 1, window: { scrollRow: 0, viewportRows: 24, overscanBefore: 0, overscanAfter: 0 }, searchQuery: "alpha" });
    assert.equal(metrics.snapshot().find((entry) => entry.stage === "search-layout-projection").invocations, before + 1);
    assertConservative(f.store);
    const state = applyDocumentAction(f.document, f.state, { kind: "set-control-value", target: f.document.controls[0].node, value: "changed" });
    f.store.updateState({ documentId: "owner", documentRevision: 1, stateRevision: 2, state, changed: new Set(["control-content"]) });
    assertConservative(f.store);
    f.store.analyze(request()); assertConservative(f.store);
    f.store.release("owner");
    assert.equal(f.store.metrics().retainedCost, 0);
    assert.equal(f.store.recountRetainedCost(), 0);
  } finally { f.store.dispose(); }
});

test("stylesheet transfer shares syntax while preserving cascade occurrences and encoded bytes", async () => {
  let fetches = 0;
  const html = '<!doctype html><link rel="stylesheet" href="/shared.css"><link rel="stylesheet" href="/shared.css" media="screen"><p>text</p>';
  const bytes = new Uint8Array([...new globalThis.TextEncoder().encode('p:before{content:"'), 0xe9, ...new globalThis.TextEncoder().encode('"}')]);
  const session = new BrowserSession({ defaultParseMode: "text", loader: async () => ({ requestUrl: url, finalUrl: url, html,
    status: 200, statusText: "OK", contentType: "text/html", responseFields: [], fetchedAtIso: "2026-01-01T00:00:00.000Z" }),
    stylesheetLoader: async (requestUrl) => { fetches += 1; return { requestUrl, finalUrl: requestUrl,
      bytes, transportEncodingLabel: "windows-1252", contentType: "text/css", status: 200, statusText: "OK", responseFields: [] }; } });
  try {
    const snapshot = await session.open(url);
    assert.equal(fetches, 1);
    assert.equal(snapshot.stylesheets.length, 2);
    assert.equal(snapshot.stylesheets[0].syntax, snapshot.stylesheets[1].syntax);
    assert.notEqual(snapshot.stylesheets[0].rootOrder, snapshot.stylesheets[1].rootOrder);
    const attachment = renderDocumentAttachment({ id: "owner", documentRevision: 1, stateRevision: 1,
      documentState: createDocumentState(snapshot.document), snapshot });
    assert.equal(attachment.stylesheetSources.length, 1);
    assert.ok(attachment.stylesheets.every((entry) => !("syntax" in entry)));
    const transferred = globalThis.structuredClone(attachment);
    const hydrated = hydrateRenderStylesheets(transferred);
    assert.equal(hydrated[0].syntax, hydrated[1].syntax);
    assert.deepEqual(hydrated.map((entry) => entry.mediaConditions), [[], ["screen"]]);
    assert.equal(hydrateRenderDocument(transferred).documentMode, snapshot.document.documentMode);
    assert.deepEqual(hydrated[0].syntax, snapshot.stylesheets[0].syntax);
    assert.ok(estimatedRetainedCost([attachment]) < estimatedRetainedCost([snapshot.stylesheets]));
  } finally { await session.close(); }
});

test("navigation truncates at 2,000 while viewport highlighting preserves matches through 10,000", () => {
  const f = fixture(`<style>p{margin:0}</style><p>${"alpha ".repeat(2105)}</p>`);
  try {
    const navigation = f.store.search(request(), "alpha");
    assert.equal(navigation.matches.length, 2000);
    assert.equal(navigation.truncated, true);
    const all = f.store.search(request(), "alpha", 10_000);
    assert.equal(all.matches.length, 2105);
    assert.equal(all.truncated, false);
    const tail = all.matches[2050];
    const viewport = f.store.renderViewport({ ...request(), viewportRevision: 1,
      window: { scrollRow: Math.floor(tail.blockOffsetCssPx / cssPx(16)), viewportRows: 24,
        overscanBefore: 0, overscanAfter: 0 }, searchQuery: "alpha" });
    assert.ok(viewport.terminal.search.matches.some((match) => match.id === tail.id));
    assert.equal(f.store.search(request(), "alpha").truncated, true);
    assertConservative(f.store);
  } finally { f.store.dispose(); }
});

test("direct logical query writes remain visible to owner metrics without recounting immutable graphs", () => {
  const f = fixture("<p>alpha beta gamma</p>".repeat(60));
  try {
    const artifacts = f.store.analyze(request());
    const before = f.store.metrics().retainedCost;
    artifacts.textSearchIndex.search("alpha", 2000);
    assert.ok(f.store.metrics().retainedCost > before);
    assertConservative(f.store);
  } finally { f.store.dispose(); }
});

test("warm metrics and scroll account no allocations; uncached misses account only query owners", () => {
  const f = fixture("<p>alpha beta gamma</p>".repeat(200));
  try {
    f.store.analyze(request());
    const before = f.store.metrics().accountedAllocations;
    for (let index = 0; index < 10; index += 1) f.store.metrics();
    for (let index = 0; index < 5; index += 1) f.store.renderViewport({ ...request(), viewportRevision: index + 1,
      window: { scrollRow: index * 3, viewportRows: 24, overscanBefore: 0, overscanAfter: 0 } });
    assert.equal(f.store.metrics().accountedAllocations, before);
    f.store.search(request(), "absent unique query");
    const after = f.store.metrics().accountedAllocations;
    assert.ok(after - before < 100, `An absent query measured ${after - before} allocations`);
    f.store.search(request(), "absent unique query");
    assert.equal(f.store.metrics().accountedAllocations, after);
  } finally { f.store.dispose(); }
});

test("cancelled search projection releases unadmitted query ownership", () => {
  const f = fixture(`<p>${"alpha ".repeat(1000)}</p>`);
  try {
    f.store.analyze(request());
    let checks = 0;
    assert.throws(() => f.store.search(request(), "alpha", 10_000, {
      throwIfAborted() { if (++checks === 7) { const error = new Error("cancelled"); error.name = "AbortError"; throw error; } },
    }), { name: "AbortError" });
    assertConservative(f.store);
    assert.equal(f.store.search(request(), "alpha").matches.length, 1000);
  } finally { f.store.dispose(); }
});

test("repeated interaction and resize release source and artifact graphs after forced GC", async () => {
  if (globalThis.gc === undefined) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const environment = { ...process.env };
    delete environment["NODE_TEST_CONTEXT"];
    const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", ...process.execArgv.filter((arg) => arg !== "--expose-gc"),
      "--test", "--test-name-pattern=repeated interaction and resize release", fileURLToPath(import.meta.url)], { env: environment });
    assert.match(stdout, /repeated interaction and resize release source and artifact graphs after forced GC/u);
    return;
  }
  const { setImmediate } = await import("node:timers/promises");
  function exercise() {
    const f = fixture('<style>p{color:red}p:focus{color:blue}</style><input value="initial">' + '<p><a href="/target">repeated alpha</a></p>'.repeat(25));
    const weak = [new globalThis.WeakRef(f.document)];
    for (let index = 0; index < 12; index += 1) {
      const state = applyDocumentAction(f.document, f.state, { kind: "set-control-value",
        target: f.document.controls[0].node, value: `changed ${index}` });
      f.store.updateState({ documentId: "owner", documentRevision: 1, stateRevision: index + 2,
        state, changed: new Set(["control-content"]) });
      const artifacts = f.store.analyze(request(index % 2 === 0 ? 80 : 40));
      f.store.search(request(index % 2 === 0 ? 80 : 40), "alpha");
      assertConservative(f.store);
      weak.push(...[artifacts.stylesheetProgram, artifacts.computedStyles, artifacts.boxTree,
        artifacts.textSearchIndex, artifacts.documentLayout, artifacts.stylesheetProgram.sources.at(-1).stylesheet]
        .map((value) => new globalThis.WeakRef(value)));
    }
    f.store.release("owner");
    assert.equal(f.store.metrics().retainedCost, 0);
    return { store: f.store, weak };
  }
  const { store, weak } = exercise();
  for (let index = 0; index < 5; index += 1) { await setImmediate(); globalThis.gc(); }
  assert.ok(weak.every((reference) => reference.deref() === undefined));
  store.dispose();
});
