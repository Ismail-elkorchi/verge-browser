import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rasterImage } from "@ismail-elkorchi/terminal-ui";
import { HttpFields } from "@ismail-elkorchi/http-client";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTuiRuntime, defineTui } from "@ismail-elkorchi/terminal-ui/tui";
import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { estimatedRetainedCost } from "../../dist/memory/retained-cost.js";
import { acceptBrowserViewportImages, browserRasterImage, discardBrowserViewportImages, prepareBrowserViewportImages } from "../../dist/ui/image-presentation.js";
import { browserPageSize, browserRenderPreferences } from "../../dist/ui/document-layout.js";
import { prepareBrowserTui } from "../../dist/ui/run.js";
import { browserView } from "../../dist/ui/view.js";
import { renderDocumentAttachment } from "../../dist/ui/render-worker/document-transfer.js";

function readyImage(id = "https://images.test/a.png") {
  return Object.freeze({ id, requestUrl: id, owners: [], width: 2, height: 2,
    status: "ready", hasAlpha: false, mimeType: "image/png", pixels: new Uint8Array(16).fill(255) });
}

test("UI raster handles are reused, private copy bytes counted, failed decode keeps explicit fallback", async () => {
  const resource = readyImage();
  const placement = { id: "image", resourceId: resource.id, naturalWidth: 2, naturalHeight: 2, hasAlpha: false };
  const viewport = { images: [placement] };
  const before = estimatedRetainedCost([resource]);
  assert.equal(browserRasterImage(resource, placement, viewport), null);
  await prepareBrowserViewportImages([resource], viewport, () => 32);
  acceptBrowserViewportImages(viewport);
  const handle = browserRasterImage(resource, placement, viewport);
  assert.ok(handle);
  assert.equal(browserRasterImage(resource, placement, viewport), handle);
  assert.ok(estimatedRetainedCost([resource]) >= before + resource.pixels.byteLength);
  assert.equal(Object.hasOwn(handle, "data"), false);
  const failed = { ...readyImage(), status: "failed", failure: "decode-failed", reason: "Image decode failed." };
  const failedViewport = { images: [placement] };
  await prepareBrowserViewportImages([failed], failedViewport, () => 32);
  assert.equal(browserRasterImage(failed, placement, failedViewport), null);
  discardBrowserViewportImages(failedViewport);
});

test("one-time worker attachment transfers image metadata without readiness, pixels or raster handles", async () => {
  const document = parseWebDocument('<img src="a.png" alt="ALT">', { requestUrl: "https://images.test/", finalUrl: "https://images.test/" });
  const image = readyImage();
  const viewport = { images: [{ id: "image", resourceId: image.id, naturalWidth: 2, naturalHeight: 2, hasAlpha: false }] };
  await prepareBrowserViewportImages([image], viewport, () => 32);
  acceptBrowserViewportImages(viewport);
  const attachment = renderDocumentAttachment({ id: "images", documentRevision: 1, stateRevision: 1,
    documentState: createDocumentState(document), snapshot: { document, images: [image], requestUrl: document.requestUrl,
      finalUrl: document.finalUrl, stylesheets: [], styleDiagnostics: [] } });
  assert.deepEqual(Object.keys(attachment.images[0]).sort(), ["hasAlpha", "height", "id", "owners", "requestUrl", "width"]);
  assert.deepEqual(globalThis.structuredClone(attachment.images), attachment.images);
});

