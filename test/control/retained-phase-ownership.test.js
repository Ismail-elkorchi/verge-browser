import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentAction, createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { RetainedCacheMap, registerRetainedCache } from "../../dist/memory/retained-cost.js";
import { RenderArtifactStore, RenderStageMetrics } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { cssCoordinate, cssNonNegativeLength, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

function request(columns = 80, documentRevision = 1) {
  const viewport = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(columns * 8), cssPx(384));
  return { documentId: "phases", documentRevision,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: 384, mediaType: "screen",
      prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: { width: cssNonNegativeLength(viewport.width), height: cssNonNegativeLength(viewport.height) },
      initialContainingBlock: viewport, scrollport: viewport, controlMeasurer: terminalCssControlMeasurer(), textMeasurer: terminalCssTextMeasurer(cssPx(8), cssPx(16), 1) },
    terminalContext: { columns, rows: 24, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16), unicode: true,
      ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() } };
}
function fixture(html, stateRevision = 1) {
  const document = parseWebDocument(html, { requestUrl: "https://phases.test/", finalUrl: "https://phases.test/" });
  const state = createDocumentState(document);
  const instrumentation = new RenderStageMetrics();
  const store = new RenderArtifactStore({ instrumentation });
  store.attach({ documentId: "phases", documentRevision: 1, stateRevision, document, state,
    resources: embeddedStylesheetSources(document) });
  return { document, state, store, instrumentation };
}
function counts(fixture) {
  return Object.fromEntries(fixture.instrumentation.snapshot().map(({ stage, invocations }) => [stage, invocations]));
}
function update(fixture, state, revision, changed = ["target"]) {
  fixture.store.updateState({ documentId: "phases", documentRevision: 1, stateRevision: revision, state, changed: new Set(changed) });
}
const downstream = ["box-tree-construction", "inline-item-stream-construction", "logical-search-index-construction",
  "normal-flow-layout", "document-display-list-construction", "display-list-spatial-index-construction", "document-geometry-index-construction"];

test("effective cascade no-ops preserve each downstream phase and bounded identities", () => {
  const f = fixture('<style>p{color:red;--value:ok}p:target{color:red;--value:ok}</style><p id=t>unchanged text</p>');
  try {
    const first = f.store.analyze(request());
    const before = counts(f);
    for (let revision = 2; revision < 10; revision += 1) {
      update(f, { ...f.state, urlTarget: revision % 2 === 0 ? f.document.elementById("t") : null }, revision);
      const next = f.store.analyze(request());
      for (const key of ["boxTree", "inlineItemStreams", "textSearchIndex", "documentLayout", "documentDisplayList", "displayListSpatialIndex", "documentGeometry"]) {
        assert.equal(next[key], first[key], key);
      }
    }
    for (const stage of downstream) assert.equal(counts(f)[stage], before[stage], stage);
    assert.equal(f.store.metrics().retainedAnalyses, 1);
    assert.ok(f.store.metrics().retainedResources <= 8);
    assert.equal(f.store.metrics().pinnedResources, 0);
    assert.equal(f.store.metrics().reservedCost, 0);
    assert.ok(f.store.metrics().retainedCost >= f.store.recountRetainedCost());
  } finally { f.store.dispose(); }
});

test("reporting-only transitions change summary identity without changing geometry", () => {
  const f = fixture('<style>p:target{transform:rotate(45deg)}</style><p id=t>reporting only</p>');
  try {
    const first = f.store.analyze(request());
    update(f, { ...f.state, urlTarget: f.document.elementById("t") }, 2);
    const next = f.store.analyze(request());
    assert.equal(next.documentLayout, first.documentLayout);
    assert.equal(next.documentGeometry, first.documentGeometry);
    assert.notEqual(next.key.reporting, first.key.reporting);
    assert.ok(next.computedStyles.diagnostics.length > first.computedStyles.diagnostics.length);
    assert.equal(first.computedStyles.diagnostics.length, 0);
  } finally { f.store.dispose(); }
});

