import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { PNG } from "pngjs";
import { encode } from "jpeg-js";
import { HttpFields } from "@ismail-elkorchi/http-client";
import { parseWebDocument } from "../../dist/document/index.js";
import { acquireDocumentImages, discoverDocumentImages } from "../../dist/app/image-acquisition.js";
import { inspectImageHeader } from "../../dist/app/image-header.js";
import { imagePolicy } from "../../dist/app/image-policy.js";
import { PageAcquisition } from "../../dist/app/page-acquisition.js";
import { PageNetworkClient } from "../../dist/app/fetch-page.js";
import { StaticImageDecoder } from "../../dist/runtime/image-decoder.js";

const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
const pngBytes = PNG.sync.write({ width: 2, height: 2, data: pixels });
const jpegBytes = encode({ width: 2, height: 2, data: pixels }, 90).data;
const policy = imagePolicy();
const pngType = "image/png";
function snapshot(html = '<img src="/a.png" alt="A"><img src="/a.png" alt="Again">') {
  const document = parseWebDocument(html, { requestUrl: "https://example.com/", finalUrl: "https://example.com/" });
  const images = discoverDocumentImages(document);
  return { document, finalUrl: document.finalUrl, images: images.resources, imageOmittedReferenceCount: images.omittedReferences };
}
function fetched(url, bytes = pngBytes, contentType = pngType) { return { requestUrl: url, finalUrl: url, bytes, contentType }; }
function loaderPage(requestUrl) { return Promise.resolve({ requestUrl, finalUrl: requestUrl, html: '<img src="/a.png">',
  status: 200, statusText: "OK", contentType: "text/html", responseFields: new HttpFields(), fetchedAtIso: "2026-10-05T00:00:00Z" }); }
function crc(bytes) { let value = -1; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ -1) >>> 0; }
function chunk(type, bytes) { const body = Buffer.concat([Buffer.from(type), bytes]); const result = Buffer.alloc(body.length + 8); result.writeUInt32BE(bytes.length); body.copy(result, 4); result.writeUInt32BE(crc(body), result.length - 4); return result; }
function insert(bytes, type, body) { return Buffer.concat([bytes.subarray(0, 33), chunk(type, body), bytes.subarray(33)]); }

for (const [mimeType, bytes] of [[pngType, pngBytes], ["image/jpeg", jpegBytes]]) {
  test(`bounded worker decodes opaque ${mimeType} and owns its pixel buffer`, async () => {
    const header = inspectImageHeader(bytes, mimeType, policy);
    const decoder = new StaticImageDecoder(policy);
    try {
      const actual = await decoder.decode(bytes, header, new globalThis.AbortController().signal);
      assert.equal(actual.byteLength, 16);
      assert.equal(actual.constructor, Uint8Array);
      assert.equal(actual.buffer.byteLength, 16);
      assert.equal(bytes.byteLength > 0, true);
      if (mimeType === pngType) assert.deepEqual([...actual], [...pixels]);
    } finally { await decoder.close(); }
  });
}

test("image discovery deduplicates identities and preserves all owners without fetching", () => {
  const result = snapshot();
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].owners.length, 2);
  assert.equal(result.images[0].id, "https://example.com/a.png");
  assert.equal(result.images[0].status, "pending");
  assert.equal(result.images[0].width, null);
  assert.equal(discoverDocumentImages(result.document, { maxResources: 0 }).resources.length, 0);
  assert.equal(snapshot('<img src="file:///secret.png">').images[0].failure, "unsupported-protocol");
});

