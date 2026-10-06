import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { HttpFields } from "@ismail-elkorchi/http-client";
import { createMemoryTerminalHost } from "@ismail-elkorchi/terminal-ui/host";
import { renderFramePlain } from "@ismail-elkorchi/terminal-ui/renderer";
import { createTuiRuntime } from "@ismail-elkorchi/terminal-ui/tui";
import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { BrowserStore } from "../../dist/app/storage.js";
import { prepareBrowserTui } from "../../dist/ui/run.js";

const pageUrl = "https://images.test/";
const imageUrl = "https://images.test/a.png";
const nativeText = "Native text stays readable";
const html = '<title>Image status</title><style>body{margin:0;background:white;color:black}'
  + 'p{margin:0;height:16px}.icon{display:block;width:48px;height:32px;background:#bb0000;'
  + 'mask-image:url(/a.png);mask-size:contain;mask-repeat:no-repeat;mask-position:center}</style>'
  + `<p>${nativeText}</p>${'<div class="icon"></div>'.repeat(5)}`;

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function settle(runtime, predicate, description) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${description}; diagnostics=${JSON.stringify(runtime.diagnostics())}`);
    await delay(5);
  }
}

function activeDocument(runtime) {
  const state = runtime.state();
  return state.documents[state.activeDocumentIndex];
}

function statusCells(frame) {
  return frame.cells.filter((cell) => cell.source?.elementId === "browser-status"
    && cell.source.partName === "leading.status.value");
}

function statusText(frame) {
  return statusCells(frame).map((cell) => cell.text).join("");
}

function assertStatus(frame, text, tone) {
  assert.match(statusText(frame), text);
  const cells = statusCells(frame);
  assert.ok(cells.length > 0);
  assert.ok(cells.every((cell) => cell.style.fg?.kind === "theme"
    && cell.style.fg.token === `status.${tone}`), `Expected ${tone}: ${JSON.stringify(cells[0])}`);
}

function assertNativeText(runtime) {
  assert.match(renderFramePlain(runtime.frame()), /Native text stays readable/u);
  const document = activeDocument(runtime);
  const viewport = document.rendering.viewport ?? document.rendering.previousViewport;
  assert.ok(viewport.cellBuffer.rows.some((row) => row.text.includes(nativeText)),
    "ordinary page text remains in the native cell buffer");
}

function assertNoTransientIncomplete(fixture) {
  const document = activeDocument(fixture.runtime);
  assert.ok(!document.rendering.summary.incomplete.some((reason) => reason.includes("mask-intrinsics-pending")));
  const diagnostics = fixture.prepared.controller.detail("diagnostics", document);
  assert.ok(!diagnostics.some((line) => line.startsWith("Incomplete:") && line.includes("pending")),
    diagnostics.join("\n"));
}

async function fixture(t, page = html) {
  // The real app reads process.env for each render request. CI's NO_COLOR must not
  // silently skip mask artwork; restore every setting after this isolated test.
  const keys = ["NO_COLOR", "COLORTERM", "TERM"];
  const environment = new Map(keys.map((key) => [key, process.env[key]]));
  delete process.env.NO_COLOR;
  process.env.COLORTERM = "truecolor";
  process.env.TERM = "xterm-256color";
  let directory;
  let prepared;
  let runtime;
  const acquisitions = [];
  t.after(async () => {
    try {
      for (const acquisition of acquisitions) acquisition.finish.resolve();
      if (runtime !== undefined) await runtime.dispose();
      if (prepared !== undefined) await prepared.controller.close();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    } finally {
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  directory = await mkdtemp(join(tmpdir(), "verge-image-status-"));
  const store = await BrowserStore.open({ statePath: join(directory, "state.json") });
  prepared = await prepareBrowserTui(pageUrl, {
    store,
    services: {
      async writeTextFile() {}, async downloadFile() { throw new Error("not used"); },
      async openExternal() {}, async openPath() {}, async close() {},
    },
    createAcquisition: () => new PageAcquisition({
      defaultParseMode: "text",
      stylesheetLoader: async () => { throw new Error("unexpected stylesheet"); },
      loader: async (url) => ({
        requestUrl: url, finalUrl: url, status: 200, statusText: "OK", contentType: "text/html", html: page,
        responseFields: new HttpFields([{ name: "content-type", value: "text/html" }]),
        networkOutcome: { kind: "ok", finalUrl: url, status: 200, statusText: "OK", detailCode: "HTTP_200", detailMessage: "OK" },
        fetchedAtIso: "2026-10-06T00:00:00.000Z",
      }),
    }),
  });
  // Keep each real application source alive behind a gate. Tests drive its
  // backpressured callback, rather than changing app state or calling redraw.
  prepared.controller.acquireImages = async (documentId, snapshot, signal, emit) => {
    const finish = deferred();
    acquisitions.push({ documentId, snapshot, signal, emit, finish });
    await finish.promise;
  };
  const host = createMemoryTerminalHost({
    terminalSize: { columns: 120, rows: 20 },
    capabilities: { graphics: {
      kitty: "supported", sixel: "unsupported", kittyTransport: "direct", cellPixels: { width: 8, height: 16 },
    } },
  });
  runtime = createTuiRuntime({ app: prepared.app, textPresentation: prepared.textPresentation, host, graphics: "kitty" });
  await runtime.start();
  await settle(runtime, () => acquisitions.length === 1 && activeDocument(runtime).rendering?.status === "ready",
    "initial image source and viewport did not become ready");
  return { runtime, prepared, host, acquisitions };
}

function ready(resource) {
  return { ...resource, width: 2, height: 2, hasAlpha: true, mimeType: "image/png",
    status: "ready", pixels: new Uint8Array(16).fill(255) };
}

test("actual browser reports one loading image for five masks until ready pixels repaint automatically", { timeout: 20_000 }, async (t) => {
  const value = await fixture(t);
  const { runtime, host, acquisitions } = value;
  const [acquisition] = acquisitions;
  const initial = activeDocument(runtime);
  assert.equal(initial.snapshot.images.length, 1, "five mask placements share one acquisition resource");
  const [resource] = initial.snapshot.images;
  assert.equal(resource.requestUrl, imageUrl);
  assert.equal(resource.status, "pending");
  assert.equal(resource.width, null);
  assert.equal(resource.height, null);
  assert.equal(initial.rendering.viewport.cellBuffer.images.length, 5);
  assertStatus(runtime.frame(), /^Loading images \(1\):/u, "running");
  assert.equal(runtime.frame().graphics.length, 0);
  assert.doesNotMatch(host.output(), /_Ga=t,/u);
  assertNativeText(runtime);
  assertNoTransientIncomplete(value);

  const metadata = { ...resource, width: 2, height: 2, hasAlpha: true, mimeType: "image/png" };
  const beforeMetadata = initial.rendering.committedViewportRevision;
  await acquisition.emit(metadata);
  await settle(runtime, () => activeDocument(runtime).rendering.status === "ready"
    && activeDocument(runtime).rendering.committedViewportRevision > beforeMetadata,
  "metadata did not produce an accepted viewport");
  assert.equal(activeDocument(runtime).snapshot.images[0].status, "pending");
  assert.equal(activeDocument(runtime).snapshot.images[0].width, 2);
  assertStatus(runtime.frame(), /^Loading images \(1\):/u, "running");
  assert.equal(runtime.frame().graphics.length, 0, "metadata alone cannot draw pixels");
  assert.doesNotMatch(host.output(), /_Ga=t,/u);
  assertNativeText(runtime);
  assertNoTransientIncomplete(value);

  await acquisition.emit(ready(resource));
  acquisition.finish.resolve();
  await settle(runtime, () => runtime.frame().graphics.length === 5
    && activeDocument(runtime).rendering.status === "ready", "ready pixels did not repaint all five masks");
  assertStatus(runtime.frame(), /^Opened https:\/\/images\.test\/$/u, "success");
  assert.equal(activeDocument(runtime).snapshot.images[0].status, "ready");
  assert.equal(new Set(runtime.frame().graphics.map((graphic) => graphic.id)).size, 5);
  assert.match(host.output(), /_Ga=t,/u);
  assert.match(host.output(), /_Ga=p,/u);
  assertNativeText(runtime);
  assertNoTransientIncomplete(value);
  for (const frame of host.frames()) {
    assert.doesNotMatch(statusText(frame), /mask-intrinsics-pending|rendering incomplete/u);
  }
});

for (const knownDimensions of [false, true]) test(`actual browser ends mask loading on failure: known dimensions ${knownDimensions}`, { timeout: 20_000 }, async (t) => {
  const value = await fixture(t);
  const { runtime, host, acquisitions } = value;
  const [acquisition] = acquisitions;
  const [resource] = activeDocument(runtime).snapshot.images;
  assertStatus(runtime.frame(), /^Loading images \(1\):/u, "running");
  assertNoTransientIncomplete(value);
  if (knownDimensions) {
    await acquisition.emit({ ...resource, width: 2, height: 2, mimeType: "image/png" });
    await settle(runtime, () => activeDocument(runtime).rendering.status === "ready"
      && activeDocument(runtime).snapshot.images[0].width === 2, "metadata did not publish before failure");
    assertStatus(runtime.frame(), /^Loading images \(1\):/u, "running");
  }
  await acquisition.emit({ ...activeDocument(runtime).snapshot.images[0], status: "failed",
    failure: "decode-failed", reason: "Fixture decode failure." });
  acquisition.finish.resolve();
  await settle(runtime, () => activeDocument(runtime).snapshot.images[0].status === "failed"
    && activeDocument(runtime).rendering.status === "ready"
    && activeDocument(runtime).rendering.summary.incomplete.includes("artwork.mask-resource-failed=5")
    && !statusText(runtime.frame()).includes("Loading images"), "failed image did not publish its failure diagnostic");
  assert.equal(activeDocument(runtime).snapshot.images[0].width, knownDimensions ? 2 : null);
  assert.equal(activeDocument(runtime).snapshot.images[0].height, knownDimensions ? 2 : null);
  assertStatus(runtime.frame(), /failed|incomplete/iu, "error");
  assert.equal(runtime.frame().graphics.length, 0);
  assert.doesNotMatch(host.output(), /_Ga=t,/u);
  assertNativeText(runtime);
  assertNoTransientIncomplete(value);
  const diagnostics = value.prepared.controller.detail("diagnostics", activeDocument(runtime));
  assert.ok(diagnostics.includes("Images: 0 ready, 0 pending, 1 failed"));
  assert.ok(diagnostics.includes("Image decode-failed: 1"));
  await runtime.dispatch({ kind: "openDetail", detail: "diagnostics" });
  assert.ok(runtime.state().overlay.lines.includes("Image decode-failed: 1"));
  await runtime.dispatch({ kind: "dismiss" });
  assertStatus(runtime.frame(), /failed|incomplete/iu, "error");
  assertNoTransientIncomplete(value);
});

test("retired image completions cannot end the actual browser's loading status after reload", { timeout: 20_000 }, async (t) => {
  const value = await fixture(t);
  const { runtime, acquisitions } = value;
  const [retired] = acquisitions;
  const previous = activeDocument(runtime);
  const [resource] = previous.snapshot.images;
  await runtime.dispatch({ kind: "navigate", operation: "reload" });
  await settle(runtime, () => retired.signal.aborted, "reload did not retire the previous image source");
  retired.finish.resolve();
  await settle(runtime, () => acquisitions.length === 2 && activeDocument(runtime).rendering?.status === "ready",
    "reload did not start its replacement image source");
  assert.notEqual(activeDocument(runtime).documentRevision, previous.documentRevision);
  assertStatus(runtime.frame(), /^Loading images \(1\):/u, "running");
  await assert.rejects(retired.emit(ready(resource)), "a retired source cannot enqueue new pixels");
  for (const message of [
    { kind: "imageResource", resource: ready(resource) },
    { kind: "imageResourcesFailed", resourceIds: [resource.id] },
  ]) {
    await runtime.dispatch({ ...message, documentId: previous.id, documentRevision: previous.documentRevision,
      resourceRevision: previous.snapshot.imageResourceRevision ?? 0 });
    assert.equal(activeDocument(runtime).snapshot.images[0].status, "pending");
    assertStatus(runtime.frame(), /^Loading images \(1\):/u, "running");
  }
  assert.equal(runtime.frame().graphics.length, 0);
  assertNativeText(runtime);
  assertNoTransientIncomplete(value);
  const current = acquisitions[1];
  await current.emit(ready(activeDocument(runtime).snapshot.images[0]));
  current.finish.resolve();
  await settle(runtime, () => runtime.frame().graphics.length === 5, "replacement source did not paint its ready masks");
  assertStatus(runtime.frame(), /^Reloaded: https:\/\/images\.test\/$/u, "success");
  assertNoTransientIncomplete(value);
});

test("a failed mask keeps error priority while another image is still pending", { timeout: 20_000 }, async (t) => {
  const value = await fixture(t, html + '<div class="icon" style="mask-image:url(/b.png)"></div>');
  const { runtime, acquisitions } = value;
  const [acquisition] = acquisitions;
  const [first, second] = activeDocument(runtime).snapshot.images;
  assert.equal(activeDocument(runtime).snapshot.images.length, 2);
  assertStatus(runtime.frame(), /^Loading images \(2\):/u, "running");
  await acquisition.emit({ ...first, status: "failed", failure: "decode-failed", reason: "Fixture decode failure." });
  await settle(runtime, () => activeDocument(runtime).snapshot.images[0].status === "failed"
    && !statusText(runtime.frame()).includes("Loading images"), "one failed resource did not take error priority");
  assert.equal(activeDocument(runtime).snapshot.images[1].status, "pending");
  assertStatus(runtime.frame(), /failed|incomplete/iu, "error");
  assertNoTransientIncomplete(value);
  await acquisition.emit(ready(second));
  acquisition.finish.resolve();
  await settle(runtime, () => runtime.frame().graphics.length === 1, "the other mask did not finish automatically");
  assertStatus(runtime.frame(), /failed|incomplete/iu, "error");
  assertNativeText(runtime);
  assertNoTransientIncomplete(value);
});

test("pending images cannot hide a user-action error in the actual browser", { timeout: 20_000 }, async (t) => {
  const value = await fixture(t);
  const { runtime, acquisitions } = value;
  assertStatus(runtime.frame(), /^Loading images \(1\):/u, "running");
  await runtime.dispatch({ kind: "reopenDocument" });
  assertStatus(runtime.frame(), /^No recently closed tab\.$/u, "error");
  assert.equal(activeDocument(runtime).snapshot.images[0].status, "pending");
  const [acquisition] = acquisitions;
  await acquisition.emit(ready(activeDocument(runtime).snapshot.images[0]));
  acquisition.finish.resolve();
  await settle(runtime, () => runtime.frame().graphics.length === 5, "ready pixels did not finish while an action error was shown");
  assertStatus(runtime.frame(), /^No recently closed tab\.$/u, "error");
  assertNativeText(runtime);
  assertNoTransientIncomplete(value);
});
