import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { BrowserController } from "../../dist/ui/browser-controller.js";
import { EventEmitter } from "node:events";
import test from "node:test";
import { RenderWorkerClient } from "../../dist/ui/render-worker/client.js";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";

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
  return { worker, client, document: {
    id: "A", documentRevision: 1, stateRevision: 1, documentState: createDocumentState(document),
    snapshot: { document, requestUrl: document.requestUrl, finalUrl: document.finalUrl, stylesheets: [], styleDiagnostics: [] },
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
    summaryIdentity: identity, layoutRevision: identity, summary,
  } };
}

const summary = { identity: "layout-1", documentRowCount: 500, incomplete: [], scrollAnchors: [{ documentNode: "target", row: 300 }],
  focusOrder: [{ node: "target", actionId: "link:target", actionKind: "link", topRow: 300, bottomRow: 301 }], authorStateDependencies: [] };

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
    createSession: () => { throw new Error("unexpected session allocation"); }, renderWorkerFactory: () => f.client,
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
    createSession: () => { throw new Error("unexpected session"); }, renderWorkerFactory: () => {
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
