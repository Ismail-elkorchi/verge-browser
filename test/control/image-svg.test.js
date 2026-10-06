import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { parseWebDocument } from "../../dist/document/index.js";
import { acquireDocumentImages } from "../../dist/app/image-acquisition.js";
import { inspectImageHeader } from "../../dist/app/image-header.js";
import { imagePolicy } from "../../dist/app/image-policy.js";
import { StaticImageDecoder } from "../../dist/runtime/image-decoder.js";

const mime = "image/svg+xml";
const policy = imagePolicy();
const signal = () => new globalThis.AbortController().signal;
const svg = (body, attributes = 'viewBox="0 0 4 2"') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`);
const solid = svg('<path fill="#ff0000" opacity=".5" d="M0 0H4V2H0Z"/>');
function inspect(bytes, options = {}) { return inspectImageHeader(bytes, mime, imagePolicy(options)); }

test("bounded SVG paths publish owned straight RGBA8 and preserve partial alpha", async () => {
  const header = inspect(solid);
  assert.equal(header.width, 4); assert.equal(header.height, 2);
  const decoder = new StaticImageDecoder(policy);
  try {
    const pixels = await decoder.decode(solid, header, signal());
    assert.equal(pixels.constructor, Uint8Array);
    assert.equal(pixels.buffer.byteLength, 32);
    assert.deepEqual([...pixels.subarray(0, 4)], [255, 0, 0, 128]);
    assert.equal(solid.byteLength > 0, true);
    const second = await decoder.decode(solid, header, signal());
    assert.notEqual(second.buffer, pixels.buffer);
    second.fill(0); assert.equal(pixels[0], 255);
  } finally { await decoder.close(); }
});

test("viewBox, local clipping, groups, transforms, gradients and stops remain static", async () => {
  const bytes = svg('<defs><linearGradient id="paint" x1="0" y1="0" x2="4" y2="0" gradientUnits="userSpaceOnUse" gradientTransform="translate(0 0)"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><clipPath id="clip"><path d="M0 0H2V2H0Z"/></clipPath></defs><g clip-path="url(#clip)" transform="translate(0 0)" style="isolation:isolate;mix-blend-mode:multiply"><path fill="url(#paint)" d="M0 0H4V2H0Z"/></g>');
  const decoder = new StaticImageDecoder(policy);
  try {
    const pixels = await decoder.decode(bytes, inspect(bytes), signal());
    assert.ok(pixels[0] > pixels[2]); assert.equal(pixels[3], 255);
    assert.equal(pixels[11], 0); assert.equal(pixels[15], 0);
  } finally { await decoder.close(); }
  assert.equal(inspect(svg("", 'width="2px" height="3px"')).width, 2);
  assert.equal(inspect(svg("", 'viewBox="0 0 1.6 2.2"')).width, 2);
});

test("plain SVG title and desc metadata preserve intrinsic dimensions and every decoded pixel", async () => {
  const path = '<path fill="#ff0000" d="M0 0H4V2H0Z"/>';
  const plain = svg(path);
  const described = svg('<title id="caption">Menu \u2014 \u0391</title><desc>Three lines\n  of inert description</desc>'
    + '<g><title>Group label</title><path fill="#ff0000" d="M0 0H4V2H0Z"><desc>Shape label</desc></path></g>');
  const empty = svg('<title>Never painted as text</title><desc>No visible glyphs</desc>');
  const plainHeader = inspect(plain), describedHeader = inspect(described), emptyHeader = inspect(empty);
  for (const header of [describedHeader, emptyHeader]) {
    assert.equal(header.width, plainHeader.width);
    assert.equal(header.height, plainHeader.height);
  }
  const decoder = new StaticImageDecoder(policy);
  try {
    const pixels = await decoder.decode(plain, plainHeader, signal());
    assert.deepEqual(await decoder.decode(described, describedHeader, signal()), pixels);
    assert.ok((await decoder.decode(empty, emptyHeader, signal())).every((value) => value === 0));
  } finally { await decoder.close(); }
});

test("SVG metadata does not admit nested markup, attributes, namespaces, entities or visible text", () => {
  for (const body of [
    '<title><desc>Nested metadata</desc></title>', '<desc><g/></desc>', '<title><path/></title>',
    '<title><script>alert(1)</script></title>', '<desc><foreignObject/></desc>',
    '<title xmlns="http://www.w3.org/1999/xhtml">Wrong namespace</title>',
    '<x:title xmlns:x="http://www.w3.org/1999/xhtml">Wrong namespace</x:title>',
    '<title onclick="alert(1)">Event handler</title>', '<desc style="fill:red">Style</desc>',
    '<title xml:lang="en">Namespaced attribute</title>', '<title href="https://example.com/">External</title>',
    '<title>Entity &amp; reference</title>', '<desc>Numeric &#65; reference</desc>',
    '<title><![CDATA[Hidden markup]]></title>', '<title>Label</title>Visible text',
    '<text><title>Label</title>Still visible</text>',
  ]) assert.throws(() => inspect(svg(body)), { code: "unsupported-format" }, body);
  for (const body of ['<title>Unclosed', '<title>Wrong close</desc>', '<desc>Wrong close</title>']) {
    assert.throws(() => inspect(svg(body)), { code: "malformed-image" }, body);
  }
});

test("SVG metadata shares source, element and depth admission budgets", () => {
  assert.throws(() => inspect(svg(`<title>${"a".repeat(256 * 1024)}</title>`)), { code: "resource-limit" });
  assert.throws(() => inspect(svg('<title/>'.repeat(4096))), { code: "resource-limit" });
  assert.throws(() => inspect(svg('<g>'.repeat(31) + '<desc>Deep metadata</desc>' + '</g>'.repeat(31))), { code: "resource-limit" });
});

test("active SVG, text/fonts, external resources, entities, CSS and complex effects fail explicitly", () => {
  for (const body of [
    '<script>alert(1)</script>', '<foreignObject/>', '<text>Rasterized text</text>', '<image href="https://example.com/image.png"/>',
    '<use href="#a"/>', '<animate attributeName="opacity"/>', '<filter id="a"/>', '<style>path { fill:red }</style>',
    '<path onclick="alert(1)"/>', '<path fill="url(https://example.com/color)"/>', '<path fill="url(data:image/png;base64,AA==)"/>',
    '<path style="fill:red"/>', '<path style="filter:blur(1px)"/>', '<path fill="&unknown;"/>',
    '<path fill="&#35;fff"/>', '<path xml:base="file:///tmp/"/>', '<?xml-stylesheet href="https://example.com/a.css"?>',
    '<path fill="url(#missing)"/>', '<linearGradient id="x" href="#y"/>', '<g xmlns="http://www.w3.org/1999/xhtml"/>',
  ]) assert.throws(() => inspect(svg(body)), { code: "unsupported-format" }, body);
  assert.throws(() => inspect(Buffer.from('<!DOCTYPE svg SYSTEM "file:///tmp/private"><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')), { code: "unsupported-format" });
  assert.throws(() => inspectImageHeader(solid, "text/html", policy), { code: "unsupported-format" });
  assert.throws(() => inspectImageHeader(solid, null, policy), { code: "unsupported-format" });
  assert.throws(() => inspect(Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"/>')), { code: "unsupported-format" });
});

test("strict XML and bounded source, path, nodes, numbers, depth, geometry and workspace precede rendering", () => {
  assert.throws(() => inspect(svg('<path></svg>')), { code: "malformed-image" });
  assert.throws(() => inspect(Buffer.from([0xff, 0xfe])), { code: "malformed-image" });
  assert.throws(() => inspect(svg("", 'viewBox="0 0 0 2"')), { code: "malformed-image" });
  assert.throws(() => inspect(svg("", 'width="100%" height="2"')), { code: "unsupported-format" });
  assert.throws(() => inspect(svg("", 'width="99999" height="2"')), { code: "pixel-limit" });
  assert.throws(() => inspect(solid, { maxPixels: 7 }), { code: "pixel-limit" });
  assert.throws(() => inspect(solid, { maxWorkspaceBytes: 1024 }), { code: "workspace-limit" });
  assert.throws(() => inspect(svg(" ".repeat(256 * 1024))), { code: "resource-limit" });
  assert.throws(() => inspect(svg('<g>'.repeat(32) + '</g>'.repeat(32))), { code: "resource-limit" });
  assert.throws(() => inspect(svg('<path/>'.repeat(4096))), { code: "resource-limit" });
  assert.throws(() => inspect(svg(`<path d="M0 0 ${'1 '.repeat(32768)}"/>`)), { code: "resource-limit" });
  assert.throws(() => inspect(svg(`<path d="M0 0 ${' '.repeat(192 * 1024)}"/>`)), { code: "resource-limit" });
  assert.throws(() => inspect(svg('<path transform="translate(1e20)"/>')), { code: "resource-limit" });
  assert.throws(() => inspect(svg('<radialGradient/>'.repeat(129))), { code: "resource-limit" });
  assert.throws(() => inspect(svg('<linearGradient>' + '<stop offset="0"/>'.repeat(2049) + '</linearGradient>')), { code: "resource-limit" });
});

test("UTF-8 percent and base64 SVG data URLs share resource discovery, metadata and budget fences", async () => {
  for (const url of [`data:${mime},${encodeURIComponent(solid.toString())}`, `data:${mime};charset=utf-8,${encodeURIComponent(solid.toString())}`, `data:${mime};base64,${solid.toString("base64")}`]) {
    const document = parseWebDocument(`<img src="${url}">`, { requestUrl: "https://example.com/", finalUrl: "https://example.com/" });
    const updates = [];
    await acquireDocumentImages({ document, finalUrl: document.finalUrl }, { signal: signal(), onResource: (resource) => { updates.push(resource); } }, async () => { assert.fail("data SVG must not use transport"); }, policy);
    assert.deepEqual(updates.map((resource) => resource.status), ["pending", "ready"]);
    assert.equal(updates[0].width, 4); assert.equal("pixels" in updates[0], false);
    assert.equal(updates[0].hasAlpha, null); assert.equal(updates[1].hasAlpha, true);
    assert.deepEqual([...updates[1].pixels.subarray(0, 4)], [255, 0, 0, 128]);
  }
  for (const [url, expected] of [[`data:${mime},%ZZ`, "malformed-image"], [`data:${mime},%ff`, "malformed-image"], [`data:${mime};base64,@@==`, "malformed-image"], [`data:${mime};charset=latin1,%FF`, "unsupported-format"], [`data:${mime},${'%20'.repeat(500)}`, "encoded-byte-limit"]]) {
    const document = parseWebDocument(`<img src="${url}">`, { requestUrl: "https://example.com/", finalUrl: "https://example.com/" });
    const updates = [];
    await acquireDocumentImages({ document, finalUrl: document.finalUrl }, { signal: signal(), onResource: (resource) => { updates.push(resource); } }, async () => { assert.fail(); }, imagePolicy({ maxEncodedBytes: 256 }));
    assert.equal(updates.at(-1).failure, expected);
  }
});

async function acquireDataUrl(url, options = {}) {
  const escaped = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const document = parseWebDocument(`<img src="${escaped}">`, { requestUrl: "https://example.com/", finalUrl: "https://example.com/" });
  const updates = [];
  await acquireDocumentImages({ document, finalUrl: document.finalUrl }, { signal: signal(), onResource: (resource) => { updates.push(resource); } },
    async () => { assert.fail("data images must never use network transport"); }, imagePolicy(options));
  return updates.at(-1);
}

test("data image metadata uses MIME parameter parsing rather than a recognized-token allowlist", async () => {
  const body = encodeURIComponent(solid.toString());
  for (const metadata of [
    "image/svg+xml;utf8", " IMAGE/SVG+XML ;arbitrary;foo=bar;bad=;=ignored;charset=\"UTF-8\" ",
    "image/svg+xml;charset=;charset=utf-8", "image/svg+xml;charset=utf-8;charset=latin1",
    "image/svg+xml;charset=utf8", "image/svg+xml;charset=\"unicode-1-1-utf-8\"",
    "image/svg+xml;charset=\"utf\\-8\"", "image/svg+xml;unknown=\"a;b=c\";garbage",
    "image/svg+xml;unknown=\"unterminated", "image/svg+xml;base64;charset=utf-8", "image/svg+xml;base64=ignored",
  ]) {
    const result = await acquireDataUrl(`data:${metadata},${body}`);
    assert.equal(result.status, "ready", metadata + JSON.stringify(result));
    assert.equal(result.width, 4); assert.equal(result.height, 2);
  }
  for (const metadata of [
    "image//svg+xml", "text/plain", "image/svg+xml;charset=latin1", "image/svg+xml;charset=unknown",
    "image/svg+xml;charset=\"\";charset=utf-8", "image/svg+xml;charset=latin1;charset=utf-8",
  ]) assert.equal((await acquireDataUrl(`data:${metadata},${body}`)).failure, "unsupported-format", metadata);
  assert.equal((await acquireDataUrl(`data:image/svg+xml;${"a".repeat(128)},${body}`)).failure, "malformed-image");
  assert.equal((await acquireDataUrl(`data:image/svg+xml;ignored,${encodeURIComponent(svg('<script/>').toString())}`)).failure, "unsupported-format");
  const literalPercent = solid.toString().replace("<path", "<title>100% literal %2Z %</title><path");
  const percentBody = encodeURIComponent(literalPercent).replace(/%25/gu, "%");
  assert.equal((await acquireDataUrl(`data:image/svg+xml;ignored,${percentBody}`)).status, "ready");
});

test("data image base64 uses the terminal marker and bounded forgiving decoding", async () => {
  const body = solid.toString("base64");
  for (const encoded of [body, body.replace(/=+$/u, ""), encodeURIComponent(body), body.match(/.{1,8}/gu).join("%20%0A%09")]) {
    const result = await acquireDataUrl(`data:image/svg+xml;unknown=ignored;charset="UTF-8";  BaSe64 ,${encoded}`);
    assert.equal(result.status, "ready", encoded + JSON.stringify(result));
    assert.deepEqual([...result.pixels.subarray(0, 4)], [255, 0, 0, 128]);
  }
  for (const encoded of ["A", "AAAA=", "====", "YQ=", "YQ===", "AA_A", "AA-A", "@@==", "%ZZ", "%FF"]) {
    assert.equal((await acquireDataUrl(`data:image/svg+xml;base64,${encoded}`)).failure, "malformed-image", encoded);
  }
  assert.equal((await acquireDataUrl(`data:image/svg+xml;unknown;base64,${body}`, { maxEncodedBytes: 8 })).failure, "encoded-byte-limit");
});

test("SVG workspace admission includes expanded off-canvas layers, inherited gradient paints and clip instances", () => {
  // The renderer permits a 4x-width by 4x-height off-canvas layer at EACH depth.
  // This 753-byte input previously declared 21,182,528 bytes while its WASM heap
  // reached 32,899,072 bytes, before the owned output copy. Never render this probe.
  const layerBody = '<g opacity=".99">'.repeat(29)
    + '<rect x="-100000" y="-100000" width="200000" height="200000" fill="red"/>'
    + '</g>'.repeat(29);
  const layers = svg(layerBody, 'width="128" height="128"');
  assert.throws(() => inspect(layers, { maxWorkspaceBytes: 24 * 1024 * 1024 }), { code: "workspace-limit" });
  assert.ok(inspect(layers).workspaceBytes >= 128 * 128 * (16 + 31 * 16 * 10));
  assert.throws(() => inspect(svg(layerBody, 'width="512" height="512"')), { code: "workspace-limit" });

  // One shared gradient still creates independent stop vectors for every fill and
  // stroke. Inheritance must not hide those allocations from the admission fence.
  const stops = Array.from({ length: 1024 }, (_, index) => `<stop offset="${index / 1023}" stop-color="${index % 2 === 0 ? "blue" : "red"}"/>`).join("");
  const gradient = svg(`<defs><linearGradient id="paint">${stops}</linearGradient></defs>`
    + '<g fill="url(#paint)" stroke="url(#paint)">' + '<rect width="1" height="1"/>'.repeat(768) + '</g>', 'width="1" height="1"');
  assert.throws(() => inspect(gradient, { maxWorkspaceBytes: 24 * 1024 * 1024 }), { code: "workspace-limit" });

  const clipped = svg('<defs><clipPath id="clip">' + '<rect width="1" height="1"/>'.repeat(100)
    + '</clipPath></defs>' + '<rect width="1" height="1" clip-path="url(#clip)"/>'.repeat(50), 'width="1" height="1"');
  assert.throws(() => inspect(clipped, { maxWorkspaceBytes: 32 * 1024 * 1024 }), { code: "workspace-limit" });
});

test("SVG metadata is revalidated at worker boundary and cancellation/deadline terminate rendering", async () => {
  const header = inspect(solid);
  const decoder = new StaticImageDecoder(policy);
  try {
    await assert.rejects(decoder.decode(solid, { ...header, width: 400000 }, signal()), { code: "malformed-image" });
    assert.equal((await decoder.decode(solid, header, signal())).byteLength, 32);
  } finally { await decoder.close(); }
  const timed = new StaticImageDecoder(imagePolicy({ maxDecodeMilliseconds: 0 }));
  try { await assert.rejects(timed.decode(solid, header, signal()), { code: "timeout" }); } finally { await timed.close(); }
  const abort = new globalThis.AbortController();
  const cancelled = new StaticImageDecoder(policy);
  try {
    const pending = cancelled.decode(solid, header, abort.signal); abort.abort(new Error("superseded SVG"));
    await assert.rejects(pending, /superseded SVG/u);
    assert.equal((await cancelled.decode(solid, header, signal())).byteLength, 32);
  } finally { await cancelled.close(); }
});

test("local references cannot recurse through clipping or gradient inheritance", () => {
  for (const body of [
    '<defs><clipPath id="a" clip-path="url(#a)"><path d="M0 0H4V2H0Z"/></clipPath></defs><path clip-path="url(#a)"/>',
    '<defs><clipPath id="a"><g clip-path="url(#b)"/></clipPath><clipPath id="b"><path/></clipPath></defs>',
    '<defs><linearGradient id="a" href="#a"/></defs><path fill="url(#a)"/>',
  ]) assert.throws(() => inspect(svg(body)), { code: "unsupported-format" });
});
