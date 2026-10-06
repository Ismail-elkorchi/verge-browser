import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { performance } from "node:perf_hooks";
import { commitNavigation, emptyHistory } from "../../dist/app/navigation-history.js";
import { BrowserController } from "../../dist/ui/browser-controller.js";
import { EventEmitter } from "node:events";
import test from "node:test";
import { RenderWorkerClient } from "../../dist/ui/render-worker/client.js";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { acceptBrowserViewportImages, browserRasterImage, discardBrowserViewportImages, prepareBrowserViewportImages } from "../../dist/ui/image-presentation.js";
import { acceptImageResource, retainedImageBytes, MAX_RETAINED_IMAGE_BYTES } from "../../dist/ui/image-loading.js";
import { text } from "@ismail-elkorchi/terminal-ui/components";
import { createMemoryTerminalHost, failedTerminalWrite } from "@ismail-elkorchi/terminal-ui/host";
import { createTuiRuntime, defineTui } from "@ismail-elkorchi/terminal-ui/tui";

class ControlledWorker extends EventEmitter {
  requests = [];
  terminated = 0;
  failure = null;
  postMessage(request) {
    if (this.failure !== null) throw this.failure;
    this.requests.push(request);
    this.emit("posted", request);
  }
  nextRequest(kind, after = 0) {
    const existing = this.requests.find((request) => request.kind === kind && request.requestId > after);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const posted = (request) => {
        if (request.kind !== kind || request.requestId <= after) return;
        this.off("posted", posted);
        resolve(request);
      };
      this.on("posted", posted);
    });
  }
  respond(response) { this.emit("message", response); }
  async terminate() { this.terminated += 1; this.emit("exit", 0); return 0; }
}

function fixture(options = {}) {
  const worker = new ControlledWorker();
  const client = new RenderWorkerClient({ transport: worker, shutdownDeadlineMilliseconds: 10, ...options });
  const document = parseWebDocument("<p>worker transport</p>", { requestUrl: "https://example.test/", finalUrl: "https://example.test/" });
  const snapshot = { document, requestUrl: document.requestUrl, finalUrl: document.finalUrl, stylesheets: [], styleDiagnostics: [], diagnostics: { parseMode: "text" } };
  return { worker, client, document: {
    navigation: commitNavigation(emptyHistory(), snapshot, "push", { kind: "direct" }),
    id: "A", documentRevision: 1, stateRevision: 1, documentState: createDocumentState(document),
    snapshot,
  } };
}

async function attach({ worker, client, document }) {
  const attached = client.attach(document);
  assert.equal(worker.requests.at(-1)?.kind, "attach-document");
  worker.respond({ kind: "acknowledged", requestId: worker.requests.at(-1).requestId });
  await attached;
}

const parameters = { columns: 80, rows: 24, scrollRow: 0, overscanBefore: 2, overscanAfter: 3, searchQuery: null,
  preferences: { unicode: true, ambiguousWidth: 1, colorDepth: 24, colorScheme: "dark", reducedMotion: false, hover: "none", pointer: "none" } };

function viewport(request, identity, summary) {
  return { kind: "viewport-ready", requestId: request.requestId, payload: {
    documentId: request.documentId, documentRevision: request.documentRevision, stateRevision: request.stateRevision, viewportRevision: request.viewportRevision,
    summaryIdentity: identity, layoutRevision: identity, summary, visibleImages: [],
  } };
}

const summary = { identity: "layout-1", documentRowCount: 500, incomplete: [], scrollAnchors: [{ documentNode: "target", row: 300 }],
  styleOutcome: { status: "complete", computedNodes: 1 }, styleDiagnostics: [], omittedStyleDiagnosticCount: 0,
  focusOrder: [{ node: "target", scrollOwner: null, actionId: "link:target", actionKind: "link", topRow: 300, bottomRow: 301 }], authorStateDependencies: [] };

