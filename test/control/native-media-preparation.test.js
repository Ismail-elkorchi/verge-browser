import assert from "node:assert/strict";
import test from "node:test";
import { rasterImage } from "@ismail-elkorchi/terminal-ui";
import { estimatedRetainedCost } from "../../dist/memory/retained-cost.js";
import { retainedImageBytes, MAX_RETAINED_IMAGE_BYTES } from "../../dist/ui/image-loading.js";
import { acceptBrowserViewportImages, browserPendingImageAllocations, browserRasterImage,
  discardBrowserViewportImages, prepareBrowserViewportImages } from "../../dist/ui/image-presentation.js";

const white = { r: 255, g: 255, b: 255, a: 1 };
const black = { r: 0, g: 0, b: 0, a: 1 };
function resource(options = {}) {
  return Object.freeze({ id: "art", requestUrl: "https://art.test/image.png", owners: [],
    width: 2, height: 1, hasAlpha: true, status: "ready", mimeType: "image/png",
    pixels: new Uint8Array([255, 0, 0, 128, 20, 40, 60, 0]), ...options });
}
function placement(options = {}) {
  return Object.freeze({ id: "placement", resourceId: "art", naturalWidth: 2, naturalHeight: 1,
    hasAlpha: true, safeForTransparency: true, compositingBackdrop: white,
    bounds: { row: 0, column: 0, width: 2, height: 1 }, clip: { row: 0, column: 0, width: 2, height: 1 },
    ...options });
}
function state(images, viewport = null) {
  const snapshot = { images };
  return { activeDocumentIndex: 0, recentlyClosed: [], documents: [{ kind: "ready", snapshot,
    rendering: { viewport: viewport === null ? null : { cellBuffer: viewport }, previousViewport: null },
    navigation: { entries: [{ snapshot }] } }] };
}
function expected(width, height, pixels) {
  return rasterImage({ width, height, format: "rgba8", data: Uint8Array.from(pixels) }).contentDigest;
}
async function prepare(image, viewport, retained = state([image]), signal) {
  await prepareBrowserViewportImages([image], viewport, () => MAX_RETAINED_IMAGE_BYTES - retainedImageBytes(retained), signal);
}

test("alpha flattening uses the proven uniform backdrop and keeps original pixels unchanged", async () => {
  const image = resource(), original = Uint8Array.from(image.pixels), paint = placement(), viewport = { images: [paint] };
  const before = estimatedRetainedCost([viewport]);
  await prepare(image, viewport);
  const handle = browserRasterImage(image, paint, viewport);
  assert.ok(handle);
  assert.equal(handle.contentDigest, expected(2, 1, [255, 127, 127, 255, 255, 255, 255, 255]));
  assert.deepEqual(image.pixels, original);
  assert.equal(browserRasterImage(image, paint, undefined), null, "pixels require a viewport proof");
  assert.equal(browserRasterImage({ ...image, owners: ["new-owner"] }, paint, viewport), handle,
    "logical owner metadata does not replace the decoded generation");
  assert.equal(browserRasterImage({ ...image, pixels: Uint8Array.from(image.pixels) }, paint, viewport), null,
    "another decoded generation cannot reuse a viewport proof");
  assert.equal(browserRasterImage(image, paint, { images: [paint] }), null, "another viewport cannot reuse the proof");
  assert.ok(estimatedRetainedCost([viewport]) >= before + image.pixels.byteLength + handle.byteLength);
  acceptBrowserViewportImages(viewport);
  assert.equal(browserRasterImage(image, paint, viewport), handle);
});

test("owner-only opaque resource replacements share the prepared raster and its retained cost", async () => {
  const image = resource({ hasAlpha: false, pixels: new Uint8Array(8).fill(255) });
  const paint = placement({ hasAlpha: false }), first = { images: [paint] };
  await prepare(image, first); acceptBrowserViewportImages(first);
  const handle = browserRasterImage(image, paint, first);
  const replacement = Object.freeze({ ...image, owners: ["current-owner"] });
  const retained = state([replacement], first), second = { images: [paint] };
  assert.equal(browserRasterImage(replacement, paint, first), handle);
  assert.equal(retainedImageBytes(retained), 16);
  await prepare(replacement, second, retained);
  assert.equal(browserRasterImage(replacement, paint, second), handle);
  assert.equal(retainedImageBytes(retained), 16, "owner metadata never allocates another opaque copy");
  assert.ok(estimatedRetainedCost([replacement]) >= handle.byteLength + replacement.pixels.byteLength);
  discardBrowserViewportImages(second);
  assert.equal(browserRasterImage(replacement, paint, first), handle);
});

test("unsafe ink, unknown or nonopaque backgrounds and stale alpha metadata stay native fallback", async () => {
  const image = resource();
  for (const change of [{ safeForTransparency: false }, { compositingBackdrop: null },
    { compositingBackdrop: { ...white, a: 0.5 } }, { hasAlpha: null }, { naturalWidth: 3 },
    { compositingBackdrop: { ...white, r: NaN } }]) {
    const paint = placement(change), viewport = { images: [paint] };
    await prepare(image, viewport);
    assert.equal(browserRasterImage(image, paint, viewport), null);
    discardBrowserViewportImages(viewport);
  }
  const unknown = resource({ hasAlpha: null }), paint = placement(), viewport = { images: [paint] };
  await prepare(unknown, viewport);
  assert.equal(browserRasterImage(unknown, paint, viewport), null);
  discardBrowserViewportImages(viewport);
});

