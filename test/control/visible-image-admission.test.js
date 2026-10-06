import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { discoverDocumentImages } from "../../dist/app/image-acquisition.js";
import { discoverViewportImages, selectViewportImages, pageImageMetadata } from "../../dist/app/image-admission.js";
import { cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { acceptImageResource, acceptViewportImageAdmission, imageSources, retainedImageBytes } from "../../dist/ui/image-loading.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

function fixture(html, limit = 32) {
  const document = parseWebDocument(html, { requestUrl: "https://media.test/", finalUrl: "https://media.test/" });
  const images = discoverDocumentImages(document, { maxResources: limit }).resources;
  const snapshot = { document, images, imageResourceLimit: limit };
  const browser = { kind: "ready", id: "media", loading: false, documentRevision: 1, stateRevision: 1, snapshot,
    documentState: createDocumentState(document), search: null,
    navigation: { index: 0, entries: [{ documentId: "source", snapshot }] },
    rendering: { committedViewportRevision: 1, requestKey: "current", pendingSearch: null, searchRequestGeneration: 0 } };
  const store = new RenderArtifactStore();
  store.attach({ documentId: browser.id, documentRevision: 1, stateRevision: 1, document, state: browser.documentState,
    images: pageImageMetadata(snapshot), resources: embeddedStylesheetSources(document) });
  return { document, browser, store };
}
function request(options = {}) {
  const columns = 80, rows = 12, viewport = cssRect(cssPx(0), cssPx(0), cssPx(columns * 8), cssPx(rows * 16));
  return { documentId: "media", documentRevision: 1, viewportRevision: options.revision ?? 1,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: rows * 16, mediaType: "screen",
      prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport, initialContainingBlock: viewport, scrollport: viewport,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: { columns, rows, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16), unicode: true,
      ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() },
    window: { scrollRow: options.scrollRow ?? 0, viewportRows: rows, overscanBefore: 4, overscanAfter: 4,
      scrollOffsets: options.scrollOffsets ?? [] }, searchQuery: null };
}
const state = (document) => ({ documents: [document], activeDocumentIndex: 0, recentlyClosed: [] });
const resource = (document, name) => ({ id: `https://media.test/${name}`, requestUrl: `https://media.test/${name}`,
  owners: [document.elementById(name)], width: null, height: null, hasAlpha: null });
const ready = (image, width = 40, height = 32) => ({ ...image, status: "ready", width, height, hasAlpha: false,
  mimeType: "image/png", pixels: new Uint8Array(width * height * 4) });
const incoming = (document, image, revision = document.snapshot.imageResourceRevision ?? 0) => ({ kind: "imageResource",
  documentId: document.id, documentRevision: document.documentRevision, resourceRevision: revision, resource: image });

test("accepted viewport admits visible CSS artwork and late img despite a saturated source prefix", () => {
  const f = fixture('<style>body{margin:0}.off{position:absolute;top:2000px}.icon{display:block;width:16px;height:16px;background:black;mask-image:url(icon.svg)}</style>'
    + Array.from({ length: 32 }, (_, i) => `<img class=off src="off-${i}.png" width=8 height=8>`).join("")
    + '<span class=icon id=icon></span><img id=late src="late.png" width=16 height=16>');
  try {
    assert.equal(f.browser.snapshot.images.length, 32);
    const result = f.store.renderViewport(request());
    const visible = discoverViewportImages(result.displayList);
    assert.deepEqual(new Set(visible.resources.map((image) => image.id)), new Set(["https://media.test/icon.svg", "https://media.test/late.png"]));
    const admitted = acceptViewportImageAdmission(f.browser, visible.resources);
    assert.equal(admitted.snapshot.images.length, 32);
    assert.ok(admitted.snapshot.images.slice(0, 2).every((image) => visible.resources.some((entry) => entry.id === image.id)));
    assert.equal(new Set(admitted.snapshot.images.map((image) => image.id)).size, 32);
    assert.equal(admitted.snapshot.images.find((image) => image.id.endsWith("off-0.png")), f.browser.snapshot.images[0]);
    assert.equal(acceptViewportImageAdmission(admitted, visible.resources), admitted);
    assert.equal(admitted.snapshot.images, admitted.navigation.entries[0].snapshot.images);
  } finally { f.store.dispose(); }
});