async function fixture(html, { staleDimensions = false, graphics = "none", graphicsBudget,
  imageFailed = false, imagePending = false, pixelResource = null, searchQuery = null, activeMatchIndex = 0,
  renderPreferences = browserRenderPreferences(),
  terminalSize = { columns: 50, rows: 16 }, sidePanel = null, scrollRow = 0, scrollColumn = 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "verge-image-presentation-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  const prepared = await prepareBrowserTui("https://images.test/", { store,
    services: { async writeTextFile() {}, async downloadFile() { throw new Error("not used"); }, async openExternal() {}, async openPath() {}, async close() {} },
    createAcquisition: () => new PageAcquisition({ defaultParseMode: "text", stylesheetLoader: async () => { throw new Error("not used"); }, loader: async (url) => ({
      requestUrl: url, finalUrl: url, status: 200, statusText: "OK", contentType: "text/html", html,
      responseFields: new HttpFields([{ name: "content-type", value: "text/html" }]),
      networkOutcome: { kind: "ok", finalUrl: url, status: 200, statusText: "OK", detailCode: "HTTP_200", detailMessage: "OK" }, fetchedAtIso: "2026-10-05T00:00:00.000Z",
    }) }) });
  prepared.controller.configureRestoration(prepared.state.documents[0]);
  let document = await prepared.controller.restorePlaceholder(prepared.state.documents[0]);
  const ready = pixelResource ?? readyImage();
  const resource = imageFailed ? { id: ready.id, requestUrl: ready.requestUrl, owners: ready.owners,
    width: ready.width, height: ready.height, mimeType: ready.mimeType, status: "failed",
    failure: "decode-failed", reason: "Fixture decode failure." } : imagePending ? { ...ready, status: "pending", pixels: undefined } : ready;
  document = { ...document, snapshot: { ...document.snapshot, images: staleDimensions ? [{ ...resource, width: null, height: null, status: "pending", pixels: undefined }] : [resource] } };
  const screenState = { ...prepared.state, sidePanel };
  const size = browserPageSize(screenState, terminalSize);
  const payload = await prepared.controller.renderViewport(document, 1, { ...size, scrollRow, scrollColumn,
    scrollOffsets: [], overscanBefore: 1, overscanAfter: 1, preferences: renderPreferences, searchQuery });
  document = { ...document, snapshot: { ...document.snapshot, images: [resource] }, rendering: { ...document.rendering,
    viewport: payload, previousViewport: null, summary: payload.summary, status: "ready", committedViewportRevision: 1,
    requestedViewportRevision: 1, error: null },
    search: searchQuery === null ? null : { query: searchQuery, activeMatchIndex, matches: payload.search.matches,
      anchors: new Map(), documentRevision: document.documentRevision, stateRevision: document.stateRevision,
      layoutRevision: payload.layoutRevision, requestGeneration: 1, truncated: false } };
  const state = { ...screenState, documents: [document] }, messages = [];
  const host = createMemoryTerminalHost({ terminalSize, capabilities: {
    graphics: { kitty: "supported", sixel: "unsupported", kittyTransport: "direct", cellPixels: { width: 8, height: 16 } },
  } });
  const runtime = createTuiRuntime({ graphics, ...(graphicsBudget === undefined ? {} : { graphicsBudget }), app: defineTui({ id: "image-order", init: () => ({ state }),
    update(current, message) { messages.push(message); return { state: message.kind === "fixtureState" ? message.state : current }; }, view: browserView }),
    textPresentation: prepared.textPresentation, host });
  await runtime.start();
  return { runtime, messages, host, prepared, document, size, async close() { await runtime.dispose(); await prepared.controller.close(); await rm(directory, { recursive: true, force: true }); } };
}

const css = '<style>body{margin:0}img,input{position:absolute;left:0;top:0;width:48px;height:32px;padding:0;border:0}</style>';
for (const laterImage of [true, false]) {
  test(`image and native editor paint and pointer order agree when image is ${laterImage ? "later" : "earlier"}`, async () => {
    const image = '<a href="/target"><img src="/a.png" alt="ALT"></a>', control = '<input id="q" value="EDIT">';
    const value = await fixture(css + (laterImage ? control + image : image + control));
    try {
      const frame = value.runtime.frame();
      const id = value.runtime.state().documents[0].snapshot.document.elementById("q");
      const editor = frame.hitTargets.find((target) => target.id === id || target.id.startsWith(`${id}:`));
      assert.ok(editor, JSON.stringify(frame.hitTargets));
      const covers = (rect) => editor.bounds.row >= rect.row && editor.bounds.row < rect.row + rect.height
        && editor.bounds.column >= rect.column && editor.bounds.column < rect.column + rect.width;
      assert.equal(frame.graphics.some((graphic) => covers(graphic.clip)), laterImage);
      assert.equal(renderFramePlain(frame).includes("EDIT"), !laterImage);
      for (const action of ["press", "release"]) await value.runtime.handleInput({ kind: "mouse", sequence: "", encoding: "sgr", action,
        button: "left", row: editor.bounds.row, column: editor.bounds.column, rawCode: 0, modifiers: { shift: false, alt: false, ctrl: false } });
      assert.equal(value.messages.some((message) => message.kind === "activateActionAt"), laterImage, JSON.stringify(value.messages));
      assert.equal(value.runtime.frame().focusPath?.includes(id) ?? false, !laterImage);
    } finally { await value.close(); }
  });
}