test("transport-held pixels stay counted and immutable through failed publication and candidate retry", async () => {
  const f = fixture();
  const controller = new BrowserController({ store: { async flush() {} }, services: { async close() {} },
    renderWorkerFactory: () => f.client, createAcquisition: () => { throw new Error("unexpected acquisition"); } });
  try {
    await attach(f);
    const work = f.client.renderViewport(f.document, 1, parameters);
    const image = { id: "art", requestUrl: "https://example.test/art.png", owners: [], width: 2, height: 1,
      hasAlpha: true, status: "ready", mimeType: "image/png", pixels: new Uint8Array(8) };
    const paint = { id: "paint", resourceId: image.id, naturalWidth: 2, naturalHeight: 1,
      hasAlpha: true, safeForTransparency: true, compositingBackdrop: { r: 255, g: 255, b: 255, a: 1 } };
    const response = viewport(f.worker.requests.at(-1), "layout-1", summary);
    f.worker.respond({ ...response, payload: { ...response.payload, cellBuffer: { images: [paint] } } });
    const payload = await work;
    await prepareBrowserViewportImages([image], payload.cellBuffer, () => 100);
    acceptBrowserViewportImages(payload.cellBuffer); f.client.acknowledgeViewport(payload);
    const snapshot = { ...f.document.snapshot, images: [image] };
    const document = { ...f.document, kind: "ready", snapshot, navigation: { entries: [{ snapshot }] },
      rendering: { viewport: payload, previousViewport: null } };
    const state = { documents: [document], recentlyClosed: [], activeDocumentIndex: 0 };
    const handle = browserRasterImage(image, paint, payload.cellBuffer);
    assert.ok(handle);
    for (const visible of [state,
      { ...state, documents: [{ ...document, rendering: { viewport: null, previousViewport: payload } }] },
      { documents: [], recentlyClosed: [document] }]) {
      controller.observeImageRetentionState(visible);
      assert.equal(browserRasterImage(image, paint, payload.cellBuffer), handle);
      assert.equal(retainedImageBytes(visible), 16);
    }
    const navigated = { ...state, documents: [{ ...document, rendering: { viewport: null, previousViewport: null } }] };
    controller.observeImageRetentionState(navigated);
    assert.ok([...f.client.retainedViewports()].includes(payload), "the actual transport still owns its old payload");
    assert.equal(browserRasterImage(image, paint, payload.cellBuffer), handle, "speculative reducer observation cannot retire accepted pixels");
    const bytes = (value = navigated, addition) => retainedImageBytes(value, addition, controller.retainedImageViewports());
    assert.equal(bytes(), 16, "transport-only raster bytes count even when the speculative state has no viewport");
    const pending = { ...image, id: "next", requestUrl: "https://example.test/next.png", status: "pending", pixels: undefined };
    const incoming = { ...pending, status: "ready", pixels: new Uint8Array(MAX_RETAINED_IMAGE_BYTES - 8) };
    const admitting = { ...navigated, documents: [{ ...navigated.documents[0], snapshot: { ...snapshot, images: [image, pending] } }] };
    const rejected = acceptImageResource(admitting, { kind: "imageResource", documentId: document.id,
      documentRevision: document.documentRevision, resourceRevision: document.snapshot.imageResourceRevision ?? 0,
      resource: incoming }, controller.retainedImageViewports());
    assert.equal(rejected.documents[0].snapshot.images[1].failure, "resource-limit");

    const nextPaint = { ...paint, compositingBackdrop: { r: 0, g: 0, b: 0, a: 1 } };
    const next = { ...payload, viewportRevision: 2, cellBuffer: { images: [nextPaint] } };
    await prepareBrowserViewportImages([image], next.cellBuffer, () => MAX_RETAINED_IMAGE_BYTES - bytes());
    assert.equal(bytes(), 24);
    const memory = createMemoryTerminalHost({ terminalSize: { columns: 30, rows: 3 } });
    let failWrite = false, acknowledged = false;
    const host = { ...memory, write: (...args) => failWrite
      ? Promise.resolve(failedTerminalWrite("image-publication-test", new Error("rejected output"))) : memory.write(...args) };
    const runtime = createTuiRuntime({ host, app: defineTui({ id: "image-publication", init: () => ({ state }),
      subscriptions: (value) => [controller.imageRetentionSource(value)],
      view: (value) => text({ content: value === state ? "accepted frame" : "candidate frame" }),
      update(previous) {
        controller.reserveImageRetentionState(previous, navigated);
        return { state: navigated, effects: [{ id: "accepted", run() {
          acknowledged = true; controller.acknowledgeViewport(next); return Promise.resolve({ kind: "none" });
        } }] };
      } }) });
    try {
      await runtime.start(); failWrite = true;
      await assert.rejects(runtime.dispatch({ kind: "navigate" }));
      assert.equal(runtime.state(), state);
      assert.equal(acknowledged, false, "acceptance effects wait for actual publication");
      assert.equal(browserRasterImage(image, paint, payload.cellBuffer), handle);
      assert.equal(bytes(), 24, "unpublished candidate remains reserved alongside the accepted transport owner");
      discardBrowserViewportImages(next.cellBuffer);
      assert.equal(bytes(), 16);
      await prepareBrowserViewportImages([image], next.cellBuffer, () => MAX_RETAINED_IMAGE_BYTES - bytes());
      assert.ok(browserRasterImage(image, nextPaint, next.cellBuffer), "a discarded publication can be prepared again");
      discardBrowserViewportImages(next.cellBuffer);
      assert.equal(bytes(), 16);
    } finally { failWrite = false; await runtime.dispose(); discardBrowserViewportImages(next.cellBuffer); }
  } finally { await controller.close(); }
});

