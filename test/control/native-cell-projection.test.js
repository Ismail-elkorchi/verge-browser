import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { terminalCellMeasurer, terminalCssControlMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

function fixture(t, html, options = {}) {
  const document = parseWebDocument(`<style>html,body,p{margin:0}</style>${html}`,
    { requestUrl: "https://projection.test/", finalUrl: "https://projection.test/" });
  const columns = options.columns ?? 64, rows = options.rows ?? 10;
  const rect = cssRect(cssPx(0), cssPx(0), cssPx(columns * 8), cssPx(rows * 16));
  const request = { documentId: "projection", documentRevision: 1, viewportRevision: 1,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: rows * 16, mediaType: "screen",
      prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: rect, initialContainingBlock: rect, scrollport: rect,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: { columns, rows, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16),
      unicode: options.unicode ?? true, ambiguousWidth: 1, colorDepth: options.colorDepth ?? 24, cellMeasurer: terminalCellMeasurer(),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }) },
    window: { scrollRow: 0, viewportRows: rows, overscanBefore: 0, overscanAfter: 0 },
    searchQuery: options.searchQuery ?? null };
  const store = new RenderArtifactStore();
  t.after(() => store.dispose());
  store.attach({ documentId: "projection", documentRevision: 1, stateRevision: 1, document,
    state: createDocumentState(document), images: options.images ?? [], resources: embeddedStylesheetSources(document) });
  const render = (window = {}) => store.renderViewport({ ...request, window: { ...request.window, ...window } });
  return { document, request, render, ...store.analyze(request), ...render() };
}

function textRows(result) { return result.terminal.cellBuffer.rows.filter((row) => row.spans.length > 0); }
function fragments(layout) {
  const values = [], pending = [layout.root];
  while (pending.length > 0) { const value = layout.fragment(pending.pop()); values.push(value); pending.push(...value.children); }
  return values;
}
function cellContains(rect, row, column) {
  return rect.row <= row && rect.row + rect.height > row && rect.column <= column && rect.column + rect.width > column;
}

test("mixed line heights share one projected baseline at every terminal-row phase and retain source/search/action bounds", (t) => {
  for (let phase = 0; phase < 32; phase += 1) {
    const result = fixture(t, `<p style="padding-top:${phase}px;line-height:28px">normal `
      + '<a id=compact href=/next style="line-height:16px">compact界</a> '
      + '<span style="line-height:40px">tall</span> tail</p>', { searchQuery: "compact界" });
    const rows = textRows(result), expectedRow = Math.floor((phase + 12) / 16);
    assert.equal(rows.length, 1, `phase ${phase}`);
    assert.equal(rows[0].row, expectedRow);
    assert.equal(rows[0].text.trim(), "normal compact界 tall tail");
    const source = result.document.elementById("compact");
    const range = result.terminal.search.ranges[0];
    assert.ok(range.sourceRange);
    assert.equal(range.row, expectedRow);
    const span = rows[0].spans.find((entry) => entry.action?.node === source);
    assert.ok(span && span.sourceRange);
    const column = rows[0].cells.find((cell) => cell.layoutFragment === span.layoutFragment).column;
    assert.equal(result.terminal.hitTestIndex.at(expectedRow, column)?.action.node, source);
    assert.ok(result.terminal.focusMap.forNode(source).rects.some((rect) => cellContains(rect, expectedRow, column)));
    assert.ok(cellContains(result.terminal.accessibilityBounds.find((entry) => entry.documentNode === source).rect, expectedRow, column));
  }
});

test("real vertical-align shifts survive baseline projection", (t) => {
  const result = fixture(t, '<p style="padding-top:32px;line-height:16px">normal '
    + '<span style="vertical-align:16px">raised</span> <span style="vertical-align:-16px">lowered</span></p>');
  const rowFor = (text) => textRows(result).find((row) => row.text.includes(text)).row;
  assert.equal(rowFor("normal") - rowFor("raised"), 1);
  assert.equal(rowFor("lowered") - rowFor("normal"), 1);
  for (const fragment of fragments(result.documentLayout).filter((entry) => entry.kind === "text")) {
    const row = textRows(result).find((entry) => entry.spans.some((span) => span.layoutFragment === fragment.id));
    if (row !== undefined) assert.equal(row.row, Math.floor((fragment.contentRect.y + fragment.baseline - cssPx(12)) / cssPx(16)));
  }
});

