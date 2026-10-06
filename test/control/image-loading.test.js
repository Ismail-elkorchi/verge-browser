import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { text } from "@ismail-elkorchi/terminal-ui/components";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { createTuiRuntime, defineTui } from "@ismail-elkorchi/terminal-ui/tui";
import { parseWebDocument } from "../../dist/document/index.js";
import { BrowserController } from "../../dist/ui/browser-controller.js";
import { acceptBrowserViewportImages, browserRasterImage, browserViewportImageHandles, prepareBrowserViewportImages } from "../../dist/ui/image-presentation.js";

import { acceptImageResource, acceptViewportImageAdmission, imageSources, MAX_RETAINED_IMAGE_BYTES, retainedImageBytes } from "../../dist/ui/image-loading.js";

function image(overrides = {}) {
  return Object.freeze({ id: "image-1", requestUrl: "https://example.test/photo.png", owners: Object.freeze(["node-1"]),
    width: null, height: null, hasAlpha: null, mimeType: null, status: "pending", ...overrides });
}

function state(resources = [image()]) {
  const snapshot = { document: { replacedContent: [], replaced() { return null; } }, stylesheets: [], styleDiagnostics: [], diagnostics: {}, responseFields: {}, images: resources };
  const document = {
    kind: "ready", id: "tab-1", documentRevision: 3, stateRevision: 7, loading: false, snapshot,
    documentState: { focus: "node-1" }, scrollAnchor: { source: "node-1", rowOffset: 2 },
    formEditors: {}, navigation: { entries: [{ id: "entry-1", documentId: "source-1", snapshot }], index: 0, nextIdentity: 2 }, search: null,
    rendering: { requestKey: "accepted", pendingSearch: null, searchRequestGeneration: 4 },
  };
  return { documents: [document], activeDocumentIndex: 0, recentlyClosed: [] };
}

function message(resource, overrides = {}) {
  return { kind: "imageResource", documentId: "tab-1", documentRevision: 3, resourceRevision: 0, resource, ...overrides };
}

test("image metadata and readiness invalidate viewport proof while preserving interaction", () => {
  const initial = state();
  const metadata = image({ width: 2, height: 1, mimeType: "image/png" });
  const sized = acceptImageResource(initial, message(metadata));
  const before = initial.documents[0];
  const after = sized.documents[0];
  assert.equal(after.stateRevision, before.stateRevision + 1);
  assert.equal(after.rendering.requestKey, null);
  assert.equal(after.rendering.searchRequestGeneration, 5);
  assert.equal(after.documentState, before.documentState);
  assert.equal(after.scrollAnchor, before.scrollAnchor);
  assert.equal(after.formEditors, before.formEditors);
  assert.equal(after.navigation.index, before.navigation.index);
  assert.equal(after.navigation.entries[0].id, before.navigation.entries[0].id);
  assert.equal(after.navigation.entries[0].snapshot.images, after.snapshot.images);
  const ready = image({ ...metadata, status: "ready", pixels: new Uint8Array(8).fill(255) });
  const painted = acceptImageResource(sized, message(ready));
  assert.equal(painted.documents[0].stateRevision, after.stateRevision + 1);
  assert.equal(painted.documents[0].rendering.requestKey, null);
  assert.equal(painted.documents[0].documentState, after.documentState);
  assert.equal(painted.documents[0].snapshot.images[0], ready);
  assert.equal(acceptImageResource(painted, message(metadata)), painted);
});

test("obsolete, inactive, loading and unrelated image completions cannot enter state", () => {
  const initial = state();
  const ready = image({ width: 1, height: 1, status: "ready", pixels: new Uint8Array(4) });
  for (const incoming of [message(ready, { documentRevision: 2 }), message(ready, { documentId: "closed" }),
    message({ ...ready, id: "other" }), message({ ...ready, requestUrl: "https://other.test/photo.png" })]) {
    assert.equal(acceptImageResource(initial, incoming), initial);
  }
  const loading = { ...initial, documents: [{ ...initial.documents[0], loading: true }] };
  assert.equal(acceptImageResource(loading, message(ready)), loading);
  const inactive = { ...initial, activeDocumentIndex: 1, documents: [...initial.documents, { kind: "restoring", id: "tab-2" }] };
  assert.equal(acceptImageResource(inactive, message(ready)), inactive);
});