test("image state ownership coalesces batches and adopts only publication-admitted subscription state", async () => {
  const f = controllerFixture();
  const state = (size, label, block = false) => {
    const image = { id: label, requestUrl: `https://example.test/${label}.png`, owners: [], width: size / 4, height: 1,
      hasAlpha: true, status: "ready", mimeType: "image/png", pixels: new Uint8Array(size) };
    const snapshot = { images: [image] };
    return { label, block, documents: [{ kind: "ready", snapshot, navigation: { entries: [{ snapshot }] },
      rendering: { viewport: null, previousViewport: null } }], recentlyClosed: [] };
  };
  const initial = state(8, "initial"), intermediate = state(16, "intermediate"), published = state(24, "published");
  f.controller.reserveImageRetentionState(initial, initial);
  const memory = createMemoryTerminalHost({ terminalSize: { columns: 30, rows: 3 } });
  let failWrite = false;
  const writes = [];
  const host = { ...memory, write: (...args) => {
    writes.push(f.controller.retainedImageStates().map((value) => value.label));
    return failWrite ? Promise.resolve(failedTerminalWrite("image-state-test", new Error("rejected output"))) : memory.write(...args);
  } };
  const runtime = createTuiRuntime({ host, runtimePolicy: { maxOwnedSources: 1 }, app: defineTui({ id: "image-state", init: () => ({ state: initial }),
    subscriptions: (value) => [f.controller.imageRetentionSource(value), ...(value.block
      ? [{ id: "over-admission", generation: 1, channel: { capacity: 1 }, async run() {} }] : [])],
    view: (value) => text({ content: value.label }),
    update(previous, message) {
      f.controller.reserveImageRetentionState(previous, message.state);
      return { state: message.state };
    } }) });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const bytes = () => retainedImageBytes(runtime.state(), undefined, [], f.controller.retainedImageStates());
  try {
    await runtime.start(); await settle();
    const messages = runtime.metrics().dispatchedMessages;
    await runtime.dispatchMany([{ state: intermediate }, { state: published }]); await settle();
    assert.deepEqual(writes.at(-1), ["initial", "published"], "intermediate reducer states never replace the accepted owner");
    assert.deepEqual(f.controller.retainedImageStates(), [published]);
    assert.equal(bytes(), 24);
    assert.equal(runtime.metrics().dispatchedMessages, messages + 2, "retention subscriptions emit no completion messages");
    const rejected = state(32, "rejected"); failWrite = true;
    await assert.rejects(runtime.dispatch({ state: rejected }));
    assert.equal(runtime.state(), published);
    assert.deepEqual(f.controller.retainedImageStates(), [published, rejected]);
    assert.equal(bytes(), 56, "actual accepted and live speculative decoded-only pixels both count");
    failWrite = false;
    const denied = state(40, "denied", true), written = writes.length;
    await assert.rejects(runtime.dispatch({ state: denied }), /source_generations/u);
    assert.equal(runtime.state(), published);
    assert.equal(writes.length, written, "subscription admission fails before output");
    assert.deepEqual(f.controller.retainedImageStates(), [published, denied], "one candidate replaces the rejected candidate without a chain");
    const recovered = state(48, "recovered");
    await runtime.dispatch({ state: recovered }); await settle();
    assert.deepEqual(f.controller.retainedImageStates(), [recovered]);
    assert.equal(bytes(), 48);
  } finally { failWrite = false; await runtime.dispose(); await f.controller.close(); }
  assert.deepEqual(f.controller.retainedImageStates(), []);
});

test("summary receipt survives rejection of its viewport and acknowledges only held identity", async () => {
  const f = fixture();
  try {
    await attach(f);
    const a = f.client.renderViewport(f.document, 1, parameters);
    const requestA = f.worker.requests.at(-1);
    const b = f.client.renderViewport(f.document, 2, parameters);
    f.worker.respond(viewport(requestA, "layout-1", summary));
    await a; // The UI discards A because B is now requested.
    const requestB = f.worker.requests.at(-1);
    f.worker.respond(viewport(requestB, "layout-1", null));
    const result = await b;
    assert.equal(result.summary.identity, result.summaryIdentity);
    assert.equal(result.summary.documentRowCount, 500);
    assert.equal(result.summary.scrollAnchorByDocumentNode.get("target").row, 300);
    assert.equal(result.summary.focusOrder[0].topRow, 300);
    assert.equal(result.summary.focusOrder[0].scrollOwner, null);
    const c = f.client.renderViewport(f.document, 3, parameters);
    const requestC = f.worker.requests.at(-1);
    assert.equal(requestC.heldSummaryIdentity, "layout-1");
    f.worker.respond(viewport(requestC, "layout-1", null));
    await c;
  } finally { await f.client.close(); }
});

test("unexpected clean worker exit settles pending requests and records failure", async () => {
  const f = fixture();
  try {
    const pending = f.client.metrics();
    const rejected = assert.rejects(pending, /exited/u);
    f.worker.emit("exit", 0);
    await rejected;
    assert.equal(f.client.failed, true);
  } finally { await f.client.close(); }
});

test("a completed search arriving after its replacement request is rejected by generation", async () => {
  const f = fixture();
  try {
    await attach(f);
    const first = f.client.search(f.document, "earlier", parameters);
    const requestA = f.worker.requests.at(-1);
    // Work is complete, but its response is held at the transport boundary.
    const responseA = { kind: "search-ready", requestId: requestA.requestId, result: { query: "earlier" } };
    const latest = f.client.search(f.document, "latest", parameters);
    const settled = Promise.allSettled([first, latest]);
    f.worker.respond(responseA);
    const requestB = f.worker.requests.at(-1);
    f.worker.respond({ kind: "search-ready", requestId: requestB.requestId, result: { query: "latest" } });
    const outcomes = await settled;
    assert.equal(outcomes[0].status, "rejected");
    assert.equal(outcomes[0].reason.name, "AbortError");
    assert.equal(outcomes[1].status, "fulfilled");
    assert.equal(outcomes[1].value.query, "latest");
    assert.equal(f.client.pendingRequestCount, 0);
  } finally { await f.client.close(); }
});

