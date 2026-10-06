import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

test("known alpha changes retire paint while intrinsic geometry, styles and search remain owned", () => {
  const document = parseWebDocument('<style>body{margin:0}img{display:block}</style><img src="/a.png" alt="ART">',
    { requestUrl: "https://alpha.test/", finalUrl: "https://alpha.test/" });
  const store = new RenderArtifactStore();
  const image = { id: "https://alpha.test/a.png", requestUrl: "https://alpha.test/a.png", owners: [document.replacedContent[0].node], width: 32, height: 32, hasAlpha: null };
  store.attach({ documentId: "alpha", documentRevision: 1, stateRevision: 1, document, state: createDocumentState(document),
    resources: embeddedStylesheetSources(document), images: [image] });
  const viewport = cssRect(cssPx(0), cssPx(0), cssPx(192), cssPx(128));
  const request = { documentId: "alpha", documentRevision: 1,
    mediaEnvironment: { viewportWidthCssPx: 192, viewportHeightCssPx: 128, mediaType: "screen", prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport, initialContainingBlock: viewport, scrollport: viewport, textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: { columns: 24, rows: 8, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16), unicode: true, ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() } };
  try {
    let before = store.analyze(request);
    for (const hasAlpha of [true, false]) {
      assert.equal(store.updateImages({ documentId: "alpha", documentRevision: 1, images: [{ ...image, hasAlpha }] }), "paint");
      const after = store.analyze(request);
      assert.equal(after.documentLayout, before.documentLayout);
      assert.equal(after.computedStyles, before.computedStyles);
      assert.equal(after.textSearchIndex, before.textSearchIndex);
      assert.notEqual(after.documentDisplayList, before.documentDisplayList);
      assert.equal(store.updateImages({ documentId: "alpha", documentRevision: 1, images: [{ ...image, hasAlpha }] }), "none");
      before = after;
    }
    for (const metadata of [{ ...image, hasAlpha: false, owners: ["replacement-owner"] },
      { ...image, hasAlpha: false, owners: ["replacement-owner"], requestUrl: "https://alpha.test/replaced.png" }]) {
      assert.equal(store.updateImages({ documentId: "alpha", documentRevision: 1, images: [metadata] }), "paint");
      const after = store.analyze(request);
      assert.equal(after.documentLayout, before.documentLayout);
      assert.equal(after.computedStyles, before.computedStyles);
      assert.equal(after.textSearchIndex, before.textSearchIndex);
      assert.notEqual(after.documentDisplayList, before.documentDisplayList);
      assert.equal(store.updateImages({ documentId: "alpha", documentRevision: 1, images: [metadata] }), "none");
      before = after;
    }
    assert.equal(store.updateImages({ documentId: "alpha", documentRevision: 1, images: [{ ...image, width: 64, hasAlpha: false }] }), "layout");
    assert.notEqual(store.analyze(request).documentLayout, before.documentLayout);
  } finally { store.dispose(); }
});