test("a no-op in one media environment never validates another environment", () => {
  const f = fixture('<style>@media(min-width:600px){p:target{width:20px}}</style><p id=t>different environments</p>');
  try {
    const initialWide = f.store.analyze(request(80));
    f.store.analyze(request(40));
    update(f, { ...f.state, urlTarget: f.document.elementById("t") }, 2);
    f.store.analyze(request(40));
    const before = counts(f)["computed-style-resolution"];
    const wide = f.store.analyze(request(80));
    assert.equal(counts(f)["computed-style-resolution"], before + 1);
    assert.notDeepEqual(wide.computedStyles.style(f.document.elementById("t")).box.width,
      initialWide.computedStyles.style(f.document.elementById("t")).box.width);
  } finally { f.store.dispose(); }
});

test("control content and disclosure remain independent formatting dependencies", () => {
  const f = fixture('<input value=before><select><option>first choice</option><option>second choice</option></select><details><summary>Open</summary>hidden body</details>');
  try {
    const first = f.store.analyze(request());
    const state = applyDocumentAction(f.document, f.state, { kind: "set-control-value", target: f.document.controls[0].node, value: "after" });
    update(f, state, 2, ["control-content"]);
    const next = f.store.analyze(request());
    assert.notEqual(next.boxTree, first.boxTree);
    assert.match(next.textSearchIndex.text, /after/u);
    assert.doesNotMatch(next.textSearchIndex.text, /before/u);
    const select = f.document.controls.find((control) => control.kind === "select");
    const selected = applyDocumentAction(f.document, state, { kind: "set-selected-options", target: select.node,
      options: [select.options[1].node] });
    update(f, selected, 3, ["checked-selected"]);
    const changedSelection = f.store.analyze(request());
    assert.notEqual(changedSelection.boxTree, next.boxTree);
    assert.match(changedSelection.textSearchIndex.text, /second choice/u);
    const opened = applyDocumentAction(f.document, selected, { kind: "set-open", target: f.document.disclosures[0].node, open: true });
    update(f, opened, 4, ["disclosure-open"]);
    const expanded = f.store.analyze(request());
    assert.notEqual(expanded.boxTree, changedSelection.boxTree);
    assert.match(expanded.textSearchIndex.text, /hidden body/u);
    assert.doesNotMatch(changedSelection.textSearchIndex.text, /hidden body/u);
  } finally { f.store.dispose(); }
});

test("same-source activation advances fences while retaining phase identity", () => {
  const f = fixture('<p>same live source</p>');
  try {
    const first = f.store.analyze(request());
    f.store.updateState({ documentId: "phases", previousDocumentRevision: 1, documentRevision: 2,
      stateRevision: 1, state: f.state, changed: new Set() });
    assert.throws(() => f.store.analyze(request()), /Unknown render document revision/u);
    const next = f.store.analyze(request(80, 2));
    assert.equal(next.documentLayout, first.documentLayout);
    assert.equal(first.key.documentRevision, 1);
    assert.equal(next.key.documentRevision, 2);
  } finally { f.store.dispose(); }
});

for (const [initialRevision, change] of [[13, "focus"], [14, "checked-selected"]]) {
  test(`attachment semantic generations do not alias external revision ${initialRevision}`, () => {
    const f = fixture('<style>#t{color:red}#t:focus,#t:checked{color:blue}</style><input id=t type=checkbox>', initialRevision);
    try {
      const node = f.document.elementById("t");
      const first = f.store.analyze(request());
      const state = change === "focus" ? { ...f.state, focus: node }
        : applyDocumentAction(f.document, f.state, { kind: "set-checked", target: node, checked: true });
      update(f, state, initialRevision + 1, [change]);
      const next = f.store.analyze(request());
      assert.deepEqual(first.computedStyles.style(node).text.color, { r: 255, g: 0, b: 0, a: 1 });
      assert.deepEqual(next.computedStyles.style(node).text.color, { r: 0, g: 0, b: 255, a: 1 });
      assert.notEqual(next.computedStyles, first.computedStyles);

      // A restarted or replaced worker source can start at any external revision.
      f.store.attach({ documentId: "phases", documentRevision: 2, stateRevision: 100_000,
        document: f.document, state: f.state, resources: embeddedStylesheetSources(f.document) });
      const reattached = f.store.analyze(request(80, 2));
      f.store.updateState({ documentId: "phases", documentRevision: 2, stateRevision: 100_001,
        state, changed: new Set([change]) });
      const updated = f.store.analyze(request(80, 2));
      assert.deepEqual(reattached.computedStyles.style(node).text.color, { r: 255, g: 0, b: 0, a: 1 });
      assert.deepEqual(updated.computedStyles.style(node).text.color, { r: 0, g: 0, b: 255, a: 1 });

      // Advancing an activation fence may reset external revisions without invalidating semantics.
      f.store.updateState({ documentId: "phases", previousDocumentRevision: 2, documentRevision: 3,
        stateRevision: 1, state, changed: new Set() });
      const activated = f.store.analyze(request(80, 3));
      assert.equal(activated.documentLayout, updated.documentLayout);
      assert.equal(activated.key.computedStyleMap, updated.key.computedStyleMap);
      f.store.updateState({ documentId: "phases", documentRevision: 3, stateRevision: 2,
        state: f.state, changed: new Set([change]) });
      const restored = f.store.analyze(request(80, 3));
      assert.deepEqual(restored.computedStyles.style(node).text.color, { r: 255, g: 0, b: 0, a: 1 });
    } finally { f.store.dispose(); }
  });
}