test("fractional CSS line spacing remains exact in layout and explicitly quantized to native rows", (t) => {
  const result = fixture(t, '<p style="line-height:26px">one<br>two<br>three<br>four</p>');
  assert.deepEqual(textRows(result).map((row) => row.row), [0, 1, 3, 5]);
  const lines = result.documentLayout.lineBoxes;
  assert.equal(lines.length, 4);
  for (let index = 1; index < lines.length; index += 1) assert.equal(lines[index].rect.y - lines[index - 1].rect.y, cssPx(26));
});

test("ink extending outside a short line box survives viewport culling and search projection", (t) => {
  const result = fixture(t, '<p style="padding-top:20px;line-height:1px"><a href=/next>ink</a></p><div style="height:100px"></div>',
    { rows: 1, searchQuery: "ink" });
  const fragment = fragments(result.documentLayout).find((entry) => entry.kind === "text" && entry.text === "ink");
  assert.ok(fragment.contentRect.y >= cssPx(16));
  assert.ok(fragment.inkRect.y < cssPx(16));
  assert.equal(textRows(result)[0].text, "ink");
  assert.equal(result.terminal.search.ranges[0].row, 0);
});

test("nested scrolling and sticky translations preserve shared baseline rows", (t) => {
  const result = fixture(t, '<style>#scroll{width:400px;height:64px;overflow:auto}.sticky{position:sticky;top:0;line-height:28px}'
    + '.compact{line-height:16px}.tall{line-height:40px}</style><div id=scroll><div style="height:40px"></div>'
    + '<p class=sticky>normal <span class=compact>compact</span> <span class=tall>tall</span></p><div style="height:160px"></div></div>');
  const source = result.document.elementById("scroll");
  for (const block of [0, 16, 40, 56, 80]) {
    const painted = result.render({ scrollOffsets: [{ node: source, inline: cssPx(0), block: cssPx(block) }] });
    const rows = textRows(painted);
    assert.equal(rows.length, 1, `scroll ${block}`);
    assert.equal(rows[0].text.trim(), "normal compact tall");
    const commands = painted.displayList.commands.filter((command) => command.kind === "text");
    assert.ok(commands.every((command) => Math.floor((command.rect.y + command.baseline - cssPx(12)) / cssPx(16)) === rows[0].row));
  }
});

test("single-line native controls consume canonical centered paint geometry including natural overflow", (t) => {
  for (const height of [1, 8, 16, 30, 48]) {
    const result = fixture(t, `<div style="padding-top:32px"><input id=editor value=alpha style="height:${height}px;line-height:28px;padding:4px;border:1px solid"></div>`);
    const control = result.terminal.controls[0], fragment = result.documentLayout.fragment(control.layoutFragment);
    assert.equal(fragment.nativeControlPaintRect.y, fragment.contentRect.y + (fragment.contentRect.height - cssPx(16)) / 2);
    assert.equal(control.allocation.row, Math.floor((fragment.nativeControlPaintRect.y + fragment.nativeControlBaseline - cssPx(12)) / cssPx(16)));
    assert.equal(control.allocation.height, 1);
    assert.equal(control.style.background, null);
    const text = textRows(result).find((row) => row.text.includes("alpha"));
    assert.equal(text.row, control.allocation.row);
  }
});

test("thin background decorations use a line glyph rather than full-cell background at every phase and color capability", (t) => {
  for (const phase of [0, 7, 15, 16, 23]) for (const colorDepth of [0, 4, 8, 24]) for (const unicode of [false, true]) {
    const result = fixture(t, `<div id=rule style="position:absolute;left:0;top:${phase}px;width:32px;height:2px;background:#c79d30"></div>`,
      { colorDepth, unicode });
    const rule = result.document.elementById("rule");
    const cells = result.terminal.cellBuffer.rows.flatMap((row) => row.cells.filter((cell) => cell.documentNode === rule).map((cell) => ({ ...cell, row: row.row })));
    assert.equal(cells.length, 4);
    assert.ok(cells.every((cell) => cell.text === (unicode ? "─" : "-")));
    assert.ok(cells.every((cell) => cell.style.background === null));
    assert.ok(cells.every((cell) => cell.row === Math.floor((phase + 1) / 16)));
  }
});