test("image ownership admission counts shared decoded buffers across closed/history snapshots", () => {
  const ready = image({ status: "ready", pixels: new Uint8Array(24), width: 3, height: 2 });
  const initial = state([ready]);
  const same = initial.documents[0];
  const shared = { ...initial, recentlyClosed: [same], documents: [same, same] };
  assert.equal(retainedImageBytes(shared), 24);
  const historyOnly = image({ id: "older", status: "ready", width: 2, height: 2, pixels: new Uint8Array(16) });
  const pending = image({ id: "new" });
  const mixed = state([pending]);
  mixed.recentlyClosed = [{ ...same, snapshot: { images: [] }, navigation: { entries: [{ snapshot: { images: [historyOnly] } }] } }];
  assert.equal(retainedImageBytes(mixed), 16);
  const oversized = image({ ...pending, width: 1, height: 1, status: "ready",
    pixels: new Uint8Array(MAX_RETAINED_IMAGE_BYTES) });
  const rejected = acceptImageResource(mixed, message(oversized));
  assert.equal(rejected.documents[0].snapshot.images[0].status, "failed");
  assert.equal(rejected.documents[0].snapshot.images[0].failure, "resource-limit");
  assert.equal("pixels" in rejected.documents[0].snapshot.images[0], false);
  assert.equal(retainedImageBytes(rejected), 16);
});

test("source failure settles only pending resources and leaves accepted images intact", () => {
  const ready = image({ status: "ready", pixels: new Uint8Array(4), width: 1, height: 1 });
  const initial = state([ready, image({ id: "next" })]);
  const settled = acceptImageResource(initial, { kind: "imageResourcesFailed", documentId: "tab-1", documentRevision: 3, resourceRevision: 0 });
  assert.equal(settled.documents[0].snapshot.images[0], ready);
  assert.equal(settled.documents[0].snapshot.images[1].status, "failed");
  assert.equal(settled.documents[0].stateRevision, initial.documents[0].stateRevision + 1);
  assert.equal(settled.documents[0].rendering.requestKey, null);
  assert.equal(settled.documents[0].documentState, initial.documents[0].documentState);
  assert.deepEqual(imageSources({}, settled), []);
});

test("image source starts after admission and awaits reliable completion backpressure", async () => {
  const initial = state();
  let calls = 0;
  let advanced = false;
  const controller = { async acquireImages(documentId, snapshot, signal, onResource) {
    calls += 1;
    assert.equal(documentId, initial.documents[0].id);
    assert.equal(snapshot, initial.documents[0].snapshot);
    signal.throwIfAborted();
    await onResource(image({ width: 2, height: 1 }));
    advanced = true;
  } };
  const sources = imageSources(controller, initial);
  assert.equal(calls, 0);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].generation, "3:0");
  assert.equal(sources[0].channel.capacity, 1);
  let release;
  const emitted = [];
  const run = sources[0].run({ signal: new globalThis.AbortController().signal }, { emit(emission) {
    emitted.push(emission);
    return new Promise((resolve) => { release = resolve; });
  } });
  assert.equal(calls, 1);
  assert.equal(advanced, false);
  assert.equal(emitted[0].kind, "reliable");
  assert.equal(emitted[0].message.kind, "imageResource");
  release();
  await run;
  assert.equal(advanced, true);
});

test("aborted image source does not turn cancellation into a failure completion", async () => {
  const abort = new globalThis.AbortController();
  const reason = new Error("tab removed");
  const controller = { async acquireImages() { abort.abort(reason); throw reason; } };
  const [source] = imageSources(controller, state());
  const emitted = [];
  await assert.rejects(source.run({ signal: abort.signal }, { async emit(value) { emitted.push(value); } }), reason);
  assert.deepEqual(emitted, []);
});