test("natural metadata arrives before ready pixels with awaited backpressure", async () => {
  const updates = []; let fetches = 0; let observed = false;
  const result = await acquireDocumentImages(snapshot(), { signal: new globalThis.AbortController().signal,
    async onResource(resource) { updates.push(resource); if (resource.status === "pending") { await delay(5); observed = true; } else assert.equal(observed, true); }
  }, async (url) => { fetches += 1; return fetched(url); }, policy);
  assert.equal(fetches, 1);
  assert.deepEqual(updates.map((entry) => entry.status), ["pending", "ready"]);
  assert.equal(updates[0].width, 2);
  assert.equal("pixels" in updates[0], false);
  assert.equal(result.decodedBytes, 16);
  assert.equal(result.encodedBytes, pngBytes.byteLength);
  assert.equal(result.peakConcurrency, 1);
  assert.ok(result.peakWorkspaceBytes <= policy.maxWorkspaceBytes);
  assert.equal(Object.isFrozen(updates[1]), true);
  const resumed = await acquireDocumentImages({ ...snapshot(), images: [updates[1]] }, { signal: new globalThis.AbortController().signal, onResource() { assert.fail(); } }, async () => { assert.fail(); }, policy);
  assert.equal(resumed.completed, 0);
});

test("data images remain bounded at the resource boundary, never global navigation", async () => {
  const dataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
  const updates = [];
  await acquireDocumentImages(snapshot(`<img src="${dataUrl}">`), { signal: new globalThis.AbortController().signal, onResource: (entry) => { updates.push(entry); } }, async () => { assert.fail(); }, policy);
  assert.equal(updates.at(-1).status, "ready");
  const denied = [];
  await acquireDocumentImages(snapshot(`<img src="${dataUrl}">`), { signal: new globalThis.AbortController().signal, onResource: (entry) => { denied.push(entry); } }, async () => { assert.fail(); }, imagePolicy({ maxEncodedBytes: 2 }));
  assert.equal(denied.at(-1).failure, "encoded-byte-limit");
  const client = new PageNetworkClient();
  try { await assert.rejects(client.fetchPage(dataUrl), /protocol/u); } finally { await client.close(); }
});

test("dimension, workspace, animation, interlace, profiles and malformed header fences precede decode", () => {
  assert.throws(() => inspectImageHeader(pngBytes, pngType, imagePolicy({ maxPixels: 3 })), { code: "pixel-limit" });
  assert.throws(() => inspectImageHeader(pngBytes, pngType, imagePolicy({ maxWorkspaceBytes: 4 })), { code: "workspace-limit" });
  assert.throws(() => inspectImageHeader(pngBytes, "image/jpeg", policy), { code: "unsupported-format" });
  const huge = Buffer.from(pngBytes); huge.writeUInt32BE(0xffffffff, 16); huge.writeUInt32BE(crc(huge.subarray(12, 29)), 29);
  assert.throws(() => inspectImageHeader(huge, pngType, policy), { code: "pixel-limit" });
  const interlace = Buffer.from(pngBytes); interlace[28] = 1; interlace.writeUInt32BE(crc(interlace.subarray(12, 29)), 29);
  assert.throws(() => inspectImageHeader(interlace, pngType, policy), { code: "unsupported-interlace" });
  assert.throws(() => inspectImageHeader(insert(pngBytes, "IHDR", pngBytes.subarray(16, 29)), pngType, policy), { code: "malformed-image" });
  assert.throws(() => inspectImageHeader(insert(pngBytes, "acTL", Buffer.alloc(8)), pngType, policy), { code: "unsupported-animation" });
  assert.throws(() => inspectImageHeader(insert(pngBytes, "iCCP", Buffer.alloc(10)), pngType, policy), { code: "unsupported-color-profile" });
  assert.throws(() => inspectImageHeader(pngBytes.subarray(0, -1), pngType, policy), { code: "malformed-image" });
  assert.throws(() => inspectImageHeader(insert(pngBytes, "PLTE", Buffer.alloc(771)), pngType, policy), { code: "malformed-image" });
});