test("side cache growth and clear refresh costs after immutable phase admission", () => {
  const f = fixture('<p>cache owner</p>');
  try {
    const artifacts = f.store.analyze(request());
    const cache = new RetainedCacheMap();
    registerRetainedCache(artifacts.boxTree, cache);
    const before = f.store.metrics().retainedCost;
    cache.set("later", { data: new Uint8Array(32_000) });
    const grown = f.store.metrics().retainedCost;
    assert.ok(grown >= before + 32_000);
    assert.ok(grown >= f.store.recountRetainedCost());
    cache.clear();
    assert.ok(f.store.metrics().retainedCost < grown - 31_000);
    assert.ok(f.store.metrics().retainedCost >= f.store.recountRetainedCost());
  } finally { f.store.dispose(); }
});

test("cancelled replacement retires old geometry before building and remains recoverable", () => {
  const f = fixture('<p>replacement geometry</p>'.repeat(50));
  try {
    f.store.analyze(request(80));
    let retired = false;
    assert.throws(() => f.store.analyze({ ...request(40), signal: { throwIfAborted() {
      if (f.store.metrics().retainedAnalyses === 0) { retired = true; throw new Error("cancelled after retirement"); }
    } } }), /cancelled after retirement/u);
    assert.equal(retired, true);
    assert.equal(f.store.metrics().retainedAnalyses, 0);
    assert.equal(f.store.metrics().pinnedResources, 0);
    assert.equal(f.store.metrics().reservedCost, 0);
    const result = f.store.analyze(request(40));
    assert.match(result.textSearchIndex.text, /replacement geometry/u);
    assert.equal(f.store.metrics().retainedAnalyses, 1);
    assert.ok(f.store.metrics().retainedCost >= f.store.recountRetainedCost());
  } finally { f.store.dispose(); }
});


test("activation rejects stale fences and rolls back authoritative state after failed admission", () => {
  const f = fixture('<input value=before><p>bounded activation</p>');
  let bounded;
  try {
    f.store.analyze(request());
    bounded = new RenderArtifactStore({ maxRetainedArtifactBytes: f.store.metrics().retainedCost + 20_000 });
    bounded.attach({ documentId: "phases", documentRevision: 1, stateRevision: 1, document: f.document,
      state: f.state, resources: embeddedStylesheetSources(f.document) });
    bounded.analyze(request());
    const next = { documentId: "phases", previousDocumentRevision: 1, documentRevision: 2,
      stateRevision: 1, state: f.state, changed: new Set() };
    assert.throws(() => bounded.updateState({ ...next, previousDocumentRevision: 0 }), /Unknown render document revision/u);
    assert.throws(() => bounded.updateState({ ...next, documentRevision: 1 }), /must advance/u);
    const oversized = applyDocumentAction(f.document, f.state, { kind: "set-control-value",
      target: f.document.controls[0].node, value: "large".repeat(100_000) });
    assert.throws(() => bounded.updateState({ ...next, state: oversized, changed: new Set(["control-content"]) }), { name: "RenderBudgetExceededError" });
    assert.throws(() => bounded.analyze(request(80, 2)), /Unknown render document revision/u);
    const recovered = bounded.analyze(request());
    assert.match(recovered.textSearchIndex.text, /before/u);
    bounded.updateState(next);
    const result = bounded.search(request(80, 2), "bounded");
    assert.equal(result.documentRevision, 2);
    assert.equal(result.stateRevision, 1);
  } finally { bounded?.dispose(); f.store.dispose(); }
});