test("runtime accepts the final image and retires its source without an emission deadlock", { timeout: 5000 }, async () => {
  let completed = false;
  const controller = { async acquireImages(_documentId, _snapshot, signal, onResource) {
    await onResource(image({ width: 1, height: 1, mimeType: "image/png" }));
    signal.throwIfAborted();
    await onResource(image({ width: 1, height: 1, mimeType: "image/png", status: "ready", pixels: new Uint8Array(4).fill(255) }));
    completed = true;
  } };
  const app = defineTui({ id: "image-source-lifecycle", init: () => ({ state: state() }),
    update: (current, incoming) => ({ state: acceptImageResource(current, incoming) }),
    view: (current) => text({ content: current.documents[0].snapshot.images[0].status }),
    subscriptions: (current) => imageSources(controller, current) });
  const runtime = createTuiRuntime({ app, host: createMemoryTerminalHost({ terminalSize: { columns: 20, rows: 3 } }) });
  try {
    await runtime.start();
    const deadline = Date.now() + 3000;
    while (runtime.state().documents[0].snapshot.images[0].status !== "ready") {
      assert.ok(Date.now() < deadline, "image completion did not settle");
      await delay(5);
    }
    assert.deepEqual(imageSources(controller, runtime.state()), []);
    assert.equal(runtime.state().documents[0].stateRevision, 9);
    await delay(0);
    assert.equal(completed, true);
  } finally { await runtime.dispose(); }
});

test("runtime disposal cancels pending image acquisition", { timeout: 5000 }, async () => {
  let observedSignal;
  let cancelled = false;
  const controller = { async acquireImages(_documentId, _snapshot, signal) {
    observedSignal = signal;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled = true;
      reject(signal.reason);
    }, { once: true }));
  } };
  const app = defineTui({ id: "image-source-disposal", init: () => ({ state: state() }),
    update: (current, incoming) => ({ state: acceptImageResource(current, incoming) }),
    view: () => text({ content: "Reading remains available" }),
    subscriptions: (current) => imageSources(controller, current) });
  const runtime = createTuiRuntime({ app, host: createMemoryTerminalHost({ terminalSize: { columns: 30, rows: 3 } }) });
  await runtime.start();
  assert.equal(observedSignal.aborted, false);
  await runtime.dispose();
  assert.equal(cancelled, true);
});