test("transparent PNG and corrupt CRC retain their fallback", async () => {
  const transparent = Buffer.from(pixels); transparent[3] = 0;
  for (const [bytes, failure] of [[PNG.sync.write({ width: 2, height: 2, data: transparent }), "unsupported-alpha"], [Buffer.from(pngBytes), "malformed-image"]]) {
    if (failure === "malformed-image") bytes[29] ^= 1;
    const updates = [];
    await acquireDocumentImages(snapshot(), { signal: new globalThis.AbortController().signal, onResource: (entry) => { updates.push(entry); } }, async (url) => fetched(url, bytes), policy);
    assert.equal(updates.at(-1).failure, failure);
    assert.equal(updates.at(-1).width, failure === "unsupported-alpha" ? 2 : null);
    assert.equal("pixels" in updates.at(-1), false);
  }
});

test("PNG expansion is bounded by expected scanlines instead of compressed payload size", async () => {
  const expanded = Buffer.alloc(8 * 1024 * 1024);
  // 2x2 RGBA scanlines have 18 bytes; the decoder must not retain the expansion.
  const bytes = Buffer.concat([pngBytes.subarray(0, 33), chunk("IDAT", deflateSync(expanded)), chunk("IEND", Buffer.alloc(0))]);
  const decoder = new StaticImageDecoder(policy);
  try {
    // A surplus stream is either rejected or decoded within the bounded output;
    // alpha-zero content cannot be admitted as an opaque image.
    await assert.rejects(decoder.decode(bytes, inspectImageHeader(bytes, pngType, policy), new globalThis.AbortController().signal), (error) => ["unsupported-alpha", "decode-failed"].includes(error.code));
  } finally { await decoder.close(); }
});

test("aggregate byte/pixel budgets and sequential admission limit downloads", async () => {
  const page = snapshot('<img src="/a.png"><img src="/b.png">');
  for (const [limits, expected] of [[{ maxTotalEncodedBytes: pngBytes.byteLength }, "encoded-byte-limit"], [{ maxTotalDecodedBytes: 16 }, "pixel-limit"]]) {
    const updates = []; let active = 0; let peak = 0;
    await acquireDocumentImages(page, { signal: new globalThis.AbortController().signal, onResource: (entry) => { updates.push(entry); } }, async (url) => {
      active += 1; peak = Math.max(peak, active); await delay(1); active -= 1; return fetched(url);
    }, imagePolicy(limits));
    assert.equal(peak, 1);
    assert.equal(updates.at(-1).failure, expected);
    assert.equal(updates.filter((entry) => entry.status === "ready").length, 1);
  }
});

test("cancellation fences late loader completion and metadata admission", async () => {
  const abort = new globalThis.AbortController(); const updates = [];
  let finish;
  const pending = acquireDocumentImages(snapshot(), { signal: abort.signal, onResource: (entry) => { updates.push(entry); } }, () => new Promise((resolve) => { finish = resolve; }), policy);
  abort.abort(new Error("superseded")); finish(fetched("https://example.com/a.png"));
  await assert.rejects(pending, /superseded/u);
  assert.deepEqual(updates, []);
});

test("decoder deadline terminates non-cooperative work and later jobs can resume", async () => {
  const decoder = new StaticImageDecoder(imagePolicy({ maxDecodeMilliseconds: 0 }));
  try { await assert.rejects(decoder.decode(pngBytes, inspectImageHeader(pngBytes, pngType, policy), new globalThis.AbortController().signal), { code: "timeout" }); }
  finally { await decoder.close(); }
  const aborted = new globalThis.AbortController();
  const another = new StaticImageDecoder(policy);
  const job = another.decode(pngBytes, inspectImageHeader(pngBytes, pngType, policy), aborted.signal);
  aborted.abort(new Error("navigation changed"));
  await assert.rejects(job, /navigation changed/u);
  await another.close();
});