test("subcell chrome collision degrades the decoration while true opaque surfaces retain paint order", (t) => {
  const surface = (height) => `<div style="position:absolute;left:0;top:0;width:80px;height:${height}px;background:red"></div>`;
  for (const chrome of [surface(1), '<div style="position:absolute;left:0;top:0;width:80px;height:16px;border-top:1px solid red"></div>']) {
    const result = fixture(t, `<a href=/next>read界able</a>${chrome}`, { searchQuery: "read界able" });
    assert.ok(textRows(result)[0].text.includes("read界able"));
    assert.equal(result.terminal.search.matches.length, 1);
    assert.ok(textRows(result)[0].spans.every((span) => span.sourceRange !== null));
  }
  const opaque = fixture(t, `<a href=/next>readable</a>${surface(16)}`);
  assert.equal(textRows(opaque).length, 0, "a genuine later surface still obscures earlier glyphs");
});

test("zero-opacity ancestry suppresses ink while retaining native controls, focus, hit testing and accessibility", (t) => {
  const result = fixture(t, '<style>#hidden{opacity:0}#generated::before{content:"invisible";opacity:0}</style>'
    + '<div id=hidden><a id=link href=/next>hidden</a><input id=editor value=secret></div><div id=generated>shown</div>');
  const link = result.document.elementById("link"), editor = result.document.elementById("editor");
  const text = result.terminal.cellBuffer.rows.map((row) => row.text).join("\n");
  assert.ok(!text.includes("hidden") && !text.includes("secret") && !text.includes("invisible"), text);
  assert.ok(text.includes("shown"));
  assert.equal(result.terminal.controls.find((control) => control.node === editor).paintSuppressed, true);
  assert.ok(result.terminal.focusMap.forNode(link));
  assert.ok(result.terminal.focusMap.forNode(editor));
  assert.ok(result.terminal.hitTestIndex.regions.some((region) => region.action.node === editor));
  assert.ok(result.terminal.accessibilityBounds.some((entry) => entry.documentNode === editor));
});

test("boxless contents opacity does not create a paint group, while ancestor and pseudo boxes still do", (t) => {
  const result = fixture(t, '<style>.contents{display:contents;opacity:0}.hidden{opacity:0}'
    + '#pseudo::before{content:"PSEUDO_HIDDEN";opacity:inherit}</style>'
    + '<div class=contents id=pseudo><span>SHOWN</span><input id=shown value=EDITABLE></div>'
    + '<div class=hidden><div style="display:contents"><span>ANCESTOR_HIDDEN</span><input id=hidden></div></div>');
  const text = result.terminal.cellBuffer.rows.map((row) => row.text).join("\n");
  assert.ok(text.includes("SHOWN"), text);
  assert.ok(!text.includes("PSEUDO_HIDDEN") && !text.includes("ANCESTOR_HIDDEN"), text);
  assert.equal(result.terminal.controls.find((control) => control.node === result.document.elementById("shown")).paintSuppressed, false);
  assert.equal(result.terminal.controls.find((control) => control.node === result.document.elementById("hidden")).paintSuppressed, true);
});

test("paint-command truncation cannot reveal a later zero-opacity native control", (t) => {
  const result = fixture(t, 'visible <input value=secret style="opacity:0">', { budgets: { maxDisplayListCommands: 0 } });
  assert.equal(result.documentDisplayList.outcome.status, "truncated");
  assert.equal(result.terminal.controls.length, 1);
  assert.equal(result.terminal.controls[0].paintSuppressed, true);
});

const imageId = "https://projection.test/icon.svg";
const imageMetadata = (hasAlpha = true, width = 32, height = 16) => ({
  id: imageId, requestUrl: imageId, owners: [], width, height, hasAlpha,
});