test("oversubscribed visible media shares the same fixed pool fairly and deduplicates canonical URLs", () => {
  const f = fixture('<style>body{margin:0}img,.icon{position:absolute;top:0;width:16px;height:16px}.icon{background:black}</style>'
    + Array.from({ length: 40 }, (_, i) => `<img src="img-${i}.png" style="left:${i * 16}px">`).join("")
    + Array.from({ length: 40 }, (_, i) => `<span class=icon style="top:32px;left:${i * 16}px;mask-image:url(mask-${i}.svg)"></span>`).join(""));
  try {
    const priority = discoverViewportImages(f.store.renderViewport(request()).displayList);
    assert.equal(priority.resources.length, 32); assert.ok(priority.omittedReferences > 0);
    assert.equal(priority.resources.filter((image) => image.id.includes("/img-")).length, 16);
    assert.equal(priority.resources.filter((image) => image.id.includes("/mask-")).length, 16);
    const merged = selectViewportImages(f.browser.snapshot, priority.resources);
    assert.deepEqual(merged.map((image) => image.id), priority.resources.map((image) => image.id));
    assert.equal(selectViewportImages({ ...f.browser.snapshot, imageResourceLimit: 0 }, priority.resources).length, 0);
    const two = selectViewportImages({ ...f.browser.snapshot, imageResourceLimit: 2 }, priority.resources);
    assert.equal(two.length, 2); assert.notEqual(two[0].id.includes("/img-"), two[1].id.includes("/img-"));
  } finally { f.store.dispose(); }
});

test("visibility admission respects opacity, overflow, nested scrolling and fixed projection", () => {
  const f = fixture('<style>body{margin:0}.icon{display:block;width:16px;height:16px;background:black;mask-image:url(icon.svg)}'
    + '.hidden{opacity:0}.clip{height:16px;overflow:hidden}.scroller{height:16px;overflow:auto}.fixed{position:fixed;top:0;left:160px}</style>'
    + '<div class=hidden><img src=hidden.png width=16 height=16><span class=icon></span></div>'
    + '<div class=clip><div style="height:32px"></div><img src=clipped.png width=16 height=16></div>'
    + '<div class=scroller id=scroller><div style="height:48px"></div><img src=scrolled.png width=16 height=16></div>'
    + '<span class="icon fixed"></span><div style="height:2000px"></div><img src=bottom.png width=16 height=16>');
  try {
    const first = discoverViewportImages(f.store.renderViewport(request()).displayList).resources;
    assert.deepEqual(first.map((image) => image.id), ["https://media.test/icon.svg"]);
    const scrolled = discoverViewportImages(f.store.renderViewport(request({ scrollOffsets: [{ node: f.document.elementById("scroller"),
      inline: cssPx(0), block: cssPx(48) }] })).displayList).resources;
    assert.ok(scrolled.some((image) => image.id.endsWith("scrolled.png")));
    assert.ok(!scrolled.some((image) => image.id.endsWith("clipped.png") || image.id.endsWith("hidden.png")));
    const rootScrolled = discoverViewportImages(f.store.renderViewport(request({ scrollRow: 50 })).displayList).resources;
    assert.ok(rootScrolled.some((image) => image.id.endsWith("icon.svg")), "fixed artwork remains visible after root scroll");
  } finally { f.store.dispose(); }
});