test("navigation first commit does not fetch images, and close awaits cancelled image work", async () => {
  let started = false; let finished = false;
  const acquisition = new PageAcquisition({ loader: loaderPage, defaultParseMode: "text", imageLoader: async (_url, _source, { signal }) => {
    started = true;
    try { await delay(10000, undefined, { signal }); } finally { finished = true; }
    assert.fail();
  } });
  const page = await acquisition.acquire("https://example.com/");
  assert.equal(started, false); assert.equal(page.images[0].status, "pending");
  const job = acquisition.acquireImages(page, { signal: new globalThis.AbortController().signal, onResource() { assert.fail(); } });
  const rejection = assert.rejects(job);
  await delay(0);
  assert.equal(started, true);
  await acquisition.close(); await rejection;
  assert.equal(finished, true);
});

test("image transport keeps private destinations blocked and restricts MIME/bytes/redirects/cookies", async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, cookie: request.headers.cookie });
    if (request.url === "/redirect") { response.writeHead(302, { location: "/image" }); response.end(); return; }
    response.setHeader("content-type", request.url === "/html" ? "text/html" : pngType);
    response.end(pngBytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const standard = new PageNetworkClient();
  const session = { prepareRequest() { return [{ name: "cookie", value: "private=1" }]; }, acceptResponse() {} };
  const explicit = new PageNetworkClient({ publicAddressPolicy: "allow-private-and-local", session });
  const options = { maxContentBytes: 1024, timeoutMs: 2000 };
  try {
    await assert.rejects(standard.fetchImage(`${origin}/image`, origin, options), (error) => error.networkOutcome.kind === "network_block");
    assert.equal(seen.length, 0);
    await assert.rejects(explicit.fetchImage(`${origin}/html`, origin, options), (error) => error.networkOutcome.kind === "content_type_block");
    await assert.rejects(explicit.fetchImage(`${origin}/image`, origin, { ...options, maxContentBytes: 4 }), (error) => error.networkOutcome.kind === "size_limit");
    await assert.rejects(explicit.fetchImage(`${origin}/redirect`, origin, { ...options, maxRedirects: 0 }), (error) => error.networkOutcome.kind === "redirect_limit");
    await explicit.fetchImage(`${origin}/image`, origin, options);
    assert.equal(seen.at(-1).cookie, "private=1");
    await explicit.fetchImage(`${origin}/image`, "https://other.example/", options);
    assert.equal(seen.at(-1).cookie, undefined);
    await assert.rejects(explicit.fetchImage("file:///secret.png", origin, options), /HTTP/u);
  } finally { await standard.close(); await explicit.close(); await new Promise((resolve) => server.close(resolve)); }
});

test("observer disposal interrupts backpressure and propagates observer failure once", async () => {
  const abort = new globalThis.AbortController(); let calls = 0;
  const pending = acquireDocumentImages(snapshot(), { signal: abort.signal, onResource() { calls += 1; abort.abort(new Error("disposed")); return new Promise(() => {}); } }, async (url) => fetched(url), policy);
  await assert.rejects(pending, /disposed/u); assert.equal(calls, 1);
  let failures = 0;
  await assert.rejects(acquireDocumentImages(snapshot(), { signal: new globalThis.AbortController().signal,
    onResource() { failures += 1; throw new Error("observer closed"); } }, async (url) => fetched(url), policy), /observer closed/u);
  assert.equal(failures, 1);
});

test("per-resource deadline fences an uncooperative loader without late pixels", async () => {
  let complete; const updates = [];
  // Keep the test loop alive: AbortSignal.timeout is deliberately an unreferenced timer.
  const keepAlive = delay(50);
  const result = await acquireDocumentImages(snapshot(), { signal: new globalThis.AbortController().signal,
    onResource: (entry) => { updates.push(entry); } }, () => new Promise((resolve) => { complete = resolve; }), imagePolicy({ maxRequestMilliseconds: 5 }));
  assert.equal(result.failed, 1); assert.equal(updates[0].failure, "timeout");
  complete(fetched("https://example.com/a.png")); await keepAlive;
  assert.equal(updates.length, 1);
});