test("image transparency admission proves uniform opaque backdrop and preserves native glyph ownership", (t) => {
  const style = '<style>body{background:white}img{position:absolute;left:0;top:0;width:80px;height:16px}</style>';
  const alpha = fixture(t, `${style}<a href=/next>read界</a><img src=/icon.svg alt=ALT>`, { images: [imageMetadata()], searchQuery: "read界" });
  assert.ok(textRows(alpha)[0].text.startsWith("read界"));
  assert.equal(alpha.terminal.search.matches.length, 1);
  assert.ok(alpha.terminal.cellBuffer.images.every((image) => image.clip.column >= 6));
  assert.ok(alpha.terminal.cellBuffer.images.every((image) => image.safeForTransparency
    && image.compositingBackdrop.r === 255 && image.compositingBackdrop.a === 1));
  const opaque = fixture(t, `${style}<a href=/next>read界</a><img src=/icon.svg alt=ALT>`, { images: [imageMetadata(false)] });
  assert.ok(!opaque.terminal.cellBuffer.rows[0].text.includes("read界"), "opaque image paint order remains authoritative");
  assert.ok(opaque.terminal.cellBuffer.images.every((image) => !image.safeForTransparency));
});

test("alpha artwork excludes native editors even when the image paints later", (t) => {
  const result = fixture(t, '<style>body{background:white}textarea,img{position:absolute;left:0;top:0;width:80px;height:32px;padding:0;border:0}</style>'
    + '<textarea></textarea><img src=/icon.svg>', { images: [imageMetadata()] });
  assert.equal(result.terminal.controls.length, 1);
  assert.equal(result.terminal.cellBuffer.images.length, 0);
});

test("alpha clips outside earlier native editors retain their proven opaque backdrop", (t) => {
  const result = fixture(t, '<style>body{background:white}textarea,img{position:absolute;left:0;top:0;height:32px;padding:0;border:0}'
    + 'textarea{width:40px}img{width:80px}</style><textarea></textarea><img src=/icon.svg>', { images: [imageMetadata()] });
  assert.ok(result.terminal.cellBuffer.images.length > 0);
  assert.ok(result.terminal.cellBuffer.images.every((image) => image.clip.column >= 5 && image.safeForTransparency
    && image.compositingBackdrop.r === 255));
});

test("alpha images and masks may paint control padding while actual editable allocations remain protected", (t) => {
  for (const masked of [false, true]) for (const border of [0, 1]) for (const value of ["", "typed界"]) {
    const css = '<style>body{background:white}#wrap{position:relative;width:160px;height:48px}'
      + `#editor{display:block;box-sizing:border-box;margin:0;width:160px;height:48px;padding:8px 32px;border:${border}px solid;background:white}`
      + '#art{position:absolute;left:0;top:0;width:160px;height:48px;'
      + (masked ? 'background:#202122;mask-image:url(/icon.svg);mask-size:160px 48px;mask-repeat:no-repeat;' : '') + '}</style>';
    const art = masked ? '<span id=art></span>' : '<img id=art src=/icon.svg alt="">';
    const body = `<div id=wrap><input id=editor value="${value}">${art}</div>`;
    const options = { images: [imageMetadata()], columns: 24, rows: 5 };
    const result = fixture(t, css + body, options);
    const baseline = fixture(t, css + '<style>#art{opacity:0}</style>' + body, options);
    const editor = result.document.elementById("editor");
    const beforeEditor = baseline.document.elementById("editor");
    const control = result.terminal.controls.find((entry) => entry.node === editor);
    assert.ok(control);
    const placements = result.terminal.cellBuffer.images.filter((image) => image.resourceId === imageId);
    assert.ok(placements.some((image) => cellContains(image.clip, control.allocation.row, 1)), "left padding admits artwork");
    assert.ok(placements.every((image) => image.safeForTransparency && image.compositingBackdrop.r === 255));
    for (const image of placements) {
      for (let row = image.clip.row; row < image.clip.row + image.clip.height; row += 1) {
        for (let column = image.clip.column; column < image.clip.column + image.clip.width; column += 1) {
          assert.equal(cellContains(control.visible, row, column), false, "all future caret/editor cells remain excluded");
        }
      }
    }
    assert.equal(result.terminal.hitTestIndex.at(control.allocation.row, control.allocation.column)?.action.node, editor);
    for (const column of [1, control.allocation.column, control.allocation.column + control.allocation.width - 1]) {
      const before = baseline.terminal.hitTestIndex.at(control.allocation.row, column)?.action;
      const after = result.terminal.hitTestIndex.at(control.allocation.row, column)?.action;
      assert.equal(after?.kind, before?.kind, "padding/editor hit semantics are unchanged");
      assert.equal(after?.node === editor, before?.node === beforeEditor);
    }
    assert.ok(result.terminal.focusMap.forNode(editor));
    assert.ok(result.displayList.commands.some((command) => command.kind === "background"
      && command.documentNode === editor && command.action?.node === editor), "background keeps original action identity");
    if (value !== "") assert.ok(result.terminal.cellBuffer.rows.some((row) => row.text.includes(value)), "native text stays intact");
  }
});