test("synchronous transport failure removes its pending request", async () => {
  const f = fixture();
  try {
    f.worker.failure = new Error("clone failed");
    await assert.rejects(f.client.metrics(), /clone failed/u);
    assert.equal(f.client.pendingRequestCount, 0);
  } finally { await f.client.close(); }
});

test("concurrent close cancels document work before bounded disposal and settles every promise", async () => {
  const f = fixture();
  await attach(f);
  const pending = f.client.renderViewport(f.document, 1, parameters);
  const settled = assert.rejects(pending, { name: "AbortError" });
  const request = f.worker.requests.at(-1);
  const first = f.client.close();
  const second = f.client.close();
  assert.equal(first, second);
  assert.notEqual(Atomics.load(new Int32Array(request.documentCancellation), 0), request.documentGeneration);
  assert.notEqual(Atomics.load(new Int32Array(request.viewportCancellation), 0), request.viewportGeneration);
  await Promise.all([first, second, settled]);
  assert.equal(f.worker.terminated, 1);
  assert.equal(f.client.pendingRequestCount, 0);
  await assert.rejects(f.client.metrics(), /closed|disposed/u);
});

test("returning to an earlier summary requires that exact identity", async () => {
  const f = fixture();
  try {
    await attach(f);
    for (const [revision, identity] of [[1, "layout-1"], [2, "layout-2"], [3, "layout-1"]]) {
      const pending = f.client.renderViewport(f.document, revision, parameters);
      const request = f.worker.requests.at(-1);
      assert.notEqual(request.heldSummaryIdentity, identity);
      f.worker.respond(viewport(request, identity, { ...summary, identity, documentRowCount: revision === 2 ? 900 : 500 }));
      const rendered = await pending;
      assert.equal(rendered.summary.identity, identity);
      assert.equal(rendered.summary.documentRowCount, revision === 2 ? 900 : 500);
    }
    const missing = f.client.renderViewport(f.document, 4, parameters);
    f.worker.respond(viewport(f.worker.requests.at(-1), "missing", null));
    await assert.rejects(missing, /unavailable document summary/u);
  } finally { await f.client.close(); }
});

test("worker queue coalesces viewport jobs and bounds admission", async () => {
  const f = fixture();
  try {
    await attach(f);
    const promises = Array.from({ length: 200 }, (_, index) => f.client.renderViewport(f.document, index + 1, parameters));
    const results = Promise.allSettled(promises);
    assert.equal(f.client.pendingRequestCount, 2);
    const initial = f.worker.requests.at(-1);
    f.worker.respond(viewport(initial, "layout-1", summary));
    f.worker.respond(viewport(f.worker.requests.at(-1), "layout-1", null));
    assert.equal((await results).filter((result) => result.status === "fulfilled").length, 2);
    const metrics = Array.from({ length: 200 }, () => f.client.metrics());
    const settled = Promise.allSettled(metrics);
    assert.ok(f.client.pendingRequestCount <= 128);
    await f.client.close();
    assert.equal((await settled).filter((result) => result.status === "rejected").length, 200);
  } finally { await f.client.close(); }
});

function controllerFixture() {
  const f = fixture();
  const controller = new BrowserController({
    store: { async flush() {} }, services: { async close() {} },
    createAcquisition: () => { throw new Error("unexpected session allocation"); }, renderWorkerFactory: () => f.client,
  });
  return { ...f, controller };
}

function acknowledge(worker, request) { worker.respond({ kind: "acknowledged", requestId: request.requestId }); }

async function controllerViewport(f, document, revision = 1) {
  const previous = f.worker.requests.at(-1)?.requestId ?? 0;
  const pending = f.controller.renderViewport(document, revision, parameters);
  const attachment = await f.worker.nextRequest("attach-document", previous);
  acknowledge(f.worker, attachment);
  const request = await f.worker.nextRequest("request-viewport", attachment.requestId);
  f.worker.respond(viewport(request, "layout-1", summary));
  return pending;
}

test("closing a document during attachment prevents an old acknowledgement from restoring ownership", async () => {
  const f = controllerFixture();
  try {
    const pending = f.controller.renderViewport(f.document, 1, parameters);
    const settled = assert.rejects(pending, { name: "AbortError" });
    const attachment = await f.worker.nextRequest("attach-document");
    const released = f.controller.releaseRendering(f.document.id);
    acknowledge(f.worker, attachment);
    const release = await f.worker.nextRequest("release-document", attachment.requestId);
    acknowledge(f.worker, release);
    await Promise.all([settled, released]);
    assert.equal(f.worker.requests.filter((request) => request.kind === "request-viewport").length, 0);
    await controllerViewport(f, f.document, 2);
  } finally { await f.controller.close(); }
});