test("new navigation aborts progressive image work even if transport returns late", async () => {
  let complete; const updates = [];
  const acquisition = new PageAcquisition({ loader: loaderPage, defaultParseMode: "text", imageLoader: () => new Promise((resolve) => { complete = resolve; }) });
  try {
    const page = await acquisition.acquire("https://example.com/");
    const imageJob = acquisition.acquireImages(page, { signal: new globalThis.AbortController().signal, onResource: (entry) => { updates.push(entry); } });
    const rejected = assert.rejects(imageJob, /superseded/u);
    await delay(0);
    await acquisition.acquire("https://example.com/next");
    await rejected;
    complete(fetched("https://example.com/a.png")); await delay(0);
    assert.deepEqual(updates, []);
  } finally { await acquisition.close(); }
});

test("JPEG oversize frame and encoded mismatch are rejected before decoder allocation", () => {
  const oversized = Buffer.from(jpegBytes); let at = 2;
  while (at < oversized.length) {
    const marker = oversized[at + 1];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) { oversized.writeUInt16BE(65535, at + 5); oversized.writeUInt16BE(65535, at + 7); break; }
    at += 2 + oversized.readUInt16BE(at + 2);
  }
  assert.throws(() => inspectImageHeader(oversized, "image/jpeg", policy), { code: "pixel-limit" });
  assert.throws(() => inspectImageHeader(jpegBytes, pngType, policy), { code: "unsupported-format" });
  assert.throws(() => inspectImageHeader(jpegBytes.subarray(0, 20), "image/jpeg", policy), { code: "malformed-image" });
});

test("non-interlaced palette, grayscale, truecolor and 16-bit PNG share the bounded path", async () => {
  function rawPng(depth, color, raw, palette) {
    const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = depth; header[9] = color;
    return Buffer.concat([pngBytes.subarray(0, 8), chunk("IHDR", header), ...(palette ? [chunk("PLTE", palette)] : []), chunk("IDAT", deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0))]);
  }
  const decoder = new StaticImageDecoder(policy);
  try {
    for (const [bytes, expected] of [
      [rawPng(1, 3, [0, 0], Buffer.from([255, 0, 0])), [255, 0, 0, 255]],
      [rawPng(8, 0, [0, 128]), [128, 128, 128, 255]],
      [rawPng(8, 2, [0, 0, 255, 0]), [0, 255, 0, 255]],
      [rawPng(8, 4, [0, 128, 255]), [128, 128, 128, 255]],
      [rawPng(16, 2, [0, 255, 255, 0, 0, 0, 0]), [255, 0, 0, 255]],
    ]) assert.deepEqual([...await decoder.decode(bytes, inspectImageHeader(bytes, pngType, policy), new globalThis.AbortController().signal)], expected);
  } finally { await decoder.close(); }
});

test("total acquisition deadline interrupts stalled resource backpressure", async () => {
  let calls = 0;
  const keepAlive = delay(60);
  const pending = acquireDocumentImages(snapshot(), { signal: new globalThis.AbortController().signal,
    onResource() { calls += 1; return new Promise(() => {}); } }, async (url) => fetched(url), imagePolicy({ maxTotalMilliseconds: 5 }));
  await assert.rejects(pending, (error) => error.name === "TimeoutError");
  assert.equal(calls, 1);
  await keepAlive;
});

test("decoder reserves exclusivity across awaits and cannot start after close", async () => {
  const header = inspectImageHeader(pngBytes, pngType, policy);
  const signal = new globalThis.AbortController().signal;
  const decoder = new StaticImageDecoder(policy);
  try {
    const first = decoder.decode(pngBytes, header, signal);
    await assert.rejects(decoder.decode(pngBytes, header, signal), /busy/u);
    assert.deepEqual([...await first], [...pixels]);
  } finally { await decoder.close(); }
  const closing = new StaticImageDecoder(policy);
  const pending = closing.decode(pngBytes, header, signal);
  await closing.close();
  await assert.rejects(pending, /closed/u);
  await assert.rejects(closing.decode(pngBytes, header, signal), /closed/u);
});

