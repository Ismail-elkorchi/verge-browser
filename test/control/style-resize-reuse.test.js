import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { cssCoordinate, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources, inspectStylesheetText } from "../../dist/presentation/style/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

function contexts(columns = 80, rows = 24) {
  const width = cssPx(columns * 8);
  const height = cssPx(rows * 16);
  const rect = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), width, height);
  return {
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: rows * 16,
      mediaType: "screen", prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: { width, height }, initialContainingBlock: rect, scrollport: rect,
      textMeasurer: terminalCssTextMeasurer() },
    terminalContext: { columns, rows, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16), unicode: true,
      ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() },
  };
}

function fixture(html, makeResources = embeddedStylesheetSources) {
  const document = parseWebDocument(html, { requestUrl: "https://reuse.test/", finalUrl: "https://reuse.test/" });
  const state = createDocumentState(document);
  const store = new RenderArtifactStore();
  const attach = () => store.attach({ documentId: "page", documentRevision: 1, stateRevision: 1,
    document, state, resources: makeResources(document) });
  attach();
  return { store, document, state, attach };
}

function render(store, columns = 80, rows = 24) {
  const request = { documentId: "page", documentRevision: 1, ...contexts(columns, rows) };
  const viewport = store.renderViewport({ ...request, viewportRevision: 1,
    window: { scrollRow: 0, viewportRows: rows, overscanBefore: 2, overscanAfter: 3 } });
  return { viewport, artifacts: store.analyze(request) };
}

function comparable({ artifacts, viewport }) {
  const layout = artifacts.documentLayout;
  const pending = [layout.root];
  const fragments = [];
  while (pending.length > 0) {
    const fragment = layout.fragment(pending.pop());
    fragments.push(fragment);
    pending.push(...fragment.children);
  }
  const normalize = (style) => style === null ? null : { ...style, customProperties: [...style.customProperties] };
  return {
    styles: artifacts.stylesheetProgram.elementNodes.map((node) => [node, normalize(artifacts.computedStyles.style(node)),
      ...["before", "after", "marker"].map((pseudo) => normalize(artifacts.computedStyles.pseudo(node, pseudo)))]),
    diagnostics: artifacts.computedStyles.diagnostics,
    omittedDiagnostics: artifacts.computedStyles.omittedDiagnosticCount,
    styleOutcome: artifacts.computedStyles.outcome,
    fragments, lines: layout.lineBoxes, commands: artifacts.documentDisplayList.commands,
    cells: viewport.terminal.cellBuffer, actions: viewport.terminal.hitTestIndex.regions,
    focus: viewport.terminal.focusMap.targets, accessibility: viewport.terminal.accessibilityBounds,
    controls: viewport.terminal.controls, anchors: viewport.scrollAnchors,
    focusOrder: viewport.focusOrder, extent: viewport.documentExtentRows,
  };
}

function styleInvocations(result) {
  return result.viewport.stageMetrics.find((entry) => entry.stage === "computed-style-resolution")?.invocations ?? 0;
}

const content = '<main><p id=t><a id="link" href="/action">alpha beta gamma delta epsilon zeta</a></p><button>Action</button></main>';
for (const [name, css, columns, rows, expected] of [
  ["same width interval", "@media(width > 500px){p{color:red}}", 90, 24, 0],
  ["same height interval", "@media(height > 300px){p{color:red}}", 80, 30, 0],
  ["width breakpoint", "@media(width > 700px){p{color:red}}", 90, 24, 1],
  ["height breakpoint", "@media(height > 400px){p{color:red}}", 80, 30, 1],
  ["nested conditions", "@media(width > 500px){@media(height > 300px){p{color:red}}}", 90, 30, 0],
  ["nested breakpoint", "@media(width > 500px){@media(height > 400px){p{color:red}}}", 90, 30, 1],
  ["computed vw still invalidates", "@media(width > 500px){html{--size:5vw;font-size:var(--size)}}", 90, 24, 1],
  ["computed vh still invalidates", "@media(height > 300px){html{font-size:5vh}}", 80, 30, 1],
  ["same decision with changed diagnostics", "@media(width < 700px), (unknown-feature), screen{p{color:red}}", 90, 24, 1],
]) {
  test(`media outcome reuse: ${name}`, () => {
    const html = `<style>${css}</style>${content}`;
    const retained = fixture(html);
    const fresh = fixture(html);
    try {
      const initial = render(retained.store);
      const resized = render(retained.store, columns, rows);
      assert.equal(styleInvocations(resized), expected);
      assert.equal(resized.artifacts.computedStyles === initial.artifacts.computedStyles, expected === 0);
      assert.deepEqual(comparable(resized), comparable(render(fresh.store, columns, rows)));
      if (name === "same decision with changed diagnostics") {
        assert.equal(initial.artifacts.computedStyles.diagnostics.some((entry) => entry.code === "stylesheet-media"), false);
        assert.equal(resized.artifacts.computedStyles.diagnostics.some((entry) => entry.code === "stylesheet-media"), true);
      }
    } finally { retained.store.dispose(); fresh.store.dispose(); }
  });
}