test("navigation twice during attachment commits only the newest document revision", async () => {
  const f = controllerFixture();
  try {
    const first = f.controller.renderViewport(f.document, 1, parameters);
    const rejected = assert.rejects(first, { name: "AbortError" });
    const attachment = await f.worker.nextRequest("attach-document");
    const second = f.controller.renderViewport({ ...f.document, documentRevision: 2 }, 2, parameters);
    acknowledge(f.worker, attachment);
    const replacement = await f.worker.nextRequest("attach-document", attachment.requestId);
    assert.equal(replacement.attachment.documentRevision, 2);
    acknowledge(f.worker, replacement);
    const request = await f.worker.nextRequest("request-viewport", replacement.requestId);
    const response = viewport(request, "layout-2", { ...summary, identity: "layout-2" });
    response.payload.documentRevision = 2;
    f.worker.respond(response);
    await Promise.all([second, rejected]);
    await assert.rejects(f.controller.renderViewport(f.document, 3, parameters), { name: "AbortError" });
  } finally { await f.controller.close(); }
});

test("release during state preparation cannot resurrect an attachment or regress state", async () => {
  const f = controllerFixture();
  try {
    await controllerViewport(f, f.document);
    const revised = { ...f.document, stateRevision: 2, documentState: { ...f.document.documentState, focus: "node" } };
    const pending = f.controller.renderViewport(revised, 2, parameters);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    const update = await f.worker.nextRequest("update-document-state");
    const released = f.controller.releaseRendering(f.document.id);
    acknowledge(f.worker, update);
    const release = await f.worker.nextRequest("release-document", update.requestId);
    acknowledge(f.worker, release);
    await Promise.all([rejected, released]);
    await controllerViewport(f, revised, 3);
    await assert.rejects(f.controller.renderViewport(f.document, 4, parameters), { name: "AbortError" });
  } finally { await f.controller.close(); }
});

for (const phase of ["stylesheet compilation", "layout", "rasterization"]) {
  test(`quit-to-controller-disposal cancels ${phase} before waiting for worker cleanup`, async () => {
    const f = controllerFixture();
    const pending = f.controller.renderViewport(f.document, 1, parameters);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    const attachment = await f.worker.nextRequest("attach-document");
    let request = attachment;
    if (phase !== "stylesheet compilation") {
      acknowledge(f.worker, attachment);
      request = await f.worker.nextRequest("request-viewport");
    }
    const start = performance.now();
    await f.controller.close();
    await rejected;
    assert.ok(performance.now() - start < 1000);
    assert.notEqual(Atomics.load(new Int32Array(request.documentCancellation), 0), request.documentGeneration);
    assert.equal(f.client.pendingRequestCount, 0);
    assert.equal(f.worker.terminated, 1);
  });
}

for (const warm of [false, true]) {
  test(`switching cold A to ${warm ? "warm" : "cold"} B cancels A at a checkpoint`, async () => {
    const f = controllerFixture();
    const b = { ...f.document, id: "B" };
    try {
      if (warm) {
        f.controller.prioritizeRendering("B");
        await controllerViewport(f, b);
      }
      f.controller.prioritizeRendering("A");
      const previous = f.worker.requests.at(-1)?.requestId ?? 0;
      const a = f.controller.renderViewport(f.document, 2, parameters);
      const rejected = assert.rejects(a, { name: "AbortError" });
      const cold = await f.worker.nextRequest("attach-document", previous);
      f.controller.prioritizeRendering("B");
      const pending = f.controller.renderViewport(b, 3, parameters);
      assert.notEqual(Atomics.load(new Int32Array(cold.documentCancellation), 0), cold.documentGeneration);
      acknowledge(f.worker, cold);
      let after = cold.requestId;
      if (!warm) {
        const attachment = await f.worker.nextRequest("attach-document", after);
        assert.equal(attachment.attachment.documentId, "B");
        acknowledge(f.worker, attachment);
        after = attachment.requestId;
      }
      const request = await f.worker.nextRequest("request-viewport", after);
      assert.equal(request.documentId, "B");
      f.worker.respond(viewport(request, "layout-B", { ...summary, identity: "layout-B" }));
      assert.equal((await pending).documentId, "B");
      await rejected;
    } finally { await f.controller.close(); }
  });
}

test("a worker restart cannot accept an old epoch attachment acknowledgement", async () => {
  const workers = [];
  const clients = [];
  let replacementCreated;
  const restarted = new Promise((resolve) => { replacementCreated = resolve; });
  const f = fixture();
  await f.client.close();
  const controller = new BrowserController({ store: { async flush() {} }, services: { async close() {} },
    createAcquisition: () => { throw new Error("unexpected session"); }, renderWorkerFactory: () => {
      const worker = new ControlledWorker();
      const client = new RenderWorkerClient({ transport: worker, shutdownDeadlineMilliseconds: 10 });
      workers.push(worker); clients.push(client);
      if (workers.length === 2) replacementCreated();
      return client;
    } });
  try {
    const pending = controller.renderViewport(f.document, 1, parameters);
    const rejected = assert.rejects(pending, /exited/u);
    const attachment = await workers[0].nextRequest("attach-document");
    workers[0].emit("exit", 1);
    await rejected;
    const retry = controller.renderViewport(f.document, 2, parameters);
    await restarted;
    // The closed transport's late response cannot dispatch into its replacement.
    acknowledge(workers[0], attachment);
    const replacement = await workers[1].nextRequest("attach-document");
    acknowledge(workers[1], replacement);
    const request = await workers[1].nextRequest("request-viewport");
    workers[1].respond(viewport(request, "new-epoch", { ...summary, identity: "new-epoch" }));
    assert.equal((await retry).summary.identity, "new-epoch");
    assert.equal(clients[0].pendingRequestCount, 0);
  } finally { await controller.close(); }
  assert.ok(workers.every((worker) => worker.terminated === 1));
});