test("small masked icons inside CSS input padding are not blocked by background actions or thin border approximations", (t) => {
  const result = fixture(t, '<style>body{background:white}#wrap{position:absolute;left:34px;top:16px;width:369px;height:32px}'
    + '#editor{display:block;box-sizing:border-box;margin:0;padding:4px 8px 4px 32px;border:1px solid;width:369px;height:32px;background:white}'
    + '#icon{position:absolute;left:7px;top:7px;width:18px;height:18px;background:#202122;mask-image:url(/icon.svg);mask-size:18px;mask-repeat:no-repeat;mask-position:center}</style>'
    + '<div id=wrap><input id=editor value="Search"><span id=icon></span></div>', { images: [imageMetadata(true, 20, 20)] });
  const editor = result.terminal.controls[0];
  assert.equal(editor.allocation.column, 8);
  const placement = result.terminal.cellBuffer.images.find((image) => image.resourceId === imageId);
  assert.ok(placement);
  assert.deepEqual(placement.clip, { row: 1, column: 5, width: 3, height: 2 });
  assert.equal(placement.safeForTransparency, true);
  assert.equal(result.terminal.hitTestIndex.at(editor.allocation.row, editor.allocation.column)?.action.node, editor.node);
});

test("monochrome output does not mistake unpainted authored colors for a proven alpha backdrop", (t) => {
  const result = fixture(t, '<style>body{background:white}img{width:80px;height:32px}</style><img src=/icon.svg>',
    { images: [imageMetadata()], colorDepth: 0 });
  assert.ok(result.terminal.cellBuffer.images.length > 0);
  assert.ok(result.terminal.cellBuffer.images.every((image) => !image.safeForTransparency && image.compositingBackdrop === null));
});

test("transparent artwork requires a uniform known backdrop rather than first-cell sampling", (t) => {
  for (const under of ['', '<div style="position:absolute;left:40px;top:0;width:40px;height:32px;background:blue"></div>']) {
    const result = fixture(t, `<style>${under ? 'body{background:white}' : ''}img{position:absolute;left:0;top:0;width:80px;height:32px}</style>`
      + under + '<img src=/icon.svg>', { images: [imageMetadata()] });
    assert.ok(result.terminal.cellBuffer.images.length > 0);
    assert.ok(result.terminal.cellBuffer.images.every((image) => !image.safeForTransparency && image.compositingBackdrop === null));
  }
});

test("empty masked artwork uses the shared image identity, canonical tint and aspect-preserving contain geometry", (t) => {
  const result = fixture(t, '<style>body{background:white}#icon{display:block;width:32px;height:32px;background:#123456;'
    + 'mask-image:url(/icon.svg);mask-size:contain;mask-position:center;mask-repeat:no-repeat}</style><a id=icon href=/next aria-label=Icon></a>',
    { images: [imageMetadata()] });
  const source = result.document.elementById("icon");
  const command = result.displayList.commands.find((entry) => entry.kind === "image");
  assert.ok(command);
  assert.equal(command.resourceId, imageId);
  assert.equal(command.hasAlpha, true);
  assert.deepEqual(command.maskTint, { r: 18, g: 52, b: 86, a: 1 });
  assert.equal(command.rect.width, cssPx(32));
  assert.equal(command.rect.height, cssPx(16));
  assert.equal(command.rect.y, cssPx(8));
  assert.ok(!result.displayList.commands.some((entry) => entry.documentNode === source && entry.kind === "background"));
  assert.ok(result.terminal.cellBuffer.images.every((image) => image.action.node === source && image.safeForTransparency));
  assert.deepEqual(result.terminal.cellBuffer.images[0].sourceInset, { left: 0, top: .25, width: 1, height: .5 });
  assert.deepEqual(result.terminal.cellBuffer.images[0].rasterSize, { width: 32, height: 32 });
  assert.equal(result.documentDisplayList.artworkFallbacks.length, 0);
});