test("pool rotation preserves intrinsic layout and scroll anchors without retaining evicted decoded owners", () => {
  const f = fixture('<style>body{margin:0}img{display:block}</style><img id="a.png" src="a.png"><div style="height:800px"></div><img id="b.png" src="b.png"><p id=anchor>anchor</p>', 1);
  try {
    const first = ready(f.browser.snapshot.images[0]);
    let document = { ...f.browser, snapshot: { ...f.browser.snapshot, images: [first] } };
    f.store.updateImages({ documentId: "media", documentRevision: 1, images: pageImageMetadata(document.snapshot) });
    const before = f.store.analyze(request());
    const anchor = before.documentLayout.forDocumentNode(f.document.elementById("anchor"))[0].borderRect;
    document = acceptViewportImageAdmission(document, [resource(f.document, "b.png")]);
    assert.equal(document.snapshot.images.length, 1); assert.equal(document.snapshot.images[0].status, "pending");
    assert.deepEqual(document.snapshot.imageIntrinsicDimensions, [{ id: first.id, width: 40, height: 32 }]);
    assert.equal(retainedImageBytes(state(document)), 0);
    assert.equal(f.store.updateImages({ documentId: "media", documentRevision: 1, images: pageImageMetadata(document.snapshot) }), "paint");
    const after = f.store.analyze(request());
    assert.equal(after.documentLayout, before.documentLayout);
    assert.deepEqual(after.documentLayout.forDocumentNode(f.document.elementById("anchor"))[0].borderRect, anchor);
    const returned = acceptViewportImageAdmission(document, [resource(f.document, "a.png")]);
    assert.equal(returned.snapshot.images[0].id, first.id);
    assert.equal(returned.snapshot.images[0].width, first.width); assert.equal(returned.snapshot.images[0].height, first.height);
    assert.deepEqual(returned.snapshot.imageIntrinsicDimensions, []);
    assert.equal("pixels" in returned.snapshot.images[0], false);
    assert.equal(f.store.updateImages({ documentId: "media", documentRevision: 1, images: pageImageMetadata(returned.snapshot) }), "paint");
    assert.equal(f.store.analyze(request()).documentLayout, before.documentLayout);
  } finally { f.store.dispose(); }
});

test("constant-size replacement starts a new source and rejects stale deliveries after URL reentry", async () => {
  const f = fixture('<img id="a.png" src="a.png"><img id="b.png" src="b.png">', 1);
  try {
    let document = f.browser;
    const firstGeneration = imageSources({}, state(document))[0].generation;
    document = acceptViewportImageAdmission(document, [resource(f.document, "b.png")]);
    const secondGeneration = imageSources({}, state(document))[0].generation;
    assert.notEqual(secondGeneration, firstGeneration);
    document = acceptViewportImageAdmission(document, [resource(f.document, "a.png")]);
    const thirdGeneration = imageSources({}, state(document))[0].generation;
    assert.notEqual(thirdGeneration, secondGeneration);
    const current = state(document), completion = ready(document.snapshot.images[0]);
    assert.equal(acceptImageResource(current, incoming(document, completion, 0)), current);
    assert.equal(acceptImageResource(current, { kind: "imageResourcesFailed", documentId: "media", documentRevision: 1,
      resourceRevision: 0, resourceIds: [completion.id] }), current);
    const header = { ...document.snapshot.images[0], width: 40, height: 32 };
    const sized = acceptImageResource(current, incoming(document, header));
    assert.equal(imageSources({}, sized)[0].generation, thirdGeneration);
    assert.equal(acceptImageResource(sized, incoming(document, completion)).documents[0].snapshot.images[0].status, "ready");
    let calls = 0;
    const events = [];
    const [source] = imageSources({ async acquireImages(_document, _signal, emit) { calls += 1; await emit(completion); } }, current);
    await source.run({ signal: new globalThis.AbortController().signal }, { async emit(value) { events.push(value.message); } });
    assert.equal(calls, 1); assert.equal(events[0].resourceRevision, document.snapshot.imageResourceRevision);
    assert.equal(source.onLifecycle({ kind: "failed" }).resourceRevision, document.snapshot.imageResourceRevision);
  } finally { f.store.dispose(); }
});

test("initial acquisition waits for accepted geometry and dynamic CSS URLs leave no intrinsic history", () => {
  const f = fixture('<img id="a.png" src="a.png"><span id=icon></span>', 1);
  try {
    assert.deepEqual(imageSources({}, state({ ...f.browser, rendering: { ...f.browser.rendering, committedViewportRevision: 0 } })), []);
    let document = f.browser;
    for (let index = 0; index < 70; index += 1) {
      const mask = { id: `https://media.test/mask-${index}.svg`, requestUrl: `https://media.test/mask-${index}.svg`,
        owners: [f.document.elementById("icon")], width: null, height: null, hasAlpha: null };
      document = acceptViewportImageAdmission(document, [mask]);
      assert.equal(document.snapshot.images.length, 1);
      document = acceptImageResource(state(document), incoming(document, ready(document.snapshot.images[0]))).documents[0];
      assert.deepEqual(document.snapshot.images[0].owners, [f.document.elementById("icon")]);
      assert.deepEqual(document.snapshot.imageIntrinsicDimensions, []);
    }
  } finally { f.store.dispose(); }
});