test("new ready pixels never use an older accepted fallback-sized placement", async () => {
  const value = await fixture(css + '<img src="/a.png" alt="ALT">', { staleDimensions: true });
  try {
    assert.equal(value.runtime.frame().graphics.length, 0);
    assert.ok(renderFramePlain(value.runtime.frame()).includes("ALT"));
  } finally { await value.close(); }
});

for (const imageFailed of [false, true]) {
  test(`image fallback retains active and inactive search styling with ${imageFailed ? "failed decoding" : "unsupported graphics"}`, async () => {
    const value = await fixture('<style>body{margin:0}img{width:48px;height:32px}</style>'
      + '<p>ALT</p><img src="/a.png" alt="ALT">', { imageFailed, searchQuery: "ALT", activeMatchIndex: 1 });
    try {
      const frame = value.runtime.frame();
      const image = value.document.rendering.viewport.cellBuffer.images[0];
      const target = frame.hitTargets.find((entry) => entry.id === "image");
      assert.ok(image);
      assert.ok(target);
      assert.equal(frame.graphics.length, imageFailed ? 0 : 1);
      const fallback = frame.cells.filter((cell) => cell.row === target.bounds.row
        && cell.column >= target.bounds.column && cell.column < target.bounds.column + 3);
      assert.equal(fallback.map((cell) => cell.text).join(""), "ALT");
      assert.ok(fallback.every((cell) => cell.style.inverse === true && cell.style.bold === true));
      const inactive = frame.cells.filter((cell) => cell.row === target.bounds.row - image.clip.row
        && cell.column >= target.bounds.column && cell.column < target.bounds.column + 3);
      assert.equal(inactive.map((cell) => cell.text).join(""), "ALT");
      assert.ok(inactive.every((cell) => cell.style.underline === true && cell.style.inverse !== true));
    } finally { await value.close(); }
  });
}


test("rejected terminal graphics commit preserves fallback and creates no protocol resources", async () => {
  const value = await fixture(css + '<img src="/a.png" alt="ALT">', { graphics: "kitty", graphicsBudget: { encodedBytesPerUpload: 1 } });
  try {
    assert.equal(value.runtime.frame().graphics.length, 1);
    assert.ok(renderFramePlain(value.runtime.frame()).includes("ALT"));
    assert.doesNotMatch(value.host.output(), /_Ga=t,/u);
    assert.equal(value.runtime.diagnostics().filter((entry) => entry.diagnostic.code === "TUI_GRAPHICS_LIMIT_EXCEEDED").length, 1);
    await value.runtime.redraw();
    assert.equal(value.runtime.diagnostics().filter((entry) => entry.diagnostic.code === "TUI_GRAPHICS_LIMIT_EXCEEDED").length, 1);
  } finally { await value.close(); }
  assert.doesNotMatch(value.host.output(), /_Ga=d,/u);
});

test("redraw/resize reuses one UI resource and shutdown cleans terminal placement", async () => {
  const value = await fixture(css + '<img src="/a.png" alt="ALT">', { graphics: "kitty" });
  try {
    const handle = value.runtime.frame().graphics[0].image;
    await value.runtime.redraw();
    await value.runtime.resize({ columns: 40, rows: 14 });
    assert.equal(value.runtime.frame().graphics[0].image, handle);
    assert.equal(value.host.output().match(/_Ga=t,/gu)?.length, 1);
    assert.ok(renderFramePlain(value.runtime.frame()).includes("ALT"));
  } finally { await value.close(); }
  assert.match(value.host.output(), /_Ga=d,/u);
});