test("cover masks retain their full aspect geometry but clip artwork to the owning box", (t) => {
  const result = fixture(t, '<style>body{background:white}#icon{width:32px;height:32px;background:red;'
    + 'mask-image:url(/icon.svg);mask-size:cover;mask-position:center;mask-repeat:no-repeat}</style><div id=icon></div>',
    { images: [imageMetadata()] });
  const command = result.displayList.commands.find((entry) => entry.kind === "image");
  assert.equal(command.rect.x, cssPx(-16));
  assert.equal(command.rect.width, cssPx(64));
  assert.equal(command.rect.height, cssPx(32));
  assert.equal(command.clipRect.x, cssPx(0));
  assert.equal(command.clipRect.width, cssPx(32));
  assert.ok(result.terminal.cellBuffer.images.every((image) => image.clip.column >= 0 && image.clip.column + image.clip.width <= 4));
});

test("mask fallback suppresses unmasked rectangles and keeps original semantic text", (t) => {
  for (const [body, mask, reason] of [
    ['', 'mask-image:linear-gradient(red,blue)', 'unsupported-mask'],
    ['', 'mask-image:url(/icon.svg)', 'repeating-mask'],
    ['<a href=/next>Keep native text</a>', 'mask-image:url(/icon.svg);mask-repeat:no-repeat', 'native-content-mask'],
  ]) {
    const result = fixture(t, `<div id=masked style="width:80px;height:32px;background:red;${mask}">${body}</div>`,
      { images: [imageMetadata()] });
    const source = result.document.elementById("masked");
    assert.ok(!result.displayList.commands.some((command) => command.documentNode === source && command.kind === "background"));
    assert.equal(result.terminal.cellBuffer.images.length, 0);
    assert.ok(result.documentDisplayList.artworkFallbacks.some((entry) => entry.reason === reason));
    if (body) assert.ok(textRows(result).map((row) => row.text.trim()).join(" ").includes("Keep native text"));
  }
});

test("pending mask intrinsics remain distinguishable and bounded from final unsupported artwork", (t) => {
  const html = '<div style="width:32px;height:32px;background:red;mask-image:url(/icon.svg);mask-repeat:no-repeat"></div>';
  const pending = fixture(t, html, { images: [imageMetadata(null, null, null)] });
  assert.equal(pending.documentDisplayList.artworkFallbacks[0].reason, "mask-intrinsics-pending");
  const command = pending.displayList.commands.find((entry) => entry.kind === "image");
  assert.ok(command, "pending artwork retains a canonical spatial discovery command");
  assert.equal(command.resourceId, imageId);
  assert.equal(command.naturalWidth, null);
  assert.equal(command.naturalHeight, null);
  assert.equal(command.rect.width, cssPx(32));
  assert.equal(command.rect.height, cssPx(32));
  assert.ok(command.maskTint);
  const capped = fixture(t, html.repeat(10), { budgets: { maxRetainedImagePlacements: 0 } });
  assert.equal(capped.documentDisplayList.artworkFallbacks.length, 0);
  assert.equal(capped.documentDisplayList.artworkFallbacksOmitted, 10);
});

test("missing mask metadata remains spatially discoverable without scanning offscreen owners", (t) => {
  const result = fixture(t, '<style>.icon{position:absolute;left:0;width:32px;height:32px;background:red;mask-repeat:no-repeat}'
    + '#near{top:0;mask-image:url(/near.svg)}#far{top:1000px;mask-image:url(/far.svg)}</style><div id=near class=icon></div><div id=far class=icon></div>');
  const visible = result.displayList.commands.filter((command) => command.kind === "image");
  assert.deepEqual(visible.map((command) => command.resourceId), ["https://projection.test/near.svg"]);
  assert.equal(visible[0].naturalWidth, null);
  const scrolled = result.render({ scrollRow: 60 });
  assert.deepEqual(scrolled.displayList.commands.filter((command) => command.kind === "image").map((command) => command.resourceId),
    ["https://projection.test/far.svg"]);
});

