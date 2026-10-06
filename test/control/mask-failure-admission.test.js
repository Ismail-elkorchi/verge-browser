import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { discoverViewportImages, selectViewportImages, pageImageMetadata } from "../../dist/app/image-admission.js";
import { cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

for (const limit of [2, 32]) for (const knownDimensions of [false, true]) {
  test(`failed masks keep a stable full admission pool: limit ${limit}, known dimensions ${knownDimensions}`, () => {
    const document = parseWebDocument('<style>body{margin:0}.icon{position:absolute;top:0;width:16px;height:16px;'
      + 'background:black;mask-size:16px 16px;mask-repeat:no-repeat}</style>'
      + Array.from({ length: limit + 1 }, (_, index) => `<span class=icon style="left:${index * 16}px;mask-image:url(mask-${index}.svg)"></span>`).join(""),
    { requestUrl: "https://media.test/", finalUrl: "https://media.test/" });
    let snapshot = { document, images: [], imageResourceLimit: limit };
    const store = new RenderArtifactStore();
    store.attach({ documentId: "media", documentRevision: 1, stateRevision: 1, document,
      state: createDocumentState(document), images: [], resources: embeddedStylesheetSources(document) });
    const viewport = cssRect(cssPx(0), cssPx(0), cssPx(640), cssPx(192));
    const request = { documentId: "media", documentRevision: 1,
      mediaEnvironment: { viewportWidthCssPx: 640, viewportHeightCssPx: 192, mediaType: "screen",
        prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
      layoutContext: { viewport, initialContainingBlock: viewport, scrollport: viewport,
        textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
      terminalContext: { columns: 80, rows: 12, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16),
        unicode: true, ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() },
      window: { scrollRow: 0, viewportRows: 12, overscanBefore: 0, overscanAfter: 0 }, searchQuery: null };
    try {
      const initial = store.renderViewport({ ...request, viewportRevision: 1 });
      const selected = selectViewportImages(snapshot, discoverViewportImages(initial.displayList).resources);
      assert.equal(selected.length, limit);
      snapshot = { ...snapshot, images: Object.freeze(selected.map((image) => Object.freeze({ ...image,
        width: knownDimensions ? 8 : null, height: knownDimensions ? 8 : null }))) };
      store.updateImages({ documentId: "media", documentRevision: 1, images: pageImageMetadata(snapshot) });
      const before = store.analyze(request);
      snapshot = { ...snapshot, images: Object.freeze(snapshot.images.map((image) => Object.freeze({ ...image,
        status: "failed", failure: "fetch-failed", reason: "Controlled acquisition failure." }))) };
      assert.equal(store.updateImages({ documentId: "media", documentRevision: 1, images: pageImageMetadata(snapshot) }), "paint");
      assert.equal(store.analyze(request).documentLayout, before.documentLayout);
      for (let step = 0; step < 6; step += 1) {
        const frame = store.renderViewport({ ...request, viewportRevision: step + 2 });
        const visible = discoverViewportImages(frame.displayList).resources;
        const admitted = selectViewportImages(snapshot, visible);
        assert.equal(admitted, snapshot.images, "failed resources must not rotate out and become new requests");
        assert.equal(admitted.filter((image) => image.status === "pending").length, 0);
        const byId = new Map(snapshot.images.map((image) => [image.id, image]));
        for (const command of frame.displayList.commands) {
          if (command.kind !== "image" || !byId.has(command.resourceId)) continue;
          assert.equal(command.naturalWidth, knownDimensions ? 8 : null);
          assert.equal(command.naturalHeight, knownDimensions ? 8 : null);
        }
      }
    } finally { store.dispose(); }
  });
}
