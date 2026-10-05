import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { text } from "@ismail-elkorchi/terminal-ui/components";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { createTuiRuntime, defineTui } from "@ismail-elkorchi/terminal-ui/tui";
import { parseWebDocument } from "../../dist/document/index.js";
import { BrowserController } from "../../dist/ui/browser-controller.js";

import { acceptImageResource, imageSources, MAX_RETAINED_IMAGE_BYTES, retainedImageBytes } from "../../dist/ui/image-loading.js";

function image(overrides = {}) {
  return Object.freeze({ id: "image-1", requestUrl: "https://example.test/photo.png", owners: Object.freeze(["node-1"]),
    width: null, height: null, mimeType: null, status: "pending", ...overrides });
}

function state(resources = [image()]) {
  const snapshot = { document: {}, stylesheets: [], styleDiagnostics: [], diagnostics: {}, responseFields: {}, images: resources };
  const document = {
    kind: "ready", id: "tab-1", documentRevision: 3, stateRevision: 7, loading: false, snapshot,
    documentState: { focus: "node-1" }, scrollAnchor: { source: "node-1", rowOffset: 2 },
    formEditors: {}, navigation: { entries: [{ id: "entry-1", documentId: "source-1", snapshot }], index: 0, nextIdentity: 2 }, search: null,
    rendering: { requestKey: "accepted", pendingSearch: null, searchRequestGeneration: 4 },
  };
  return { documents: [document], activeDocumentIndex: 0, recentlyClosed: [] };
}

function message(resource, overrides = {}) {
  return { kind: "imageResource", documentId: "tab-1", documentRevision: 3, resource, ...overrides };
}

test("image metadata invalidates geometry while readiness preserves current interaction and layout", () => {
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
  assert.equal(painted.documents[0].stateRevision, after.stateRevision);
  assert.equal(painted.documents[0].rendering, after.rendering);
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

test("image ownership admission includes closed/history snapshots and reserves the raster copy", () => {
  const ready = image({ status: "ready", pixels: new Uint8Array(24), width: 3, height: 2 });
  const initial = state([ready]);
  const same = initial.documents[0];
  const shared = { ...initial, recentlyClosed: [same], documents: [same, same] };
  assert.equal(retainedImageBytes(shared), 48);
  const historyOnly = image({ id: "older", status: "ready", width: 2, height: 2, pixels: new Uint8Array(16) });
  const pending = image({ id: "new" });
  const mixed = state([pending]);
  mixed.recentlyClosed = [{ ...same, snapshot: { images: [] }, navigation: { entries: [{ snapshot: { images: [historyOnly] } }] } }];
  assert.equal(retainedImageBytes(mixed), 32);
  const oversized = image({ ...pending, width: 1, height: 1, status: "ready",
    pixels: new Uint8Array(MAX_RETAINED_IMAGE_BYTES / 2) });
  const rejected = acceptImageResource(mixed, message(oversized));
  assert.equal(rejected.documents[0].snapshot.images[0].status, "failed");
  assert.equal(rejected.documents[0].snapshot.images[0].failure, "resource-limit");
  assert.equal("pixels" in rejected.documents[0].snapshot.images[0], false);
  assert.equal(retainedImageBytes(rejected), 32);
});

test("source failure settles only pending resources and leaves accepted images intact", () => {
  const ready = image({ status: "ready", pixels: new Uint8Array(4), width: 1, height: 1 });
  const initial = state([ready, image({ id: "next" })]);
  const settled = acceptImageResource(initial, { kind: "imageResourcesFailed", documentId: "tab-1", documentRevision: 3 });
  assert.equal(settled.documents[0].snapshot.images[0], ready);
  assert.equal(settled.documents[0].snapshot.images[1].status, "failed");
  assert.equal(settled.documents[0].rendering, initial.documents[0].rendering);
  assert.deepEqual(imageSources({}, settled), []);
});

test("image source starts after admission and awaits reliable completion backpressure", async () => {
  const initial = state();
  let calls = 0;
  let advanced = false;
  const controller = { async acquireImages(document, signal, onResource) {
    calls += 1;
    assert.equal(document, initial.documents[0]);
    signal.throwIfAborted();
    await onResource(image({ width: 2, height: 1 }));
    advanced = true;
  } };
  const sources = imageSources(controller, initial);
  assert.equal(calls, 0);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].generation, 3);
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
  const controller = { async acquireImages(_document, signal, onResource) {
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
    assert.equal(runtime.state().documents[0].stateRevision, 8);
    await delay(0);
    assert.equal(completed, true);
  } finally { await runtime.dispose(); }
});

test("runtime disposal cancels pending image acquisition", { timeout: 5000 }, async () => {
  let observedSignal;
  let cancelled = false;
  const controller = { async acquireImages(_document, signal) {
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
  const controller = new BrowserController({
    store: { httpSession: {}, async flush() {} },
    services: { async close() {} },
    renderWorkerFactory: () => ({ cancelDocument() {}, async close() {} }),
    createAcquisition: () => {
      const id = ++acquisitionCount;
      return {
        async acquire(url) {
          return { requestUrl: url, finalUrl: url, document: parseWebDocument("<p>Readable page</p>", { requestUrl: url, finalUrl: url }),
            stylesheets: [], styleDiagnostics: [], diagnostics: { parseMode: "text" }, responseFields: {}, status: 200 };
        },
        async acquireImages(_snapshot, { signal }) {
          starts.push(id);
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
  const first = await controller.restorePlaceholder(placeholder);
  const second = await controller.openNewFromDocument(first, "https://example.test/two");
  const retired = new globalThis.AbortController();
  const waiting = new globalThis.AbortController();
  const successor = new globalThis.AbortController();
  const noop = async () => {};
  const one = controller.acquireImages(first, retired.signal, noop);
  const oneRejected = assert.rejects(one, /retired/u);
  const two = controller.acquireImages(second, waiting.signal, noop);
  const twoRejected = assert.rejects(two, /obsolete/u);
  retired.abort(new Error("retired"));
  await delay(0);
  assert.deepEqual(starts, [1]);
  waiting.abort(new Error("obsolete"));
  await twoRejected;
  const three = controller.acquireImages(second, successor.signal, noop);
  await delay(0);
  assert.deepEqual(starts, [1]);
  finishCleanup();
  await Promise.all([oneRejected, three]);
  assert.deepEqual(starts, [1, 2]);
  await controller.close();
});