test("switching tabs waits for retiring decoder workspace and revokes cancelled waiters", { timeout: 5000 }, async () => {
  let finishCleanup;
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  const starts = [];
  let acquisitionCount = 0;
  let cleanupFails = false;
  const controller = new BrowserController({
    store: { httpSession: {}, async flush() {} },
    services: { async close() {} },
    renderWorkerFactory: () => ({ retainedViewports() { return []; }, cancelDocument() {}, async close() {} }),
    createAcquisition: () => {
      const id = ++acquisitionCount;
      return {
        async acquire(url) {
          return { requestUrl: url, finalUrl: url, document: parseWebDocument("<p>Readable page</p>", { requestUrl: url, finalUrl: url }),
            stylesheets: [], styleDiagnostics: [], diagnostics: { parseMode: "text" }, responseFields: {}, status: 200 };
        },
        async acquireImages(_snapshot, { signal }) {
          starts.push(id);
          if (cleanupFails) throw new Error("Decoder cleanup failed.");
          if (id === 1) {
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            await cleanup;
            signal.throwIfAborted();
          }
        },
        async close() {}, async destroy() {},
      };
    },
  });
  const placeholder = controller.placeholder("https://example.test/one");
  controller.configureRestoration(placeholder);
  const restored = await controller.restorePlaceholder(placeholder);
  const first = { ...restored, snapshot: { ...restored.snapshot,
    images: [image({ status: "ready", hasAlpha: true, width: 2, height: 1, pixels: new Uint8Array(8) })] } };
  const opened = await controller.openNewFromDocument(first, "https://example.test/two");
  const second = { ...opened, snapshot: { ...opened.snapshot,
    images: [image({ status: "ready", hasAlpha: true, width: 4, height: 1, pixels: new Uint8Array(16) })] } };
  const retired = new globalThis.AbortController();
  const waiting = new globalThis.AbortController();
  const successor = new globalThis.AbortController();
  const noop = async () => {};
  const bytes = () => retainedImageBytes({ documents: [], recentlyClosed: [] }, undefined, [], [], controller.retainedImageSnapshots());
  const alreadyAborted = new globalThis.AbortController();
  alreadyAborted.abort(new Error("already cancelled"));
  await assert.rejects(controller.acquireImages(first.id, first.snapshot, alreadyAborted.signal, noop), /already cancelled/u);
  assert.equal(bytes(), 0, "a pre-aborted request never registers an owner");
  assert.deepEqual(starts, []);
  const one = controller.acquireImages(first.id, first.snapshot, retired.signal, noop);
  const oneRejected = assert.rejects(one, /retired/u);
  const two = controller.acquireImages(second.id, second.snapshot, waiting.signal, noop);
  const twoRejected = assert.rejects(two, /obsolete/u);
  retired.abort(new Error("retired"));
  await delay(0);
  assert.deepEqual(starts, [1]);
  assert.equal(bytes(), 24, "retiring and queued acquisition snapshots remain counted after UI eviction");
  waiting.abort(new Error("obsolete"));
  await twoRejected;
  assert.equal(bytes(), 8, "a cancelled waiter releases only its own snapshot owner");
  const three = controller.acquireImages(second.id, second.snapshot, successor.signal, noop);
  await delay(0);
  assert.deepEqual(starts, [1]);
  assert.equal(bytes(), 24, "retiring pixels cannot be reclaimed before decoder cleanup settles");
  const incoming = image({ status: "ready", width: 1, height: 1, pixels: new Uint8Array(MAX_RETAINED_IMAGE_BYTES - 8) });
  const rejected = acceptImageResource(state(), message(incoming), [], [], controller.retainedImageSnapshots());
  assert.equal(rejected.documents[0].snapshot.images[0].failure, "resource-limit");
  finishCleanup();
  await Promise.all([oneRejected, three]);
  assert.deepEqual(starts, [1, 2]);
  assert.equal(bytes(), 0);
  cleanupFails = true;
  await assert.rejects(controller.acquireImages(second.id, second.snapshot, successor.signal, noop), /Decoder cleanup failed/u);
  assert.equal(bytes(), 0, "failed acquisition cleanup also releases its snapshot owner");
  await controller.close();
  assert.deepEqual(controller.retainedImageSnapshots(), []);
});