test("viewport admission rejects an oversized result while preserving the committed viewport", async () => {
  const f = fixture({ maxClientRetainedBytes: 30_000 });
  try {
    await attach(f);
    const first = f.client.renderViewport(f.document, 1, parameters);
    f.worker.respond(viewport(f.worker.requests.at(-1), "layout-1", summary));
    const committed = await first;
    f.client.acknowledgeViewport(committed);
    const replacement = f.client.renderViewport(f.document, 2, parameters);
    const response = viewport(f.worker.requests.at(-1), "layout-2", { ...summary, identity: "layout-2" });
    response.payload.cellBuffer = { rows: [{ text: "oversized".repeat(30_000) }] };
    f.worker.respond(response);
    await assert.rejects(replacement, { name: "RenderBudgetExceededError" });
    assert.equal(committed.summary.identity, "layout-1");
    const retry = f.client.renderViewport(f.document, 3, parameters);
    assert.equal(f.worker.requests.at(-1).heldSummaryIdentity, null);
    f.worker.respond(viewport(f.worker.requests.at(-1), "layout-1", summary));
    assert.equal((await retry).summary.identity, committed.summary.identity);
    assert.equal(f.client.pendingRequestCount, 0);
  } finally { await f.client.close(); }
});


test("document cleanup has reserved admission and priority in a saturated worker queue", async () => {
  const f = fixture();
  try {
    await attach(f);
    const work = Array.from({ length: 200 }, () => f.client.metrics());
    const settled = Promise.allSettled(work);
    const active = f.worker.requests.at(-1);
    const released = f.client.release(f.document.id);
    assert.ok(f.client.pendingRequestCount <= 128);
    f.worker.respond({ kind: "artifact-metrics", requestId: active.requestId, metrics: {} });
    const cleanup = f.worker.requests.at(-1);
    assert.equal(cleanup.kind, "release-document");
    acknowledge(f.worker, cleanup);
    await released;
    await f.client.close();
    await settled;
    assert.equal(f.client.pendingRequestCount, 0);
  } finally { await f.client.close(); }
});

test("viewport cancellation settles its consumer before worker reply without releasing the active worker slot", async () => {
  const f = fixture();
  try {
    await attach(f);
    const first = f.client.renderViewport(f.document, 1, parameters);
    let cancellation;
    void first.catch((error) => { cancellation = error; });
    const active = f.worker.requests.at(-1);
    const documentGeneration = Atomics.load(new Int32Array(active.documentCancellation), 0);
    f.client.cancelViewport(f.document.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancellation?.name, "AbortError", "consumer cancellation must not wait for shared analysis");
    assert.equal(Atomics.load(new Int32Array(active.documentCancellation), 0), documentGeneration,
      "a replaced viewport must not cancel reusable document analysis");
    const second = f.client.renderViewport(f.document, 2, parameters);
    assert.equal(f.worker.requests.at(-1), active, "active worker slot remains occupied until acknowledgment");
    assert.equal(f.client.pendingRequestCount, 1, "only the successor owns a pending consumer");
    f.worker.respond(viewport(active, "obsolete", { ...summary, identity: "obsolete" }));
    const successor = f.worker.requests.at(-1);
    assert.equal(successor.viewportRevision, 2);
    assert.equal(successor.heldSummaryIdentity, null, "cancelled response cannot publish a stale summary");
    f.worker.respond(viewport(successor, "layout-1", summary));
    assert.equal((await second).viewportRevision, 2);
  } finally { await f.client.close(); }
});

for (const phase of ["attachment", "state preparation"]) {
  test(`aborted viewport consumer leaves shared ${phase} promptly and cannot enqueue a late viewport`, async () => {
    const f = controllerFixture();
    try {
      if (phase === "state preparation") await controllerViewport(f, f.document);
      const document = phase === "attachment" ? f.document
        : { ...f.document, stateRevision: 2, documentState: { ...f.document.documentState, focus: "node" } };
      const abort = new globalThis.AbortController();
      const first = f.controller.renderViewport(document, 2, parameters, abort.signal);
      let cancellation;
      void first.catch((error) => { cancellation = error; });
      const request = await f.worker.nextRequest(phase === "attachment" ? "attach-document" : "update-document-state");
      abort.abort();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(cancellation?.name, "AbortError");
      const successor = f.controller.renderViewport(document, 3, parameters);
      assert.equal(f.worker.requests.at(-1), request);
      acknowledge(f.worker, request);
      const viewportRequest = await f.worker.nextRequest("request-viewport", request.requestId);
      assert.equal(viewportRequest.viewportRevision, 3, "aborted caller cannot post work after preparation completes");
      f.worker.respond(viewport(viewportRequest, "layout-1", summary));
      await successor;
    } finally { await f.controller.close(); }
  });
}