test("controller resource-only state preparation retains definite image layout and cancels obsolete consumers", async () => {
  const value = await fixture(css + '<img src="/a.png" width="48" height="32" alt="ALT">');
  try {
    const previous = value.document.rendering.viewport;
    const before = await value.prepared.controller.renderingMetrics();
    const document = { ...value.document, stateRevision: value.document.stateRevision + 1,
      snapshot: { ...value.document.snapshot, images: [{ ...readyImage(), width: 4, height: 4, status: "pending" }] } };
    const parameters = { ...value.size, scrollRow: previous.scrollRow, scrollColumn: previous.scrollColumn,
      scrollOffsets: previous.scrollOffsets, overscanBefore: 1, overscanAfter: 1,
      preferences: browserRenderPreferences(), searchQuery: null };
    const next = await value.prepared.controller.renderViewport(document, 2, parameters);
    const after = await value.prepared.controller.renderingMetrics();
    assert.equal(next.layoutRevision, previous.layoutRevision);
    assert.equal(next.cellBuffer.images[0].naturalWidth, 4);
    const invocations = (metrics) => metrics.stages.find((entry) => entry.stage === "normal-flow-layout")?.invocations ?? 0;
    assert.equal(invocations(after), invocations(before));
    const abort = new globalThis.AbortController(); abort.abort();
    await assert.rejects(value.prepared.controller.renderViewport(document, 3, parameters, abort.signal), { name: "AbortError" });
    assert.equal(next.scrollRow, previous.scrollRow);
  } finally { await value.close(); }
});

const widePage = '<style>body{margin:0;background:white;color:black;min-width:2400px}'
  + 'p{margin:0;height:16px}img{position:absolute;left:640px;top:32px;width:160px;height:64px}'
  + 'input{position:absolute;left:800px;top:96px;width:160px;height:32px;padding:0;border:0}</style>'
  + '<a href="/target"><img src="/a.png" alt="IMAGE_MARKER"></a><input id=q value="EDIT_MARKER">'
  + Array.from({ length: 70 }, (_, index) => `<p>Paragraph ${index} visible text</p>`).join('');

function markerPositions(frame, marker) {
  return renderFramePlain(frame).split('\n').flatMap((line, row) => {
    const positions = [];
    for (let column = line.indexOf(marker); column !== -1; column = line.indexOf(marker, column + 1)) {
      positions.push({ row: row + 1, column: column + 1 });
    }
    return positions;
  });
}

function assertPageProjection(value, { graphics = true } = {}) {
  const frame = value.runtime.frame();
  const document = value.runtime.state().documents[value.runtime.state().activeDocumentIndex];
  const payload = document.rendering.viewport ?? document.rendering.previousViewport;
  const image = payload.cellBuffer.images[0];
  const target = frame.hitTargets.find((entry) => entry.id === 'image');
  assert.ok(image);
  assert.ok(target);
  const origin = { row: 3 - payload.scrollRow, column: 1 - payload.scrollColumn };
  assert.deepEqual(target.bounds, { ...image.clip, row: origin.row + image.clip.row,
    column: origin.column + image.clip.column });
  assert.deepEqual(markerPositions(frame, 'IMAGE_MARKER'), [{ row: target.bounds.row, column: target.bounds.column }],
    'the fallback has one copy at the same origin as the image target');
  const control = payload.controls.find((entry) => entry.node === document.snapshot.document.elementById('q'));
  const editor = frame.hitTargets.find((entry) => entry.id === `${control.node}:text`);
  assert.ok(editor);
  assert.equal(editor.bounds.column, origin.column + control.visible.column);
  assert.equal(editor.bounds.row, origin.row + control.visible.row);
  assert.deepEqual(markerPositions(frame, 'EDIT_MARKER'), [{ row: editor.bounds.row, column: editor.bounds.column + 2 }]);
  assert.equal(frame.graphics.length, graphics ? 1 : 0);
  if (graphics) assert.deepEqual(frame.graphics[0].clip, target.bounds);
  assert.ok(JSON.stringify(frame.accessibility).includes('IMAGE_MARKER'));
  return target;
}

for (const status of ['ready', 'pending', 'failed']) {
  for (const options of [{}, { sidePanel: 'history' }, { scrollRow: 2 }, { scrollColumn: 20 },
    { sidePanel: 'history', scrollRow: 2, scrollColumn: 20 }]) {
    test(`wide page has one text, image, control and hit origin: ${status} ${JSON.stringify(options)}`, async () => {
      const value = await fixture(widePage, { ...options, terminalSize: { columns: 240, rows: 20 },
        imagePending: status === 'pending', imageFailed: status === 'failed' });
      try {
        assert.equal(value.size.columns, options.sidePanel ? 198 : 239);
        assert.equal(value.document.rendering.viewport.cellBuffer.columns, value.size.columns);
        const target = assertPageProjection(value, { graphics: status === 'ready' });
        for (const action of ['press', 'release']) await value.runtime.handleInput({ kind: 'mouse', sequence: '', encoding: 'sgr', action,
          button: 'left', row: target.bounds.row, column: target.bounds.column, rawCode: 0,
          modifiers: { shift: false, alt: false, ctrl: false } });
        assert.ok(value.messages.some((message) => message.kind === 'activateActionAt'
          && message.actionId === `link:${value.document.snapshot.document.links[0].node}`));
        assert.doesNotMatch(value.host.output(), /_Ga=t,/u, 'graphics disabled preserves ordinary fallback without uploads');
      } finally { await value.close(); }
    });
  }
}