test("source/import conditions share decisions and reattachment discards obsolete media syntax", () => {
  let threshold = 500;
  const makeResources = (document) => [{
    ...inspectStylesheetText("@media(height > 300px){p{color:red}}"),
    sourceKind: "imported", owner: document.stylesheets[0].owner,
    requestUrl: "https://reuse.test/import.css", finalUrl: "https://reuse.test/import.css", contentType: "text/css",
    rootOrder: 0, dependencyOrder: 0, importDepth: 1, importedFrom: "https://reuse.test/root.css", importLayer: null,
    mediaConditions: [`(width > ${String(threshold)}px)`, "(height > 300px)"], supportsConditions: [], predeclaredLayers: [],
  }];
  const retained = fixture(`<link rel=stylesheet href=/root.css>${content}`, makeResources);
  try {
    const first = render(retained.store);
    const same = render(retained.store, 90);
    assert.equal(same.artifacts.computedStyles, first.artifacts.computedStyles);
    assert.equal(styleInvocations(same), 0);
    threshold = 800;
    retained.attach();
    const replaced = render(retained.store, 90);
    assert.equal(styleInvocations(replaced), 1);
    assert.notEqual(replaced.artifacts.computedStyles, same.artifacts.computedStyles);
    assert.notDeepEqual(replaced.artifacts.computedStyles.style(retained.document.elementById("t")).text.color,
      same.artifacts.computedStyles.style(retained.document.elementById("t")).text.color);
  } finally { retained.store.dispose(); }
});

test("state changes still invalidate styles after a same-media resize", () => {
  const html = `<style>@media(width > 500px){a:hover{color:red}}</style>${content}`;
  const retained = fixture(html);
  const fresh = fixture(html);
  try {
    render(retained.store);
    assert.equal(styleInvocations(render(retained.store, 90)), 0);
    for (const item of [retained, fresh]) {
      const link = item.document.elementById("link");
      item.store.updateState({ documentId: "page", documentRevision: 1, stateRevision: 2,
        state: { ...item.state, hover: link }, changed: new Set(["hover"]) });
    }
    const changed = render(retained.store, 90);
    assert.equal(styleInvocations(changed), 1);
    assert.deepEqual(comparable(changed), comparable(render(fresh.store, 90)));
  } finally { retained.store.dispose(); fresh.store.dispose(); }
});

for (const [field, values] of [
  ["viewportWidthCssPx", [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
  ["viewportHeightCssPx", [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]],
  ["mediaType", ["print"]], ["prefersColorScheme", ["invalid"]], ["reducedMotion", [1]],
  ["hover", ["invalid"]], ["pointer", ["invalid"]],
]) {
  for (const value of values) {
    test(`invalid media admission cannot reuse a valid snapshot: ${field}=${String(value)}`, () => {
      const html = `<style>@media(min-width:1px){p{color:red}}</style>${content}`;
      const retained = fixture(html);
      const fresh = fixture(html);
      try {
        render(retained.store);
        const context = contexts();
        const request = { documentId: "page", documentRevision: 1, ...context,
          mediaEnvironment: { ...context.mediaEnvironment, [field]: value } };
        assert.throws(() => retained.store.analyze(request), /No computed style/u);
        assert.throws(() => fresh.store.analyze(request), /No computed style/u);
        assert.deepEqual(comparable(render(retained.store)), comparable(render(fresh.store)));
      } finally { retained.store.dispose(); fresh.store.dispose(); }
    });
  }
}
