import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpFields } from "@ismail-elkorchi/http-client";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTuiRuntime, defineTui } from "@ismail-elkorchi/terminal-ui/tui";
import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { estimatedRetainedCost } from "../../dist/memory/retained-cost.js";
import { browserRasterImage, prepareBrowserImage } from "../../dist/ui/image-presentation.js";
import { browserPageSize, browserRenderPreferences } from "../../dist/ui/document-layout.js";
import { prepareBrowserTui } from "../../dist/ui/run.js";
import { browserView } from "../../dist/ui/view.js";
import { renderDocumentAttachment } from "../../dist/ui/render-worker/document-transfer.js";

const terminalSize = { columns: 50, rows: 16 };
function readyImage(id = "https://images.test/a.png") {
  return Object.freeze({ id, requestUrl: id, owners: [], width: 2, height: 2,
    status: "ready", mimeType: "image/png", pixels: new Uint8Array(16).fill(255) });
}

test("UI raster handles are reused, private copy bytes counted, alpha keeps explicit fallback", () => {
  const resource = readyImage();
  const before = estimatedRetainedCost([resource]);
  assert.equal(browserRasterImage(resource), null);
  prepareBrowserImage(resource);
  const handle = browserRasterImage(resource);
  assert.ok(handle);
  assert.equal(browserRasterImage(resource), handle);
  assert.ok(estimatedRetainedCost([resource]) >= before + resource.pixels.byteLength);
  assert.equal(Object.hasOwn(handle, "data"), false);
  const alpha = { ...readyImage(), status: "failed", failure: "unsupported-alpha", reason: "Decoded alpha is unsupported." };
  prepareBrowserImage(alpha);
  assert.equal(browserRasterImage(alpha), null);
  assert.equal(browserRasterImage(alpha), null);
});

test("one-time worker attachment transfers image metadata without readiness, pixels or raster handles", () => {
  const document = parseWebDocument('<img src="a.png" alt="ALT">', { requestUrl: "https://images.test/", finalUrl: "https://images.test/" });
  const image = readyImage(); prepareBrowserImage(image);
  const attachment = renderDocumentAttachment({ id: "images", documentRevision: 1, stateRevision: 1,
    documentState: createDocumentState(document), snapshot: { document, images: [image], requestUrl: document.requestUrl,
      finalUrl: document.finalUrl, stylesheets: [], styleDiagnostics: [] } });
  assert.deepEqual(Object.keys(attachment.images[0]).sort(), ["height", "id", "owners", "requestUrl", "width"]);
  assert.deepEqual(globalThis.structuredClone(attachment.images), attachment.images);
});

async function fixture(html, { staleDimensions = false, graphics = "none", graphicsBudget,
  imageFailed = false, searchQuery = null, activeMatchIndex = 0 } = {}) {
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
  const ready = readyImage();
  const resource = imageFailed ? { id: ready.id, requestUrl: ready.requestUrl, owners: ready.owners,
    width: ready.width, height: ready.height, mimeType: ready.mimeType, status: "failed",
    failure: "decode-failed", reason: "Fixture decode failure." } : ready;
  prepareBrowserImage(resource);
  document = { ...document, snapshot: { ...document.snapshot, images: staleDimensions ? [{ ...resource, width: null, height: null, status: "pending", pixels: undefined }] : [resource] } };
  const size = browserPageSize(prepared.state, terminalSize);
  const payload = await prepared.controller.renderViewport(document, 1, { ...size, scrollRow: 0, scrollColumn: 0,
    scrollOffsets: [], overscanBefore: 1, overscanAfter: 1, preferences: browserRenderPreferences(), searchQuery });
  document = { ...document, snapshot: { ...document.snapshot, images: [resource] }, rendering: { ...document.rendering,
    viewport: payload, previousViewport: null, summary: payload.summary, status: "ready", committedViewportRevision: 1,
    requestedViewportRevision: 1, error: null },
    search: searchQuery === null ? null : { query: searchQuery, activeMatchIndex, matches: payload.search.matches,
      anchors: new Map(), documentRevision: document.documentRevision, stateRevision: document.stateRevision,
      layoutRevision: payload.layoutRevision, requestGeneration: 1, truncated: false } };
  const state = { ...prepared.state, documents: [document] }, messages = [];
  const host = createMemoryTerminalHost({ terminalSize, capabilities: {
    graphics: { kitty: "supported", sixel: "unsupported", kittyTransport: "direct", cellPixels: { width: 8, height: 16 } },
  } });
  const runtime = createTuiRuntime({ graphics, ...(graphicsBudget === undefined ? {} : { graphicsBudget }), app: defineTui({ id: "image-order", init: () => ({ state }),
    update(current, message) { messages.push(message); return { state: current }; }, view: browserView }),
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