test("narrow image fallback uses a compact media label without losing full alternative text or authored geometry", (t) => {
  const alt = "The package manager for a complete system";
  for (const [columns, marker] of [[1, "▧"], [2, "[]"], [3, "img"], [5, "[img]"], [7, "[image]"]]) {
    const result = fixture(t, `<a href=/next><img id=logo src=/icon.svg alt="${alt}" style="width:${columns * 8}px;height:16px"></a>`,
      { images: [imageMetadata()], searchQuery: "complete system" });
    const row = textRows(result)[0], span = row.spans[0];
    const node = result.document.elementById("logo");
    const fragment = result.documentLayout.forDocumentNode(node).find((entry) => entry.kind === "replaced");
    assert.equal(row.text.trim(), marker);
    assert.equal(fragment.contentRect.width, cssPx(columns * 8));
    assert.equal(fragment.contentRect.height, cssPx(16));
    assert.equal(span.logicalText, alt);
    assert.equal(span.contentStartCodeUnit, 0);
    assert.equal(span.contentEndCodeUnit, alt.length);
    assert.equal(result.displayList.commands.find((command) => command.kind === "image").text, alt);
    assert.equal(result.terminal.search.matches.length, 1);
    const range = result.terminal.search.ranges[0];
    assert.equal(row.text.slice(range.startCodeUnit, range.endCodeUnit), marker, "non-literal search highlights the complete representative marker");
    assert.ok(result.terminal.accessibilityBounds.some((entry) => entry.documentNode === node && entry.name === alt));
  }
});

test("compact media fallback retains wide/RTL logical text and ASCII capability", (t) => {
  for (const alt of ["界界", "مرحبا بالعالم"]) {
    const result = fixture(t, `<img src=/icon.svg alt="${alt}" style="width:8px;height:16px">`,
      { images: [imageMetadata()], unicode: false, searchQuery: alt });
    const row = textRows(result)[0];
    assert.equal(row.text.trim(), "*");
    assert.equal(row.spans[0].logicalText, alt);
    assert.equal(result.terminal.search.matches.length, 1);
  }
  const decorative = fixture(t, '<img src=/icon.svg alt="" style="width:8px;height:16px">', { images: [imageMetadata()] });
  assert.equal(textRows(decorative).length, 0, "decorative media does not acquire an invented label");
});

test("labelled mask links retain visible fallback and full semantic actions with ready, pending or unsupported artwork", (t) => {
  for (const [mask, images] of [
    ['url(/icon.svg)', [imageMetadata()]], ['url(/icon.svg)', []], ['linear-gradient(red,blue)', []],
  ]) {
    const result = fixture(t, `<a id=icon href=/search aria-label="Search this site" style="display:block;width:16px;height:16px;background:red;`
      + `mask-image:${mask};mask-size:contain;mask-repeat:no-repeat"></a>`, { images });
    const source = result.document.elementById("icon"), row = textRows(result)[0];
    assert.equal(row.text.trim(), "↗");
    assert.equal(row.spans[0].logicalText, "Search this site");
    assert.equal(result.terminal.hitTestIndex.at(row.row, row.cells[0].column)?.action.node, source);
    assert.equal(result.terminal.focusMap.forNode(source).label, "Search this site");
    assert.ok(result.terminal.accessibilityBounds.some((entry) => entry.documentNode === source && entry.name === "Search this site"));
  }
});

test("native icon-only mask controls retain their accessible label and input identity", (t) => {
  const result = fixture(t, '<button id=menu type=button aria-label="Open menu" style="width:32px;height:16px;background:red;'
    + 'mask-image:url(/icon.svg);mask-repeat:no-repeat"></button>', { images: [imageMetadata()] });
  const source = result.document.elementById("menu");
  assert.ok(result.terminal.controls.some((control) => control.node === source && !control.paintSuppressed));
  assert.equal(result.terminal.focusMap.forNode(source).label, "Open menu");
  assert.ok(result.terminal.accessibilityBounds.some((entry) => entry.documentNode === source && entry.name === "Open menu"));
});