test('pending resize retains accepted image, editor, semantics and hit geometry until the new canvas arrives', async () => {
  const value = await fixture(widePage, { terminalSize: { columns: 160, rows: 20 } });
  try {
    const before = assertPageProjection(value).bounds;
    const document = value.document;
    await value.runtime.dispatch({ kind: 'fixtureState', state: { ...value.runtime.state(), documents: [{ ...document,
      rendering: { ...document.rendering, status: 'rendering', viewport: null, previousViewport: document.rendering.viewport } }] } });
    for (const columns of [240, 140, 240]) {
      await value.runtime.resize({ columns, rows: 20 });
      assert.deepEqual(assertPageProjection(value).bounds, before);
      assert.equal(value.runtime.state().documents[0].rendering.previousViewport.cellBuffer.columns, 159);
    }
    const payload = await value.prepared.controller.renderViewport(document, 2, {
      ...browserPageSize(value.runtime.state(), { columns: 240, rows: 20 }), scrollRow: 0, scrollColumn: 0,
      scrollOffsets: [], overscanBefore: 1, overscanAfter: 1, preferences: browserRenderPreferences(), searchQuery: null });
    await value.runtime.dispatch({ kind: 'fixtureState', state: { ...value.runtime.state(), documents: [{ ...document,
      rendering: { ...document.rendering, status: 'ready', viewport: payload, previousViewport: null, summary: payload.summary } }] } });
    assert.equal(payload.cellBuffer.columns, 239);
    assert.deepEqual(assertPageProjection(value).bounds, before);
  } finally { await value.close(); }
});

test('physical clipping during pending shrink agrees for graphics, fallback, semantics and clicks', async () => {
  const value = await fixture(widePage, { terminalSize: { columns: 240, rows: 20 } });
  try {
    await value.runtime.resize({ columns: 90, rows: 20 });
    const frame = value.runtime.frame();
    const target = frame.hitTargets.find((entry) => entry.id === 'image');
    assert.deepEqual(target.bounds, { row: 5, column: 81, width: 9, height: 4 });
    assert.deepEqual(frame.graphics[0].clip, target.bounds);
    assert.equal(renderFramePlain(frame).split('\n')[4].slice(80, 89), 'IMAGE_MAR');
    assert.ok(JSON.stringify(frame.accessibility).includes('IMAGE_MARKER'));
    await value.runtime.resize({ columns: 80, rows: 20 });
    const clipped = value.runtime.frame();
    assert.equal(clipped.hitTargets.some((entry) => entry.id === 'image'), false);
    assert.equal(clipped.graphics.length, 0);
    assert.doesNotMatch(JSON.stringify(clipped.accessibility), /IMAGE_MARKER/u);
  } finally { await value.close(); }
});


test("alpha media paints artwork without covering native text or native editor cells", async () => {
  const pixelResource = { ...readyImage(), hasAlpha: true, pixels: new Uint8Array([
    255, 0, 0, 128, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 128,
  ]) };
  const value = await fixture('<style>body{margin:0;min-height:64px;background:white;color:black}'
    + 'p{position:absolute;left:0;top:0;margin:0}'
    + 'input{position:absolute;left:0;top:32px;width:128px;height:16px;padding:0;border:0}'
    + 'img{position:absolute;left:0;top:0;width:192px;height:64px}</style>'
    + '<body><p>NATIVE_KEEP</p><input id=q value="EDIT_KEEP"><img src="/a.png" alt="ART"></body>', { pixelResource, renderPreferences: browserRenderPreferences({ COLORTERM: "truecolor", TERM: "xterm-256color" }) });
  try {
    const frame = value.runtime.frame();
    assert.ok(renderFramePlain(frame).includes("NATIVE_KEEP"), renderFramePlain(frame));
    assert.ok(renderFramePlain(frame).includes("EDIT_KEEP"), renderFramePlain(frame));
    assert.ok(frame.graphics.length > 0, "safe parts of the alpha artwork remain graphics: " + JSON.stringify(value.document.rendering.viewport.cellBuffer.images));
    for (const marker of ["NATIVE_KEEP", "EDIT_KEEP"]) {
      for (const origin of markerPositions(frame, marker)) {
        for (const graphic of frame.graphics) {
          const clip = graphic.clip;
          const intersects = origin.row >= clip.row && origin.row < clip.row + clip.height
            && origin.column < clip.column + clip.width && origin.column + marker.length > clip.column;
          assert.equal(intersects, false, `${marker} must remain native glyphs outside every graphics clip`);
        }
      }
    }
    assert.ok(value.document.rendering.viewport.cellBuffer.images.every((image) => image.safeForTransparency));
  } finally { await value.close(); }
});