test("mask tint uses source alpha and pads the cell allocation without stretching artwork", async () => {
  const image = resource({ width: 2, height: 1, hasAlpha: false, pixels: new Uint8Array(8).fill(255) });
  const paint = placement({ maskTint: { r: 0, g: 0, b: 255, a: 0.5 },
    sourceInset: { left: 0, top: 0.25, width: 1, height: 0.5 }, rasterSize: { width: 4, height: 4 } });
  const viewport = { images: [paint] };
  await prepare(image, viewport);
  const handle = browserRasterImage(image, paint, viewport);
  assert.ok(handle);
  assert.equal(handle.width, 4); assert.equal(handle.height, 4);
  const whiteRow = Array.from({ length: 4 }, () => [255, 255, 255, 255]).flat();
  const artworkRow = Array.from({ length: 4 }, () => [128, 128, 255, 255]).flat();
  assert.equal(handle.contentDigest, expected(4, 4, [...whiteRow, ...artworkRow, ...artworkRow, ...whiteRow]));
  discardBrowserViewportImages(viewport);
});

test("one selected variant is bounded; conflicting simultaneous backdrops retain fallback", async () => {
  const image = resource(), first = placement(), second = placement({ id: "other", compositingBackdrop: black });
  const viewport = { images: [first, second] };
  await prepare(image, viewport);
  assert.ok(browserRasterImage(image, first, viewport));
  assert.equal(browserRasterImage(image, second, viewport), null);
  assert.equal(browserPendingImageAllocations().images.length, 1);
  discardBrowserViewportImages(viewport);
});

test("cancelled and rejected candidates leave the accepted viewport's pixels and lookup intact", async () => {
  const image = resource(), oldPaint = placement(), oldViewport = { images: [oldPaint] };
  await prepare(image, oldViewport); acceptBrowserViewportImages(oldViewport);
  const accepted = state([image], oldViewport), oldHandle = browserRasterImage(image, oldPaint, oldViewport);
  const nextPaint = placement({ compositingBackdrop: black }), next = { images: [nextPaint] };
  const abort = new globalThis.AbortController();
  const work = prepare(image, next, accepted, abort.signal);
  assert.equal(browserPendingImageAllocations().reservedBytes, 16);
  abort.abort(); await assert.rejects(work, { name: "AbortError" });
  assert.equal(browserRasterImage(image, oldPaint, oldViewport), oldHandle);
  assert.equal(browserRasterImage(image, nextPaint, next), null);
  assert.equal(browserPendingImageAllocations().reservedBytes, 0);
  await prepare(image, next, accepted);
  assert.notEqual(browserRasterImage(image, nextPaint, next), oldHandle);
  discardBrowserViewportImages(next);
  assert.equal(browserRasterImage(image, oldPaint, oldViewport), oldHandle);
  assert.equal(retainedImageBytes(accepted), 16);
});

test("superseding live preparation keeps its workspace reserved until it has actually stopped", async () => {
  const image = resource(), paint = placement(), viewport = { images: [paint] }, retained = state([image]);
  const work = prepare(image, viewport, retained);
  discardBrowserViewportImages(viewport);
  assert.equal(retainedImageBytes(retained), 24);
  await assert.rejects(work, { name: "AbortError" });
  assert.equal(retainedImageBytes(retained), 8);
  assert.equal(browserRasterImage(image, paint, viewport), null);
});

test("unique source and raster bytes include shared history, closed tabs, candidate and conversion workspace", async () => {
  const image = resource(), paint = placement(), viewport = { images: [paint] };
  const retained = state([image]);
  const work = prepare(image, viewport, retained);
  assert.equal(retainedImageBytes(retained), 24, "decoded + scratch + future raster are reserved");
  await work;
  assert.equal(retainedImageBytes(retained), 16, "candidate is counted before it enters state");
  retained.documents[0].rendering.viewport = { cellBuffer: viewport };
  retained.documents[0].rendering.previousViewport = { cellBuffer: viewport };
  retained.documents.push(retained.documents[0]);
  retained.recentlyClosed.push(retained.documents[0]);
  acceptBrowserViewportImages(viewport);
  assert.equal(retainedImageBytes(retained), 16, "shared history/tab/viewport owners are counted once");
  const otherPaint = placement({ compositingBackdrop: black }), other = { images: [otherPaint] };
  await prepare(image, other, retained);
  assert.equal(retainedImageBytes(retained), 24, "distinct immutable candidate counts separately");
  discardBrowserViewportImages(other);
  assert.equal(retainedImageBytes(retained), 16);
  const insufficient = { images: [otherPaint] };
  await prepareBrowserViewportImages([image], insufficient, () => 15);
  assert.equal(browserRasterImage(image, otherPaint, insufficient), null, "conversion reserves both copies before allocation");
  discardBrowserViewportImages(insufficient);
});