test("a cancelled search consumer leaves blocked restart attachment without delaying or posting before its valid successor", async () => {
  const workers = [];
  let replacementCreated;
  const restarted = new Promise((resolve) => { replacementCreated = resolve; });
  const f = fixture();
  await f.client.close();
  const controller = new BrowserController({ store: { async flush() {} }, services: { async close() {} },
    createAcquisition: () => { throw new Error("unexpected acquisition"); }, renderWorkerFactory: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      const client = new RenderWorkerClient({ transport: worker, shutdownDeadlineMilliseconds: 10 });
      if (workers.length === 2) replacementCreated();
      return client;
    } });
  try {
    const initial = controller.searchDocument(f.document, "initial", parameters, 1);
    const failed = assert.rejects(initial, /exited/u);
    await workers[0].nextRequest("attach-document");
    workers[0].emit("exit", 1);
    await failed;
    const abort = new globalThis.AbortController();
    const cancelled = controller.searchDocument(f.document, "obsolete", parameters, 2, abort.signal);
    let cancellation;
    void cancelled.catch((error) => { cancellation = error; });
    await restarted;
    const attachment = await workers[1].nextRequest("attach-document");
    abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancellation?.name, "AbortError");
    const successor = controller.searchDocument(f.document, "valid", parameters, 3);
    assert.equal(workers[1].requests.length, 1, "restart attachment remains the single shared producer");
    acknowledge(workers[1], attachment);
    const request = await workers[1].nextRequest("search-document", attachment.requestId);
    assert.equal(request.query, "valid");
    workers[1].respond({ kind: "search-ready", requestId: request.requestId, result: { query: "valid" } });
    assert.equal((await successor).query, "valid");
    assert.equal(workers[1].requests.filter((entry) => entry.kind === "search-document").length, 1);
  } finally { await controller.close(); }
});

function activation(document, revision) {
  return { ...document, documentRevision: revision, stateRevision: revision };
}

async function finishPreparedViewport(f, after, identity = "layout-1") {
  const request = await f.worker.nextRequest("request-viewport", after);
  f.worker.respond(viewport(request, identity, { ...summary, identity }));
  return request;
}

test("warm activations update the resident source using the previous activation fence", async () => {
  const f = controllerFixture();
  try {
    await controllerViewport(f, f.document);
    for (const revision of [2, 3, 4]) {
      const after = f.worker.requests.at(-1).requestId;
      const next = activation(f.document, revision);
      const pending = f.controller.renderViewport(next, 1, parameters);
      const update = await f.worker.nextRequest("update-document-state", after);
      assert.equal(update.previousDocumentRevision, revision - 1);
      assert.equal(update.documentRevision, revision);
      acknowledge(f.worker, update);
      await finishPreparedViewport(f, update.requestId);
      assert.equal((await pending).documentRevision, revision);
    }
    assert.equal(f.worker.requests.filter((request) => request.kind === "attach-document").length, 1);
    await assert.rejects(f.controller.renderViewport(activation(f.document, 2), 1, parameters), { name: "AbortError" });
  } finally { await f.controller.close(); }
});

test("rapid activation supersession records atomic updates before preparing the newest fence", async () => {
  const f = controllerFixture();
  try {
    await controllerViewport(f, f.document);
    const second = f.controller.renderViewport(activation(f.document, 2), 1, parameters);
    const secondRejected = assert.rejects(second, { name: "AbortError" });
    const update = await f.worker.nextRequest("update-document-state");
    const third = f.controller.renderViewport(activation(f.document, 3), 1, parameters);
    const thirdRejected = assert.rejects(third, { name: "AbortError" });
    const fourth = f.controller.renderViewport(activation(f.document, 4), 1, parameters);
    acknowledge(f.worker, update);
    const latest = await f.worker.nextRequest("update-document-state", update.requestId);
    assert.equal(latest.previousDocumentRevision, 2);
    assert.equal(latest.documentRevision, 4);
    acknowledge(f.worker, latest);
    await finishPreparedViewport(f, latest.requestId);
    assert.equal((await fourth).documentRevision, 4);
    await Promise.all([secondRejected, thirdRejected]);
    assert.equal(f.worker.requests.filter((request) => request.kind === "attach-document").length, 1);
    assert.equal(f.worker.requests.filter((request) => request.kind === "update-document-state").length, 2);
  } finally { await f.controller.close(); }
});

test("activation cancels an in-flight search without accepting its late result", async () => {
  const f = controllerFixture();
  try {
    await controllerViewport(f, f.document);
    const search = f.controller.searchDocument(f.document, "old", parameters, 1);
    const rejected = assert.rejects(search, { name: "AbortError" });
    const searchRequest = await f.worker.nextRequest("search-document");
    const next = activation(f.document, 2);
    const pending = f.controller.renderViewport(next, 1, parameters);
    f.worker.respond({ kind: "search-ready", requestId: searchRequest.requestId, result: { query: "old" } });
    const update = await f.worker.nextRequest("update-document-state", searchRequest.requestId);
    acknowledge(f.worker, update);
    await finishPreparedViewport(f, update.requestId);
    assert.equal((await pending).documentRevision, 2);
    await rejected;
    assert.equal(f.worker.requests.filter((request) => request.kind === "attach-document").length, 1);
  } finally { await f.controller.close(); }
});