test("nested calculation mask sizes resolve using canonical fixed-point font metrics and retain image aspect", (t) => {
  for (const [size, expected] of [
    ['calc(max(calc(var(--icon-size,1rem) + 4px),10px))', 20],
    ['max(calc(0.875rem + 4px),10px)', 18],
    ['calc(max(calc(0.875rem - 4px),10px))', 10],
    ['calc(max(calc(1rem - 4px),10px))', 12],
    ['max(calc(1em - 4px),10px)', 20],
  ]) {
    const result = fixture(t, `<div id=icon style="width:32px;height:32px;font-size:24px;background:red;mask-image:url(/icon.svg);`
      + `mask-size:${size};mask-position:center;mask-repeat:no-repeat"></div>`, { images: [imageMetadata()] });
    const command = result.displayList.commands.find((entry) => entry.kind === "image");
    assert.ok(command, size);
    assert.equal(command.resourceId, imageId);
    assert.equal(command.rect.width, cssPx(expected), size);
    assert.equal(command.rect.height, cssPx(expected / 2), "auto height retains the source aspect ratio");
    assert.equal(command.rect.x, cssPx((32 - expected) / 2));
    assert.equal(command.rect.y, cssPx((32 - expected / 2) / 2));
    assert.equal(result.documentDisplayList.artworkFallbacks.length, 0);
  }
});

test("mask calculations share percentage/min/max/clamp arithmetic and nonnegative used-size bounds", (t) => {
  const result = fixture(t, '<div style="width:32px;height:32px;background:red;mask-image:url(/icon.svg);'
    + 'mask-size:calc(50% + 2px) clamp(4px,calc(25% + 1px),16px);mask-position:center;mask-repeat:no-repeat"></div>',
    { images: [imageMetadata()] });
  const command = result.displayList.commands.find((entry) => entry.kind === "image");
  assert.equal(command.rect.width, cssPx(18));
  assert.equal(command.rect.height, cssPx(9));
  assert.equal(command.rect.x, cssPx(7));
  assert.equal(command.rect.y, cssPx(11.5));
  const zero = fixture(t, '<div style="width:32px;height:32px;background:red;mask-image:url(/icon.svg);'
    + 'mask-size:calc(1px - 2px);mask-repeat:no-repeat"></div>', { images: [imageMetadata()] });
  const zeroCommand = [...zero.documentDisplayList.commands].find((entry) => entry.kind === "image");
  assert.equal(zeroCommand.rect.width, cssPx(0));
  assert.equal(zeroCommand.rect.height, cssPx(0));
  assert.equal(zero.terminal.cellBuffer.images.length, 0);
});

test("empty color-only masks do not invent visible source ink", (t) => {
  for (const background of ["", "background:transparent;", "background:rgba(255,0,0,0);"]) {
    const result = fixture(t, `<div id=empty style="width:32px;height:32px;color:red;${background}`
      + 'mask-image:url(/icon.svg);mask-size:contain;mask-repeat:no-repeat"></div><p>After</p>', { images: [imageMetadata()] });
    const source = result.document.elementById("empty");
    assert.equal(result.displayList.commands.some((command) => command.documentNode === source), false);
    assert.equal(result.terminal.cellBuffer.images.length, 0);
    assert.ok(result.documentDisplayList.artworkFallbacks.some((entry) => entry.reason === "missing-mask-tint"));
    assert.ok(textRows(result).some((row) => row.text.includes("After")));
  }
});

test("mask artwork admits computed currentColor backgrounds but rejects unmodelled visible border paint", (t) => {
  const css = 'width:32px;height:32px;color:#123456;mask-image:url(/icon.svg);mask-size:contain;mask-repeat:no-repeat;';
  for (const background of ["", "background:red;"]) {
    const result = fixture(t, `<div id=icon style="${css}${background}border:2px solid blue"></div>`, { images: [imageMetadata()] });
    const source = result.document.elementById("icon");
    assert.equal(result.displayList.commands.some((command) => command.documentNode === source), false, "unsupported border/background sources never leak unmasked chrome");
    assert.ok(result.documentDisplayList.artworkFallbacks.some((entry) => entry.reason === "unsupported-mask-paint"));
  }
  const supported = fixture(t, `<div style="${css}background:currentColor;border:2px solid transparent"></div>`, { images: [imageMetadata()] });
  const command = supported.displayList.commands.find((entry) => entry.kind === "image");
  assert.deepEqual(command.maskTint, { r: 18, g: 52, b: 86, a: 1 });
  assert.equal(supported.documentDisplayList.artworkFallbacks.length, 0);
});