test("failed and over-limit transports consume aggregate encoded reservations", async () => {
  const page = snapshot('<img src="/a.png"><img src="/b.png"><img src="/c.png">');
  for (const oversized of [false, true]) {
    const updates = []; let calls = 0;
    const result = await acquireDocumentImages(page, { signal: new globalThis.AbortController().signal,
      onResource: (entry) => { updates.push(entry); } }, async (url) => {
      calls += 1;
      if (!oversized) throw new Error("body failed after partial transfer");
      return fetched(url, Buffer.alloc(5));
    }, imagePolicy({ maxEncodedBytes: 4, maxTotalEncodedBytes: 8 }));
    assert.equal(calls, 2);
    assert.equal(result.encodedBytes, 8);
    assert.equal(updates.at(-1).failure, "encoded-byte-limit");
  }
});

test("PNG ancillary CRC and JPEG profiles after entropy cannot bypass preflight", () => {
  const withSrgb = insert(pngBytes, "sRGB", Buffer.from([0]));
  assert.equal(inspectImageHeader(withSrgb, pngType, policy).width, 2);
  withSrgb.writeUInt32BE(0, 42);
  assert.throws(() => inspectImageHeader(withSrgb, pngType, policy), { code: "malformed-image" });
  const profile = Buffer.from("ICC_PROFILE\0\x01\x01bogus-profile");
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 0xe2; marker.writeUInt16BE(profile.length + 2, 2);
  const lateProfile = Buffer.concat([jpegBytes.subarray(0, -2), marker, profile, jpegBytes.subarray(-2)]);
  assert.throws(() => inspectImageHeader(lateProfile, "image/jpeg", policy), { code: "unsupported-color-profile" });
});

// Pillow-generated Adobe transform-0 direct RGB, two-by-two opaque red.
test("JPEG direct RGB components retain their encoded colors", async () => {
  const bytes = Buffer.from("/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwACAQEBAQECAQEBAgICAgIEAwICAgIFBAQDBAYFBgYGBQYGBgcJCAYHCQcGBggLCAkKCgoKCgYICwwLCgwJCgoK/8AAEQgAAgACA1IRAEcRAEIRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDUgBHAEIAAD8A/fyv5/6/n/r/2Q==", "base64");
  const header = inspectImageHeader(bytes, "image/jpeg", policy);
  assert.equal(header.jpegColorTransform, false);
  const decoder = new StaticImageDecoder(policy);
  try {
    const decoded = await decoder.decode(bytes, header, new globalThis.AbortController().signal);
    assert.deepEqual([...decoded.subarray(0, 4)], [255, 0, 0, 255]);
  } finally { await decoder.close(); }
});

function exif(orientation, littleEndian = true) {
  const bytes = Buffer.alloc(26);
  bytes.write(littleEndian ? "II" : "MM");
  const short = (value, offset) => littleEndian ? bytes.writeUInt16LE(value, offset) : bytes.writeUInt16BE(value, offset);
  const long = (value, offset) => littleEndian ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  short(42, 2); long(8, 4); short(1, 8); short(0x0112, 10); short(3, 12); long(1, 14); short(orientation, 18);
  return bytes;
}