test("same-generation image sources release old viewport rasters after forced GC", { timeout: 20_000 }, async () => {
  if (globalThis.gc === undefined) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fileURLToPath } = await import("node:url");
    const environment = { ...process.env };
    delete environment["NODE_TEST_CONTEXT"];
    await promisify(execFile)(process.execPath, ["--expose-gc", "--test",
      "--test-name-pattern=same-generation image sources release old viewport rasters", fileURLToPath(import.meta.url)], { env: environment });
    return;
  }
  const { setImmediate } = await import("node:timers/promises");
  const megabyte = 1024 * 1024;
  const resources = Array.from({ length: 3 }, (_, index) => image({ id: `image-${index}`,
    requestUrl: `https://example.test/${index}.png`, width: 2048, height: 1024,
    hasAlpha: true, status: "ready", pixels: new Uint8Array(8 * megabyte) }));
  resources.push(image({ id: "slow", requestUrl: "https://example.test/slow.png" }));
  let acquisitions = 0;
  const controller = new BrowserController({ store: { httpSession: {}, async flush() {} }, services: { async close() {} },
    renderWorkerFactory: () => ({ retainedViewports() { return []; }, cancelDocument() {}, async close() {} }),
    createAcquisition: () => ({
      async acquire(url) {
        return { requestUrl: url, finalUrl: url, document: parseWebDocument("<p>Readable page</p>", { requestUrl: url, finalUrl: url }),
          images: resources, stylesheets: [], styleDiagnostics: [], diagnostics: { parseMode: "text" }, responseFields: {}, status: 200 };
      },
      async acquireImages(_snapshot, { signal }) {
        acquisitions += 1;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
      async close() {}, async destroy() {},
    }),
  });
  const placeholder = controller.placeholder("https://example.test/");
  controller.configureRestoration(placeholder);
  const document = await controller.restorePlaceholder(placeholder);
  const viewport = () => ({ images: resources.slice(0, 3).map((resource) => ({ id: resource.id,
    resourceId: resource.id, naturalWidth: resource.width, naturalHeight: resource.height, hasAlpha: true,
    safeForTransparency: true, compositingBackdrop: { r: 255, g: 255, b: 255, a: 1 } })) });
  const withViewport = (cellBuffer, revision) => ({ activeDocumentIndex: 0, recentlyClosed: [], documents: [{ ...document,
    stateRevision: revision, rendering: { ...document.rendering, committedViewportRevision: revision,
      viewport: { cellBuffer }, previousViewport: null } }] });
  let initialViewport = viewport();
  let initial = withViewport(initialViewport, 1);
  await prepareBrowserViewportImages(resources, initialViewport, () => MAX_RETAINED_IMAGE_BYTES - retainedImageBytes(initial));
  acceptBrowserViewportImages(initialViewport);
  const oldHandles = browserViewportImageHandles(initialViewport).map((handle) => new globalThis.WeakRef(handle));
  const oldViewport = new globalThis.WeakRef(initialViewport);
  const runtime = createTuiRuntime({ host: createMemoryTerminalHost({ terminalSize: { columns: 20, rows: 3 } }),
    app: defineTui({ id: "image-source-ownership", init: () => ({ state: initial }),
      view: (current) => text({ content: String(current.documents[0].stateRevision) }),
      subscriptions: (current) => [controller.imageRetentionSource(current), ...imageSources(controller, current)],
      update(previous, incoming) {
        controller.reserveImageRetentionState(previous, incoming.state);
        return { state: incoming.state };
      },
    }) });
  const bytes = () => retainedImageBytes(runtime.state(), undefined, controller.retainedImageViewports(),
    controller.retainedImageStates(), controller.retainedImageSnapshots());
  try {
    await runtime.start();
    initial = null; initialViewport = null;
    assert.equal(bytes(), 48 * megabyte);
    for (const revision of [2, 3]) {
      const next = viewport();
      await prepareBrowserViewportImages(resources, next, () => MAX_RETAINED_IMAGE_BYTES - bytes());
      await runtime.dispatch({ state: withViewport(next, revision) });
      acceptBrowserViewportImages(next);
      for (let attempt = 0; attempt < 5; attempt += 1) { await setImmediate(); globalThis.gc(); }
    }
    assert.equal(acquisitions, 1, "same resource generation preserves the active slow acquisition");
    assert.equal(bytes(), 48 * megabyte);
    const uncountedBytes = oldHandles.reduce((sum, reference) => sum + (reference.deref()?.byteLength ?? 0), 0);
    assert.ok(bytes() + uncountedBytes <= MAX_RETAINED_IMAGE_BYTES, "a source must not hide its starting raster graph from the shared cap");
    assert.equal(uncountedBytes, 0);
    assert.equal(oldViewport.deref(), undefined);
  } finally { await runtime.dispose(); await controller.close(); }
  assert.deepEqual(controller.retainedImageSnapshots(), []);
});


