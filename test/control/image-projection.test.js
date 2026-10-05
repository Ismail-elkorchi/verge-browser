import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

function fixture(html, images = []) {
  const document = parseWebDocument(html, { requestUrl: "https://canvas.test/", finalUrl: "https://canvas.test/" });
  const state = createDocumentState(document);
  const store = new RenderArtifactStore();
  store.attach({ documentId: "canvas", documentRevision: 1, stateRevision: 1,
    document, state, images, resources: embeddedStylesheetSources(document) });
  return { store, document, state };
}
function request(options = {}) {
  const columns = options.columns ?? 24, rows = options.rows ?? 8;
  const rect = cssRect(cssPx(0), cssPx(0), cssPx(columns * 8), cssPx(rows * 16));
  return { documentId: "canvas", documentRevision: 1, viewportRevision: options.revision ?? 1,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: rows * 16,
      mediaType: "screen", prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: rect, initialContainingBlock: rect, scrollport: rect,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: { columns, rows, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16),
      unicode: true, ambiguousWidth: 1, colorDepth: options.colorDepth ?? 24, cellMeasurer: terminalCellMeasurer(),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }) },
    window: { scrollRow: options.scrollRow ?? 0, scrollColumn: options.scrollColumn ?? 0,
      viewportRows: rows, overscanBefore: 1, overscanAfter: 1,
      ...(options.scrollOffsets === undefined ? {} : { scrollOffsets: options.scrollOffsets }) },
    searchQuery: options.searchQuery ?? null };
}
function render(fixture, options) { return fixture.store.renderViewport(request(options)); }
function artifacts(fixture, options) { return fixture.store.analyze(request(options)); }

function covers(rect, row, column) { return row >= rect.row && row < rect.row + rect.height && column >= rect.column && column < rect.column + rect.width; }
const imageId = "https://canvas.test/a.png";
function metadata(width = 48, height = 32) { return { id: imageId, requestUrl: imageId, owners: [], width, height }; }

test("canonical opaque image clips respect later text and background paint and retain alt/link identity", () => {
  const value = fixture('<style>body{margin:0}img{display:block;width:48px;height:48px}p{position:absolute;top:16px;left:16px;margin:0;background:blue}</style><a href="/link"><img src="/a.png" alt="ALT"></a><p>XY</p>', [metadata()]);
  try {
    const result = render(value, { searchQuery: "ALT" });
    const images = result.terminal.cellBuffer.images;
    assert.equal(result.displayList.commands.filter((command) => command.kind === "image").length, 1);
    assert.equal(images.some((image) => covers(image.clip, 1, 2)), false);
    assert.equal(images.some((image) => covers(image.clip, 1, 4)), true);
    assert.ok(result.terminal.cellBuffer.rows[0].text.startsWith("ALT"));
    assert.ok(result.terminal.search.matches.length > 0);
    assert.ok(result.terminal.accessibilityBounds.some((entry) => entry.name === "ALT"));
    assert.ok(images.every((image) => image.resourceId === imageId && image.action.kind === "link"));
    assert.ok(images.every((image) => image.naturalWidth === 48 && image.naturalHeight === 32));
  } finally { value.store.dispose(); }
});

test("later native allocations occlude images, earlier controls do not", () => {
  const css = '<style>body{margin:0}img,input{position:absolute;left:0;top:0;width:48px;height:32px;padding:0;border:0}</style>';
  for (const laterImage of [true, false]) {
    const image = '<img src="/a.png" alt="ALT">', control = '<input value="x">';
    const value = fixture(css + (laterImage ? control + image : image + control), [metadata()]);
    try {
      const result = render(value);
      const native = result.terminal.controls[0].visible;
      assert.equal(result.terminal.cellBuffer.images.some((image) => covers(image.clip, native.row, native.column)), laterImage);
      assert.equal(result.terminal.controls.length, 1);
    } finally { value.store.dispose(); }
  }
});

test("image geometry uses canonical nested-scroll projection and no pixel data", () => {
  const value = fixture('<style>body{margin:0}.clip{width:32px;height:32px;overflow:auto}img{display:block;width:64px;height:64px}</style><div class=clip><img src="/a.png" alt="ALT"></div>', [metadata(64,64)]);
  try {
    const first = render(value), owner = value.document.replacedContent[0].node;
    const port = first.terminal.scrollPorts[0];
    const scrolled = render(value, { scrollOffsets: [{ node: port.node, inline: cssPx(8), block: cssPx(16) }] });
    assert.notDeepEqual(scrolled.terminal.cellBuffer.images[0].bounds, first.terminal.cellBuffer.images[0].bounds);
    assert.ok(scrolled.terminal.cellBuffer.images.every((image) => image.clip.width <= 4 && image.clip.height <= 2));
    assert.ok(!JSON.stringify(scrolled.terminal.cellBuffer.images).includes("pixels"));
    assert.ok(owner);
  } finally { value.store.dispose(); }
});

test("only changed natural dimensions invalidate image layout; search and computed style stay shared", () => {
  const value = fixture('<style>body{margin:0}img{display:block}</style><img src="/a.png" alt="ALT">', [metadata()]);
  try {
    const before = artifacts(value);
    value.store.updateImages({ documentId: "canvas", documentRevision: 1, images: [metadata()] });
    const same = artifacts(value);
    assert.equal(same.documentLayout, before.documentLayout);
    value.store.updateImages({ documentId: "canvas", documentRevision: 1, images: [metadata(96,64)] });
    const changed = artifacts(value);
    assert.notEqual(changed.documentLayout, before.documentLayout);
    assert.equal(changed.computedStyles, before.computedStyles);
    assert.equal(changed.textSearchIndex, before.textSearchIndex);
    const image = changed.boxTree.forSource(value.document.replacedContent[0].node)[0];
    assert.equal(image.kind, "image"); assert.equal(image.naturalWidth, 96);
    assert.throws(() => value.store.updateImages({ documentId: "canvas", documentRevision: 2, images: [] }), /Unknown render document revision/u);
    assert.ok(value.store.metrics().retainedCost >= value.store.recountRetainedCost());
  } finally { value.store.dispose(); }
});