test("alpha media with an unknown actual backdrop keeps semantic fallback and surrounding native text", async () => {
  const pixelResource = { ...readyImage(), hasAlpha: true,
    pixels: new Uint8Array([255, 0, 0, 128, 0, 0, 0, 0, 255, 0, 0, 128, 0, 0, 0, 0]) };
  const value = await fixture('<style>body{margin:0}img{width:64px;height:32px}</style>'
    + '<p>NATIVE_KEEP</p><img src="/a.png" alt="ART_FALLBACK">', { pixelResource });
  try {
    assert.equal(value.runtime.frame().graphics.length, 0);
    assert.ok(renderFramePlain(value.runtime.frame()).includes("NATIVE_KEEP"));
    assert.ok(JSON.stringify(value.runtime.frame().accessibility).includes("ART_FALLBACK"));
  } finally { await value.close(); }
});

test("alpha media on a proven authored white surface reaches graphics", async () => {
  const pixelResource = { ...readyImage(), hasAlpha: true,
    pixels: new Uint8Array([255, 0, 0, 128, 0, 0, 0, 0, 255, 0, 0, 128, 0, 0, 0, 0]) };
  const value = await fixture('<style>body{margin:0;background:white}img{width:64px;height:32px}</style>'
    + '<body><p>NATIVE_KEEP</p><img src="/a.png" alt="ART"></body>', { pixelResource, renderPreferences: browserRenderPreferences({ COLORTERM: "truecolor", TERM: "xterm-256color" }) });
  try {
    assert.ok(value.runtime.frame().graphics.length > 0,
      JSON.stringify(value.document.rendering.viewport.cellBuffer.images));
    assert.ok(renderFramePlain(value.runtime.frame()).includes("NATIVE_KEEP"));
  } finally { await value.close(); }
});


test("computed CSS mask tint and contain geometry reach the asynchronous prepared graphic", async () => {
  const pixelResource = { ...readyImage(), width: 2, height: 1, hasAlpha: true,
    pixels: new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0]) };
  const value = await fixture('<style>body{margin:0;background:white;color:black}'
    + '#icon{display:inline-block;width:32px;height:32px;background-color:rgb(12,34,56);'
    + 'mask-image:url(/a.png);mask-size:contain;mask-repeat:no-repeat;mask-position:center}</style>'
    + '<body><span id=icon></span><span>NATIVE_KEEP</span></body>',
    { pixelResource, renderPreferences: browserRenderPreferences({ COLORTERM: "truecolor", TERM: "xterm-256color" }) });
  try {
    const frame = value.runtime.frame();
    assert.equal(frame.graphics.length, 1, JSON.stringify(value.document.rendering.viewport.cellBuffer.images));
    const handle = frame.graphics[0].image;
    assert.equal(handle.width, 32); assert.equal(handle.height, 32);
    const pixels = new Uint8Array(32 * 32 * 4).fill(255);
    for (let row = 8; row < 24; row += 1) for (let column = 0; column < 16; column += 1) {
      const offset = (row * 32 + column) * 4;
      pixels[offset] = 12; pixels[offset + 1] = 34; pixels[offset + 2] = 56;
    }
    const expected = rasterImage({ width: 32, height: 32, format: "rgba8", data: pixels });
    assert.equal(handle.contentDigest, expected.contentDigest);
    assert.ok(renderFramePlain(frame).includes("NATIVE_KEEP"));
  } finally { await value.close(); }
});