test("new CSS resource admission advances source generation without completion restart loops", () => {
  const initial = state();
  const discovery = [{ id: "https://example.test/icon.svg", requestUrl: "https://example.test/icon.svg", owners: ["node-2"], width: null, height: null, hasAlpha: null }];
  const admitted = acceptViewportImageAdmission(initial.documents[0], discovery);
  const updated = { ...initial, documents: [admitted] };
  assert.equal(imageSources({}, initial)[0].generation, "3:0");
  assert.equal(imageSources({}, updated)[0].generation, "3:1");
  assert.equal(admitted.snapshot.images.length, 2);
  assert.equal(admitted.navigation.entries[0].snapshot.images, admitted.snapshot.images);
  assert.equal(acceptViewportImageAdmission(admitted, discovery), admitted);
  const sized = acceptImageResource(updated, message(image({ width: 2, height: 2, hasAlpha: null }), { resourceRevision: 1 }));
  assert.equal(imageSources({}, sized)[0].generation, "3:1");
  const failedOld = acceptImageResource(updated, { kind: "imageResourcesFailed", documentId: "tab-1", documentRevision: 3, resourceRevision: 1, resourceIds: ["image-1"] });
  assert.equal(failedOld.documents[0].snapshot.images.find((image) => image.id === "image-1").status, "failed");
  assert.equal(failedOld.documents[0].snapshot.images.find((image) => image.id === discovery[0].id).status, "pending");
});

test("retiring URL completion cannot replace the accepted CSS owners", () => {
  const requestUrl = "https://example.test/icon.svg";
  const original = image({ id: requestUrl, requestUrl, owners: ["img-owner"] });
  const initial = state([original]);
  initial.documents[0].snapshot.document = { replacedContent: [{ kind: "image", source: requestUrl, node: "img-owner" }],
    replaced(owner) { return this.replacedContent.find((image) => image.node === owner) ?? null; } };
  const admitted = acceptViewportImageAdmission(initial.documents[0], [{ ...original, owners: ["pseudo-owner"] }]);
  const ready = { ...original, status: "ready", width: 1, height: 1, hasAlpha: false, pixels: new Uint8Array(4).fill(255) };
  const accepted = acceptImageResource({ ...initial, documents: [admitted] }, message(ready));
  assert.deepEqual(accepted.documents[0].snapshot.images[0].owners, ["img-owner", "pseudo-owner"]);
  assert.equal(accepted.documents[0].snapshot.images[0].pixels, ready.pixels);
});

test("decoded alpha metadata invalidates an accepted opaque placement proof", () => {
  const initial = state([image({ width: 1, height: 1 })]);
  const accepted = acceptImageResource(initial, message(image({ width: 1, height: 1, hasAlpha: true, status: "ready", pixels: new Uint8Array(4) })));
  assert.equal(accepted.documents[0].stateRevision, initial.documents[0].stateRevision + 1);
  assert.equal(accepted.documents[0].rendering.requestKey, null);
});

test("accepting discovered mask owners keeps the newly committed viewport's decoded binding", async () => {
  const requestUrl = "https://example.test/shared.png";
  const ready = image({ id: requestUrl, requestUrl, owners: ["img-owner"], width: 2, height: 1,
    status: "ready", hasAlpha: true, pixels: new Uint8Array(8) });
  const initial = state([ready]);
  initial.documents[0].snapshot.document = { replacedContent: [{ kind: "image", source: requestUrl, node: "img-owner" }],
    replaced(owner) { return this.replacedContent.find((image) => image.node === owner) ?? null; } };
  const paint = { id: "paint", resourceId: requestUrl, naturalWidth: 2, naturalHeight: 1, hasAlpha: true,
    safeForTransparency: true, compositingBackdrop: { r: 255, g: 255, b: 255, a: 1 } };
  const viewport = { images: [paint] };
  await prepareBrowserViewportImages([ready], viewport, () => 100);
  acceptBrowserViewportImages(viewport);
  const before = browserRasterImage(ready, paint, viewport);
  const document = { ...initial.documents[0], rendering: { ...initial.documents[0].rendering, viewport: { cellBuffer: viewport } } };
  const accepted = acceptViewportImageAdmission(document, [{ ...ready, owners: ["mask-owner"] }]);
  assert.notEqual(accepted.snapshot.images[0], ready);
  assert.deepEqual(accepted.snapshot.images[0].owners, ["img-owner", "mask-owner"]);
  assert.ok(before);
  assert.equal(browserRasterImage(accepted.snapshot.images[0], paint, viewport), before);
  assert.equal(retainedImageBytes({ ...initial, documents: [accepted] }), 16);
});