test("visible discovery reads only spatially queried commands even for long documents", () => {
  const f = fixture('<style>body{margin:0}.icon{display:block;width:16px;height:16px;background:black;mask-image:url(icon.svg)}img{display:block;width:16px;height:16px}</style>'
    + '<span class=icon></span><img src=top.png><div style="height:1000px"></div>'
    + Array.from({ length: 500 }, (_, i) => `<img src="off-${i}.png">`).join(""));
  try {
    const frame = f.store.renderViewport(request());
    assert.ok(frame.displayList.documentDisplayList.fragmentPaintOrder.length > 500);
    assert.ok(frame.displayList.commands.length < 10);
    let reads = 0;
    const candidateOnly = { viewportRect: frame.displayList.viewportRect,
      get documentDisplayList() { throw new Error("visible discovery must not rescan the document"); },
      get projection() { throw new Error("visible discovery must consume already projected commands"); },
      commands: { *[Symbol.iterator]() { for (const command of frame.displayList.commands) { reads += 1; yield command; } } } };
    const result = discoverViewportImages(candidateOnly);
    assert.equal(reads, frame.displayList.commands.length);
    assert.deepEqual(new Set(result.resources.map((image) => image.id)), new Set(["https://media.test/icon.svg", "https://media.test/top.png"]));
  } finally { f.store.dispose(); }
});

test("shared visible img and mask URL owns one resource and current owners only", () => {
  const f = fixture('<style>body{margin:0}.icon{display:block;width:16px;height:16px;background:black;mask-image:url(shared.svg)}</style>'
    + '<img id=image src=shared.svg width=16 height=16><span id=icon class=icon></span>');
  try {
    const visible = discoverViewportImages(f.store.renderViewport(request()).displayList);
    assert.equal(visible.resources.length, 1);
    assert.deepEqual(new Set(visible.resources[0].owners), new Set([f.document.elementById("image"), f.document.elementById("icon")]));
    const admitted = acceptViewportImageAdmission(f.browser, visible.resources);
    assert.equal(admitted.snapshot.images.length, 1);
    assert.equal(admitted.snapshot.imageResourceRevision, 0, "owner-only changes do not retire the source");
    const ownerReads = [];
    const indexedOnly = { ...admitted.snapshot, document: {
      get replacedContent() { throw new Error("admission must use indexed source evidence"); },
      replaced(owner) { ownerReads.push(owner); return f.document.replaced(owner); },
    } };
    const hidden = selectViewportImages(indexedOnly, []);
    assert.deepEqual(hidden[0].owners, [f.document.elementById("image")]);
    assert.equal(ownerReads.length, 2);
  } finally { f.store.dispose(); }
});

test("pending pseudo artwork retains its source owner while zero-size and hidden boxes are excluded", () => {
  const f = fixture('<style>body{margin:0}#owner::before{content:"";display:block;width:16px;height:16px;background:black;mask-image:url(pseudo.svg)}'
    + '.icon{display:block;width:16px;height:16px;background:black;mask-image:url(hidden.svg)}</style>'
    + '<span id=owner></span><span class=icon style="width:0"></span><span class=icon style="height:0"></span>'
    + '<span class=icon style="visibility:hidden"></span><span class=icon style="display:none"></span>');
  try {
    const discovered = discoverViewportImages(f.store.renderViewport(request()).displayList);
    assert.equal(discovered.resources.length, 1);
    assert.equal(discovered.resources[0].id, "https://media.test/pseudo.svg");
    assert.deepEqual(discovered.resources[0].owners, [f.document.elementById("owner")]);
  } finally { f.store.dispose(); }
});