test("PNG and JPEG EXIF orientations 1–8 agree with natural dimensions and pixel order", async () => {
  const colors = Buffer.from([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,0,255, 0,255,255,255, 255,0,255,255]);
  const plainPng = PNG.sync.write({ width: 3, height: 2, data: colors });
  const plainJpeg = encode({ width: 3, height: 2, data: colors }, 95).data;
  const orders = [[0,1,2,3,4,5], [2,1,0,5,4,3], [5,4,3,2,1,0], [3,4,5,0,1,2], [0,3,1,4,2,5], [3,0,4,1,5,2], [5,2,4,1,3,0], [2,5,1,4,0,3]];
  const decoder = new StaticImageDecoder(policy);
  try {
    for (const [mime, plain] of [[pngType, plainPng], ["image/jpeg", plainJpeg]]) {
      const decoded = await decoder.decode(plain, inspectImageHeader(plain, mime, policy), new globalThis.AbortController().signal);
      for (let orientation = 1; orientation <= 8; orientation += 1) {
        const tiff = exif(orientation, orientation % 2 === 0);
        const payload = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
        const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 0xe1; marker.writeUInt16BE(payload.length + 2, 2);
        const bytes = mime === pngType ? insert(plain, "eXIf", tiff) : Buffer.concat([plain.subarray(0, 2), marker, payload, plain.subarray(2)]);
        const header = inspectImageHeader(bytes, mime, policy);
        assert.equal(header.width, orientation >= 5 ? 2 : 3);
        assert.equal(header.height, orientation >= 5 ? 3 : 2);
        const output = await decoder.decode(bytes, header, new globalThis.AbortController().signal);
        const expected = orders[orientation - 1].flatMap((index) => [...decoded.subarray(index * 4, index * 4 + 4)]);
        assert.deepEqual([...output], expected, `${mime} orientation ${orientation}`);
      }
    }
  } finally { await decoder.close(); }
  const malformed = exif(6); malformed.writeUInt32LE(0xffffffff, 4);
  assert.throws(() => inspectImageHeader(insert(plainPng, "eXIf", malformed), pngType, policy), { code: "malformed-image" });
});

test("EXIF count, type, value and duplicate metadata are rejected before decode", () => {
  const wrongCount = exif(1); wrongCount.writeUInt32LE(2, 14);
  const wrongType = exif(1); wrongType.writeUInt16LE(4, 12);
  const wrongDirectoryCount = exif(1); wrongDirectoryCount.writeUInt16LE(65535, 8);
  for (const tiff of [wrongCount, wrongType, wrongDirectoryCount, exif(0), exif(9)]) {
    assert.throws(() => inspectImageHeader(insert(pngBytes, "eXIf", tiff), pngType, policy), { code: "malformed-image" });
  }
  assert.throws(() => inspectImageHeader(insert(insert(pngBytes, "eXIf", exif(1)), "eXIf", exif(6)), pngType, policy), { code: "malformed-image" });
  const duplicated = Buffer.alloc(38); exif(1).copy(duplicated); duplicated.writeUInt16LE(2, 8);
  exif(6).copy(duplicated, 22, 10, 22);
  assert.throws(() => inspectImageHeader(insert(pngBytes, "eXIf", duplicated), pngType, policy), { code: "malformed-image" });
});

test("resource discovery reports omitted references without retaining omitted URLs", async () => {
  const html = '<img src="/a.png"><img src="/b.png"><img src="/a.png"><img src="/b.png"><img src="/c.png"><img>';
  const document = snapshot(html).document;
  const discovered = discoverDocumentImages(document, { maxResources: 1 });
  assert.equal(discovered.resources.length, 1);
  assert.equal(discovered.resources[0].owners.length, 2);
  assert.equal(discovered.omittedReferences, 3);
  assert.equal(discoverDocumentImages(document, { maxResources: 0 }).omittedReferences, 5);
  assert.equal(discoverDocumentImages(document, { maxResources: 3 }).omittedReferences, 0);
  assert.deepEqual(Object.keys(discovered).sort(), ["omittedReferences", "resources"]);
  assert.ok(Object.isFrozen(discovered));
  assert.doesNotMatch(JSON.stringify(discovered), /[bc]\.png/u);
  const acquisition = new PageAcquisition({ defaultParseMode: "text", imagePolicy: { maxResources: 1 },
    loader: async (url) => ({ ...await loaderPage(url), html }) });
  try {
    const page = await acquisition.acquire("https://example.com/");
    assert.equal(page.images.length, 1);
    assert.equal(page.imageOmittedReferenceCount, 3);
    const metrics = await acquireDocumentImages(page, { signal: new globalThis.AbortController().signal,
      onResource() {} }, async (url) => fetched(url), policy);
    assert.equal(metrics.omittedReferences, 3);
  } finally { await acquisition.close(); }
});