test("failed activation admission retries from the last acknowledged resident revision", async () => {
  const f = controllerFixture();
  try {
    await controllerViewport(f, f.document);
    const next = activation(f.document, 2);
    const failed = f.controller.renderViewport(next, 1, parameters);
    const update = await f.worker.nextRequest("update-document-state");
    f.worker.respond({ kind: "budget-exceeded", requestId: update.requestId, budget: "retained-cost", estimatedBytes: 2, limit: 1, owner: "activation" });
    await assert.rejects(failed, { name: "RenderBudgetExceededError" });
    const retry = f.controller.renderViewport(next, 2, parameters);
    const repeated = await f.worker.nextRequest("update-document-state", update.requestId);
    assert.equal(repeated.previousDocumentRevision, 1);
    acknowledge(f.worker, repeated);
    await finishPreparedViewport(f, repeated.requestId);
    assert.equal((await retry).documentRevision, 2);
    assert.equal(f.worker.requests.filter((request) => request.kind === "attach-document").length, 1);
  } finally { await f.controller.close(); }
});

test("equal URLs with distinct live sources replace the one resident source", async () => {
  const f = controllerFixture();
  try {
    await controllerViewport(f, f.document);
    const next = { ...activation(f.document, 2), navigation: commitNavigation(f.document.navigation,
      f.document.snapshot, "push", { kind: "direct" }) };
    const rendered = await controllerViewport(f, next);
    assert.equal(rendered.documentRevision, 2);
    assert.equal(f.worker.requests.filter((request) => request.kind === "attach-document").length, 2);
    assert.equal(f.worker.requests.filter((request) => request.kind === "update-document-state").length, 0);
  } finally { await f.controller.close(); }
});

test("a superseded source replacement cannot make an uncertain old source look resident", async () => {
  const f = controllerFixture();
  try {
    await controllerViewport(f, f.document);
    const after = f.worker.requests.at(-1).requestId;
    const next = { ...activation(f.document, 2), navigation: commitNavigation(f.document.navigation,
      f.document.snapshot, "push", { kind: "direct" }) };
    const replacing = f.controller.renderViewport(next, 1, parameters);
    const rejected = assert.rejects(replacing, { name: "AbortError" });
    const replacement = await f.worker.nextRequest("attach-document", after);
    const restored = f.controller.renderViewport(activation(f.document, 3), 1, parameters);
    acknowledge(f.worker, replacement);
    const attachment = await f.worker.nextRequest("attach-document", replacement.requestId);
    assert.equal(attachment.attachment.documentRevision, 3);
    acknowledge(f.worker, attachment);
    await finishPreparedViewport(f, attachment.requestId);
    assert.equal((await restored).documentRevision, 3);
    await rejected;
    assert.equal(f.worker.requests.filter((request) => request.kind === "update-document-state").length, 0);
  } finally { await f.controller.close(); }
});

test("closing during atomic activation settles its acknowledgement without delaying disposal", async () => {
  const f = controllerFixture();
  await controllerViewport(f, f.document);
  const pending = f.controller.renderViewport(activation(f.document, 2), 1, parameters);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await f.worker.nextRequest("update-document-state");
  const start = performance.now();
  await f.controller.close();
  await rejected;
  assert.ok(performance.now() - start < 1000);
  assert.equal(f.client.pendingRequestCount, 0);
  assert.equal(f.worker.terminated, 1);
});

test("worker document hydration reproduces authoritative form associations and canonical control identity", async () => {
  const { hydrateRenderDocument } = await import("../../dist/ui/render-worker/document-transfer.js");
  const { transferDocumentState, hydrateDocumentState } = await import("../../dist/ui/render-worker/protocol.js");
  const { formEntries } = await import("../../dist/app/forms.js");
  const document = parseWebDocument(`<table><form id="owner"><tr><td><input name="q" value="a&#10;b"><select name="s"><option disabled>Blocked</option><option value="same">First</option><option value="same" selected>Second</option></select></td></tr></form></table><input name="no-owner" form="missing">`, {
    requestUrl: "https://example.test/", finalUrl: "https://example.test/",
  });
  const state = createDocumentState(document);
  const attachment = globalThis.structuredClone({
    documentId: "form-parity", documentRevision: 1, stateRevision: 1,
    sourceText: document.sourceText, documentMode: document.documentMode,
    requestUrl: document.requestUrl, finalUrl: document.finalUrl,
    state: transferDocumentState(state), stylesheetSources: [], stylesheets: [], styleDiagnostics: [],
  });
  const workerDocument = hydrateRenderDocument(attachment);
  const workerState = hydrateDocumentState(attachment.state);
  assert.deepEqual(workerDocument.controls, document.controls);
  assert.deepEqual([...workerState.controls], [...state.controls]);
  assert.deepEqual(workerDocument.forms.map((form) => form.controls.map((control) => control.node)), document.forms.map((form) => form.controls.map((control) => control.node)));
  assert.deepEqual(formEntries(workerDocument, workerDocument.forms[0], workerState), formEntries(document, document.forms[0], state));
});