test("image clip retention is bounded and rejected/zero-budget output has no graphics", () => {
  const value = fixture('<style>body{margin:0}img{display:block;width:48px;height:48px}</style><img src="/a.png" alt="ALT">', [metadata()]);
  try {
    const result = render(value, { budgets: { maxRetainedImagePlacements: 0 } });
    assert.equal(result.terminal.cellBuffer.images.length, 0);
    assert.ok(result.terminal.cellBuffer.rows[0].text.startsWith("ALT"));
    assert.ok(result.terminal.truncations.some((entry) => entry.budget === "maxRetainedImagePlacements"));
  } finally { value.store.dispose(); }
});

for (const [name, css, wrapper, expected] of [
  ["natural", "", "", [48, 32]], ["width", "width:96px", "", [96, 64]],
  ["height", "height:64px", "", [96, 64]], ["min", "min-width:96px", "", [96, 64]],
  ["max", "max-width:24px", "", [24, 16]], ["float", "float:left", "", [48, 32]],
  ["flex stretch", "", "display:flex;width:192px;height:128px", [48, 128]],
  ["grid normal", "", "display:grid;grid-template-columns:192px;height:128px", [48, 32]],
]) {
  test(`shared replaced image sizing handles ${name}`, () => {
    const value = fixture(`<style>body{margin:0}img{${css}}</style><div style="${wrapper}"><img src="/a.png" alt="ALT"></div>`, [metadata()]);
    try {
      const image = artifacts(value).documentLayout.forDocumentNode(value.document.replacedContent[0].node)[0];
      assert.deepEqual([image.contentRect.width / cssPx(1), image.contentRect.height / cssPx(1)], expected);
    } finally { value.store.dispose(); }
  });
}

test("80 fixed-size image metadata completions refresh paint without repeating document layout", () => {
  const count = 80;
  let images = Array.from({ length: count }, (_, index) => ({ ...metadata(null, null),
    id: `https://canvas.test/${index}.png`, requestUrl: `https://canvas.test/${index}.png` }));
  const value = fixture('<style>body{margin:0}</style>' + images.map((image) =>
    `<img src="${image.id}" width="32" height="16" alt="ALT">`).join(""), images);
  try {
    const first = artifacts(value);
    for (let index = 0; index < count; index += 1) {
      images = images.map((image, offset) => offset === index ? { ...image, width: 2, height: 2 } : image);
      // A resource-only UI revision must not invalidate style before image admission.
      value.store.updateState({ documentId: "canvas", documentRevision: 1, stateRevision: index + 2,
        state: value.state, changed: new Set() });
      assert.equal(value.store.updateImages({ documentId: "canvas", documentRevision: 1, images }), "paint");
      const next = artifacts(value);
      assert.equal(next.documentLayout, first.documentLayout);
      assert.equal(next.boxTree, first.boxTree);
      assert.equal(next.textSearchIndex, first.textSearchIndex);
      assert.equal(next.computedStyles, first.computedStyles);
      assert.equal([...next.documentDisplayList.commands].find((command) => command.kind === "image" && command.resourceId === images[index].id).naturalWidth, 2);
    }
    assert.ok(value.store.metrics().retainedCost >= value.store.recountRetainedCost());
  } finally { value.store.dispose(); }
});

test("later ink on half of a wide alt glyph preserves uncovered opaque image coverage", () => {
  const value = fixture('<style>body{margin:0}img{display:block;width:24px;height:16px}p{position:absolute;left:8px;top:0;margin:0}</style><img src="/a.png" alt="界"><p>X</p>', [metadata()]);
  try {
    const result = render(value);
    assert.equal(result.terminal.cellBuffer.images.some((image) => covers(image.clip, 0, 0)), true);
    assert.equal(result.terminal.cellBuffer.images.some((image) => covers(image.clip, 0, 1)), false);
    assert.equal(result.terminal.cellBuffer.rows[0].text, " X ");
  } finally { value.store.dispose(); }
});

for (const laterControl of [true, false]) {
  test(`empty native editor has canonical paint-group order without a text command (${laterControl ? "above" : "below"} image)`, () => {
    const css = '<style>body{margin:0}img,textarea{position:absolute;left:0;top:0;width:48px;height:48px;padding:0;border:0;background:transparent}</style>';
    // Stacking order deliberately differs from source order in one direction.
    const value = fixture(css + `<textarea style="z-index:${laterControl ? 2 : 0}" rows=3 cols=6></textarea><img style="z-index:1" src="/a.png" alt="ALT">`, [metadata()]);
    try {
      const result = render(value), control = result.terminal.controls[0];
      assert.ok(control.paintGroup >= 0);
      assert.equal(result.displayList.commands.some((command) => command.layoutFragment === control.layoutFragment), false);
      assert.equal(result.terminal.cellBuffer.images.some((image) => covers(image.clip, control.visible.row, control.visible.column)), !laterControl);
      assert.ok(result.displayList.commands.every((command) => command.kind !== "text" || command.text.length > 0));
    } finally { value.store.dispose(); }
  });
}
