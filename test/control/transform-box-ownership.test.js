import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import {
  buildLayoutFragmentTree,
  cssCoordinate,
  cssLengthFromFixed,
  cssPixels,
  cssPx,
  cssRect
} from "../../dist/presentation/layout/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import {
  buildDisplayListSpatialIndex,
  buildDocumentDisplayList,
  buildDocumentGeometryIndex,
  buildViewportDisplayList,
  buildViewportTerminalResult,
  rasterizeViewportDisplayList
} from "../../dist/presentation/terminal/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);

function viewport(result, scrollRow = 0) {
  const displayList = buildViewportDisplayList({
    documentDisplayList: result.displayList,
    spatialIndex: buildDisplayListSpatialIndex(result.displayList),
    context: result.displayList.context,
    window: {
      scrollRow,
      viewportRows: result.displayList.context.rows,
      overscanBefore: 0,
      overscanAfter: 0
    }
  });
  const cells = rasterizeViewportDisplayList({ displayList });
  const terminal = buildViewportTerminalResult({
    displayList,
    cellBuffer: cells.cellBuffer,
    documentGeometry: result.documentGeometry,
    truncations: cells.truncations
  });
  return { displayList, terminal };
}

function render(html, columns = 80, rows = 24, options = {}) {
  const document = parseWebDocument(`<style>html,body,p{margin:0}</style>${html}`, {
    requestUrl: "https://translation.example/",
    finalUrl: "https://translation.example/"
  });
  const state = createDocumentState(document);
  const styles = resolveStyles({
    program: compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) }),
    state,
    environment: {
      viewportWidthCssPx: columns * 8,
      viewportHeightCssPx: rows * 16,
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: false,
      hover: "hover",
      pointer: "fine"
    }
  });
  const formatting = buildFormattingTree({ document, state, styles });
  const viewportWidth = cssLengthFromFixed(columns * CELL_WIDTH);
  const viewportHeight = cssLengthFromFixed(rows * ROW_HEIGHT);
  const viewportRect = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), viewportWidth, viewportHeight);
  const layout = buildLayoutFragmentTree({
    formatting,
    inlineItemStreams: buildInlineItemStreamSet(formatting),
    context: {
      viewport: { width: viewportWidth, height: viewportHeight },
      initialContainingBlock: viewportRect,
      scrollport: viewportRect,
      textMeasurer: terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets })
    },
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  assert.ok(layout.outcome.status === "complete" || (options.budgets !== undefined && layout.outcome.status === "truncated"),
    JSON.stringify(layout.outcome));
  const displayList = buildDocumentDisplayList({
    layout,
    context: {
      columns,
      rows,
      cellWidthCssPx: CELL_WIDTH,
      rowHeightCssPx: ROW_HEIGHT,
      unicode: true,
      ambiguousWidth: 1,
      colorDepth: 24,
      cellMeasurer: terminalCellMeasurer()
    }
  });
  const result = { document, styles, formatting, layout, displayList, documentGeometry: buildDocumentGeometryIndex(displayList) };
  return { ...result, terminal: viewport(result).terminal };
}

function node(result, id) {
  const value = result.document.elementById(id);
  assert.ok(value, `missing #${id}`);
  return value;
}

function fragment(result, id) {
  const value = result.layout.forDocumentNode(node(result, id))
    .find((candidate) => candidate.kind !== "text" && candidate.borderRect.width > 0);
  assert.ok(value, `missing principal fragment for #${id}`);
  return value;
}

function rectangle(rect) {
  return {
    x: cssPixels(rect.x),
    y: cssPixels(rect.y),
    width: cssPixels(rect.width),
    height: cssPixels(rect.height)
  };
}

function assertTranslation(before, after, x, y) {
  for (const name of ["contentRect", "paddingRect", "borderRect", "marginRect"]) {
    assert.deepEqual(rectangle(after[name]), {
      ...rectangle(before[name]),
      x: cssPixels(before[name].x) + x,
      y: cssPixels(before[name].y) + y
    }, name);
  }
}

function text(result) {
  return result.terminal.cellBuffer.rows.map((row) => row.text).join("\n");
}

function formattingFragment(result, id, kind) {
  const value = result.layout.forDocumentNode(node(result, id))
    .find((candidate) => result.formatting.node(candidate.formattingNode).kind === kind);
  assert.ok(value, `missing ${kind} for #${id}`);
  return value;
}

for (const display of ["table", "inline-table"]) {
  for (const captionSide of ["top", "bottom"]) {
    test(`${display} translates its ${captionSide} caption and grid together`, () => {
      const source = (transform) => `<table id="table" style="display:${display};border-spacing:0;transform:${transform}">
        <caption id="caption" style="caption-side:${captionSide}">Caption</caption>
        <tr><td id="cell">Cell</td></tr></table><span id="after">After</span>`;
      const baseline = render(source("none"));
      const shifted = render(source("translate(32px,32px)"));
      for (const id of ["caption", "cell"]) assertTranslation(fragment(baseline, id), fragment(shifted, id), 32, 32);
      for (const kind of ["table-wrapper", "table"]) {
        assertTranslation(formattingFragment(baseline, "table", kind), formattingFragment(shifted, "table", kind), 32, 32);
      }
      assert.deepEqual(fragment(shifted, "after").borderRect, fragment(baseline, "after").borderRect);
      const wrapper = formattingFragment(shifted, "table", "table-wrapper");
      const grid = formattingFragment(shifted, "table", "table");
      assert.equal(shifted.layout.stacking(wrapper.id).establishesStackingContext, true);
      assert.equal(shifted.layout.stacking(grid.id).establishesStackingContext, false);
      assert.equal(shifted.layout.stacking(fragment(shifted, "caption").id).containingStackingContext, wrapper.id);
    });
  }
}

for (const margin of ["0", "8px 16px"]) {
  test(`table percentage transforms use wrapper border dimensions with ${margin} margins`, () => {
    const source = (transform) => `<div style="display:flow-root"><table id="table" style="width:80px;height:32px;border:4px solid;
      border-spacing:0;margin:${margin};transform:${transform}">
      <caption id="caption" style="height:16px">Caption</caption><tr><td id="cell">Cell</td></tr></table></div>`;
    const baseline = render(source("none"));
    const shifted = render(source("translate(calc(50% + 8px),100%)"));
    const wrapper = formattingFragment(baseline, "table", "table-wrapper");
    const grid = formattingFragment(baseline, "table", "table");
    const caption = fragment(baseline, "caption");
    assert.equal(wrapper.borderRect.width, grid.borderRect.width);
    assert.ok(wrapper.borderRect.width < cssPx(640), "available block width is not the transform reference");
    assert.equal(wrapper.borderRect.height, grid.borderRect.height + caption.marginRect.height);
    assert.equal(wrapper.borderRect.y, cssPx(margin === "0" ? 0 : 8));
    assert.equal(wrapper.marginRect.height, wrapper.borderRect.height + cssPx(margin === "0" ? 0 : 16));
    const x = cssPixels(wrapper.borderRect.width) / 2 + 8;
    const y = cssPixels(wrapper.borderRect.height);
    for (const id of ["caption", "cell"]) assertTranslation(fragment(baseline, id), fragment(shifted, id), x, y);
  });
}

test("table wrapper translation composes once with translated captions and cells", () => {
  const source = (table, caption, cell) => `<table id="table" style="width:80px;border-spacing:0;transform:${table}">
    <caption id="caption" style="transform:${caption}">Caption</caption>
    <tr><td id="cell" style="transform:${cell}">Cell</td></tr></table>`;
  const baseline = render(source("none", "none", "none"));
  const shifted = render(source("translate(16px,32px)", "translate(8px,16px)", "translate(24px,8px)"));
  assertTranslation(fragment(baseline, "caption"), fragment(shifted, "caption"), 24, 48);
  assertTranslation(fragment(baseline, "cell"), fragment(shifted, "cell"), 40, 40);
  assertTranslation(formattingFragment(baseline, "table", "table"), formattingFragment(shifted, "table", "table"), 16, 32);
});

test("transformed tables establish a wrapper containing block for caption and grid descendants", () => {
  const source = (transform) => `<div style="height:32px"></div><table id="table" style="width:80px;height:48px;
    border:4px solid;border-spacing:0;transform:${transform}">
    <caption>Caption<a id="caption-fixed" href="/caption" style="position:fixed;left:0;top:0;width:8px;height:16px">C</a></caption>
    <tr><td><a id="cell-absolute" href="/absolute" style="position:absolute;left:0;top:0;width:8px;height:16px">A</a>
      <a id="cell-fixed" href="/fixed" style="position:fixed;right:0;bottom:0;width:8px;height:16px">F</a></td></tr></table>`;
  const baseline = render(source("translate(0)"));
  const shifted = render(source("translate(16px,32px)"));
  const owner = formattingFragment(shifted, "table", "table-wrapper");
  for (const id of ["caption-fixed", "cell-absolute", "cell-fixed"]) {
    const descendant = fragment(shifted, id);
    assertTranslation(fragment(baseline, id), descendant, 16, 32);
    assert.equal(shifted.layout.scrollAttachment(descendant.id), null);
    if (id !== "cell-absolute") assert.equal(shifted.layout.scrollAttachmentParent(descendant.id)?.id, owner.id);
  }
  for (const id of ["caption-fixed", "cell-absolute"]) {
    assert.equal(fragment(shifted, id).borderRect.x, owner.paddingRect.x);
    assert.equal(fragment(shifted, id).borderRect.y, owner.paddingRect.y);
  }
  const fixed = fragment(shifted, "cell-fixed");
  assert.equal(fixed.borderRect.x + fixed.borderRect.width, owner.paddingRect.x + owner.paddingRect.width);
  assert.equal(fixed.borderRect.y + fixed.borderRect.height, owner.paddingRect.y + owner.paddingRect.height);
});

test("anonymous table fixup wrappers do not inherit an ancestor's transform", () => {
  const source = (transform) => `<div id="owner" style="transform:${transform}">
    <span id="cell" style="display:table-cell">Cell</span></div>`;
  const baseline = render(source("none"));
  const shifted = render(source("translate(16px,32px)"));
  assertTranslation(fragment(baseline, "cell"), fragment(shifted, "cell"), 16, 32);
});

test("translated table captions and cells remain inside an unchanged ancestor clip", () => {
  const result = render(`<div id="clip" style="width:48px;height:48px;overflow:hidden">
    <table style="width:64px;border-spacing:0;transform:translate(32px,16px)">
      <caption><a id="caption-link" href="/caption" style="display:block;text-align:left">Caption</a></caption>
      <tr><td style="padding:0"><a id="cell-link" href="/cell">Cell</a></td></tr></table></div>`);
  const clip = fragment(result, "clip");
  for (const id of ["caption-link", "cell-link"]) {
    const value = fragment(result, id);
    assert.equal(value.clipRect.x, clip.paddingRect.x);
    assert.equal(value.clipRect.y, clip.paddingRect.y);
    assert.equal(value.clipRect.width, clip.paddingRect.width);
    assert.equal(value.clipRect.height, clip.paddingRect.height);
    const bounds = result.terminal.accessibilityBounds.find((entry) => entry.documentNode === node(result, id));
    assert.equal(bounds?.rect.column, 4);
    assert.equal(bounds?.rect.width, 2);
  }
  assert.ok(!text(result).includes("Caption"));
  assert.ok(!text(result).includes("Cell"));
});

test("an atomic child's transform does not move its inline ancestor decoration or flow geometry", () => {
  const source = (transform) => `<span id="parent" style="background:red;border:1px solid"><span id="child"
    style="display:inline-block;width:40px;height:16px;transform:${transform}">Child</span></span><span id="after">After</span>`;
  const baseline = render(source("none"));
  const shifted = render(source("translate(64px,32px)"));
  const parent = fragment(shifted, "parent");
  assert.deepEqual(rectangle(parent.borderRect), { x: -1, y: -1, width: 42, height: 18 });
  for (const name of ["contentRect", "paddingRect", "borderRect", "marginRect", "inlineContinuations"]) {
    assert.deepEqual(parent[name], fragment(baseline, "parent")[name], name);
  }
  assertTranslation(fragment(baseline, "child"), fragment(shifted, "child"), 64, 32);
  assert.deepEqual(fragment(shifted, "after").borderRect, fragment(baseline, "after").borderRect);
  assert.deepEqual(shifted.layout.lineBoxes[shifted.layout.lineBoxes.length - 1].rect,
    baseline.layout.lineBoxes[baseline.layout.lineBoxes.length - 1].rect);
  assert.ok(parent.overflowRect.x + parent.overflowRect.width >= fragment(shifted, "child").borderRect.x + cssPx(40));
  const backgrounds = (result) => result.displayList.commands.filter((command) => command.kind === "background"
    && command.documentNode === node(result, "parent"));
  assert.ok(backgrounds(shifted).length > 0, "the inline ancestor's own background is painted");
  assert.deepEqual(backgrounds(shifted).map((command) => command.rect), backgrounds(baseline).map((command) => command.rect));
});

test("nested atomic transforms preserve ordinary inline ancestor boxes at each level", () => {
  const source = (outer, inner) => `<span id="parent" style="background:red"><span id="outer"
    style="display:inline-block;width:80px;height:32px;transform:${outer}"><span id="middle" style="background:blue;border:1px solid"><span id="inner"
    style="display:inline-block;width:40px;height:16px;transform:${inner}">Child</span></span></span></span>`;
  const baseline = render(source("none", "none"));
  const shifted = render(source("translate(32px,16px)", "translate(16px,32px)"));
  assert.deepEqual(fragment(shifted, "parent").borderRect, fragment(baseline, "parent").borderRect);
  assertTranslation(fragment(baseline, "outer"), fragment(shifted, "outer"), 32, 16);
  assertTranslation(fragment(baseline, "middle"), fragment(shifted, "middle"), 32, 16);
  assertTranslation(fragment(baseline, "inner"), fragment(shifted, "inner"), 48, 48);
  assert.deepEqual(fragment(shifted, "middle").inlineContinuations.map((entry) => rectangle(entry.borderRect)),
    fragment(baseline, "middle").inlineContinuations.map((entry) => ({ ...rectangle(entry.borderRect),
      x: cssPixels(entry.borderRect.x) + 32, y: cssPixels(entry.borderRect.y) + 16 })));
});

test("relative inline descendants leave their ancestor decoration in normal flow", () => {
  const source = (left) => `<span id="parent" style="background:red;border:1px solid"><span id="child"
    style="position:relative;left:${left}px;top:16px">Child</span></span>`;
  const baseline = render(source(0));
  const shifted = render(source(32));
  assert.deepEqual(fragment(shifted, "parent").borderRect, fragment(baseline, "parent").borderRect);
  assertTranslation(fragment(baseline, "child"), fragment(shifted, "child"), 32, 0);
});

test("transformed inline children preserve ancestor clipping and original background bounds", () => {
  const source = (transform) => `<div id="clip" style="width:64px;height:32px;overflow:hidden"><span id="parent" style="background:red">
    <a id="child" href="/child" style="display:inline-block;width:40px;height:16px;transform:${transform}">Child</a></span></div>`;
  const baseline = render(source("none"));
  const shifted = render(source("translate(48px,16px)"));
  assert.deepEqual(fragment(shifted, "parent").borderRect, fragment(baseline, "parent").borderRect);
  assert.deepEqual(fragment(shifted, "clip").paddingRect, fragment(baseline, "clip").paddingRect);
  assert.equal(shifted.terminal.hitTestIndex.at(1, 6)?.action.node, node(shifted, "child"));
  assert.equal(shifted.terminal.hitTestIndex.at(1, 7)?.action.node, node(shifted, "child"));
  assert.equal(shifted.terminal.hitTestIndex.at(1, 8), null);
  assert.deepEqual(shifted.terminal.accessibilityBounds.find((entry) => entry.documentNode === node(shifted, "child"))?.rect,
    { row: 1, column: 6, width: 2, height: 1 });
});

test("table margins surround both captions while caption margins remain inside the transform reference", () => {
  const source = (transform) => `<div style="display:flow-root"><table id="table" style="width:80px;border:4px solid;border-spacing:0;
    margin:8px 16px;transform:${transform}"><caption id="top" style="height:16px;margin:4px 0">Top</caption>
    <caption id="bottom" style="caption-side:bottom;height:16px;margin:4px 0">Bottom</caption>
    <tr><td id="cell">Cell</td></tr></table><div id="after">After</div></div>`;
  const baseline = render(source("none"));
  const shifted = render(source("translate(0,100%)"));
  const wrapper = formattingFragment(baseline, "table", "table-wrapper");
  const grid = formattingFragment(baseline, "table", "table");
  const top = fragment(baseline, "top");
  const bottom = fragment(baseline, "bottom");
  assert.equal(wrapper.borderRect.y, cssPx(8));
  assert.equal(top.marginRect.y, wrapper.borderRect.y);
  assert.equal(grid.borderRect.y, top.marginRect.y + top.marginRect.height);
  assert.equal(bottom.marginRect.y, grid.borderRect.y + grid.borderRect.height);
  assert.equal(wrapper.borderRect.height, top.marginRect.height + grid.borderRect.height + bottom.marginRect.height);
  assert.equal(wrapper.marginRect.height, wrapper.borderRect.height + cssPx(16));
  assert.equal(fragment(baseline, "after").borderRect.y, wrapper.marginRect.y + wrapper.marginRect.height);
  for (const id of ["top", "bottom", "cell"]) {
    assertTranslation(fragment(baseline, id), fragment(shifted, id), 0, cssPixels(wrapper.borderRect.height));
  }
  assert.deepEqual(fragment(baseline, "after").borderRect, fragment(shifted, "after").borderRect);
});

for (const clip of ["overflow:hidden", "clip-path:inset(0px)"]) {
  test(`table wrapper ${clip} clips transformed caption and grid fixed descendants`, () => {
    const result = render(`<table id="table" style="width:80px;border-spacing:0;transform:translate(16px,16px);${clip}">
      <caption id="caption">Caption<a id="caption-fixed" href="/caption" style="position:fixed;left:104px;top:0;width:40px;height:16px">outside</a></caption>
      <tr><td style="padding:0"><a id="cell-fixed" href="/cell" style="position:fixed;left:104px;top:16px;width:40px;height:16px">outside</a>Cell</td></tr></table>`);
    const owner = formattingFragment(result, "table", "table-wrapper");
    for (const id of ["caption-fixed", "cell-fixed"]) {
      const fixed = fragment(result, id);
      assert.deepEqual(fixed.clipRect, owner.paddingRect);
      assert.equal(result.terminal.hitTestIndex.regions.some((entry) => entry.action.node === node(result, id)), false);
      assert.equal(result.terminal.focusMap.forNode(node(result, id)), null);
    }
    assert.ok(text(result).includes("Caption"), "the caption remains inside its own wrapper clip");
    assert.ok(!text(result).includes("outside"));
  });
}

test("fixed-layout table wrapper percentages use grid width when a negative-margin caption overflows", () => {
  const source = (transform) => `<table id="table" style="table-layout:fixed;width:80px;border-spacing:0;transform:${transform}">
    <caption id="caption" style="width:160px;margin-left:-160px">Overflowing caption</caption>
    <tr><td id="cell">Cell</td></tr></table>`;
  const baseline = render(source("none"));
  const shifted = render(source("translateX(100%)"));
  const grid = formattingFragment(baseline, "table", "table");
  const wrapper = formattingFragment(baseline, "table", "table-wrapper");
  const caption = fragment(baseline, "caption");
  assert.equal(wrapper.borderRect.width, cssPx(80));
  assert.equal(wrapper.borderRect.width, grid.borderRect.width);
  assert.equal(wrapper.borderRect.x, grid.borderRect.x);
  assert.ok(caption.borderRect.width > wrapper.borderRect.width);
  assert.ok(caption.borderRect.x < wrapper.borderRect.x);
  for (const id of ["caption", "cell"]) assertTranslation(fragment(baseline, id), fragment(shifted, id), 80, 0);
});

for (const transform of ["none", "translate(0)"]) {
  test(`table wrapper owns positioned stacking with ${transform}`, () => {
    const result = render(`<table id="table" style="position:relative;z-index:99;transform:${transform};border-spacing:0;width:80px;height:16px">
      <tr><td style="padding:0;background:red">TABLE</td></tr></table>
      <div style="position:absolute;left:0;top:0;width:80px;height:16px;z-index:1;background:blue">OTHER</div>`);
    const wrapper = formattingFragment(result, "table", "table-wrapper");
    const grid = formattingFragment(result, "table", "table");
    assert.equal(result.layout.stacking(wrapper.id).stackLevel, 99);
    assert.equal(result.layout.stacking(grid.id).establishesStackingContext, false);
    assert.ok(text(result).includes("TABLE"));
    assert.ok(!text(result).includes("OTHER"));
  });
}

for (const captionSide of ["top", "bottom"]) {
  test(`relative offsets and transforms move the table wrapper and ${captionSide} caption once`, () => {
    const source = (left, top, transform) => `<div style="display:flow-root"><table id="table" style="position:relative;
      left:${left}px;top:${top}px;transform:${transform};width:80px;border:4px solid;background:red;border-spacing:0;margin:8px 16px">
      <caption id="caption" style="caption-side:${captionSide}">Caption</caption><tr><td id="cell">Cell</td></tr></table>
      <div id="after">After</div></div>`;
    const baseline = render(source(0, 0, "none"));
    const shifted = render(source(16, 32, "translate(8px,16px)"));
    for (const id of ["caption", "cell"]) assertTranslation(fragment(baseline, id), fragment(shifted, id), 24, 48);
    for (const kind of ["table", "table-wrapper"]) {
      assertTranslation(formattingFragment(baseline, "table", kind), formattingFragment(shifted, "table", kind), 24, 48);
    }
    assert.deepEqual(fragment(shifted, "after").borderRect, fragment(baseline, "after").borderRect);
    const paints = shifted.displayList.commands.filter((command) => command.kind === "background" && command.documentNode === node(shifted, "table"));
    assert.equal(paints.length, 1, "only the grid paints the table background");
    assert.deepEqual(paints[0].rect, formattingFragment(shifted, "table", "table").borderRect);
  });
}

test("positioned table containing blocks include captions without needing a transform", () => {
  const result = render(`<div style="display:flow-root"><table id="table" style="position:relative;left:16px;top:32px;
    width:80px;height:48px;border:4px solid;border-spacing:0;margin:8px 16px"><caption>Caption
      <a id="caption-absolute" href="/caption" style="position:absolute;left:0;top:0;width:8px;height:16px">C</a></caption>
      <tr><td><a id="cell-absolute" href="/cell" style="position:absolute;right:0;bottom:0;width:8px;height:16px">A</a></td></tr></table></div>`);
  const owner = formattingFragment(result, "table", "table-wrapper");
  const caption = fragment(result, "caption-absolute");
  const cell = fragment(result, "cell-absolute");
  assert.equal(caption.borderRect.x, owner.paddingRect.x);
  assert.equal(caption.borderRect.y, owner.paddingRect.y);
  assert.equal(cell.borderRect.x + cell.borderRect.width, owner.paddingRect.x + owner.paddingRect.width);
  assert.equal(cell.borderRect.y + cell.borderRect.height, owner.paddingRect.y + owner.paddingRect.height);
});

for (const position of ["absolute", "fixed"]) {
  test(`${position} table offsets use final wrapper size and margins including an oversized caption`, () => {
    const result = render(`<table id="table" style="position:${position};right:16px;bottom:32px;width:80px;
      border-spacing:0;border:4px solid;margin:8px 16px"><caption id="caption" style="width:160px">Caption</caption>
      <tr><td id="cell">Cell</td></tr></table><div id="after">After</div>`);
    const owner = formattingFragment(result, "table", "table-wrapper");
    const grid = formattingFragment(result, "table", "table");
    assert.equal(owner.marginRect.x + owner.marginRect.width, cssPx(640 - 16));
    assert.equal(owner.marginRect.y + owner.marginRect.height, cssPx(384 - 32));
    assert.equal(owner.borderRect.width, grid.borderRect.width);
    assert.ok(owner.borderRect.width >= cssPx(160));
    assert.equal(fragment(result, "caption").borderRect.y, owner.borderRect.y);
    assert.equal(fragment(result, "after").borderRect.y, 0);
    assert.equal(result.layout.scrollAttachment(owner.id)?.kind ?? null, position === "fixed" ? "fixed" : null);
    assert.equal(result.layout.scrollAttachment(grid.id), null);
    if (position === "fixed") assert.equal(result.layout.scrollAttachmentParent(owner.id), null);
  });
}

for (const float of ["left", "right"]) {
  test(`${float} floats use the table wrapper margin box and contain captions once`, () => {
    const result = render(`<div style="display:flow-root;width:320px"><table id="table" style="float:${float};width:80px;
      border-spacing:0;border:4px solid;margin:8px 16px"><caption id="caption" style="width:160px">Caption</caption>
      <tr><td>Cell</td></tr></table><div id="after" style="clear:both">After</div></div>`);
    const owner = formattingFragment(result, "table", "table-wrapper");
    const grid = formattingFragment(result, "table", "table");
    assert.equal(result.layout.stacking(owner.id).paintPhase, "float");
    assert.equal(result.layout.stacking(grid.id).paintPhase, "in-flow-block");
    if (float === "left") assert.equal(owner.marginRect.x, 0);
    else assert.equal(owner.marginRect.x + owner.marginRect.width, cssPx(320));
    assert.equal(owner.marginRect.width, owner.borderRect.width + cssPx(32));
    assert.equal(fragment(result, "after").borderRect.y, owner.marginRect.y + owner.marginRect.height);
    assert.equal(fragment(result, "caption").borderRect.y, owner.borderRect.y);
  });
}

test("legacy clipping on an absolutely positioned translated table includes its caption", () => {
  const result = render(`<table id="table" style="position:absolute;left:0;top:0;transform:translate(16px,16px);
    clip:rect(0px,40px,16px,0px);border-spacing:0;width:80px"><caption><a id="caption" href="/caption">Caption</a></caption>
    <tr><td style="padding:0"><a id="cell" href="/cell">Cell</a></td></tr></table>`);
  const owner = formattingFragment(result, "table", "table-wrapper");
  assert.deepEqual(rectangle(owner.clipRect), { x: 16, y: 16, width: 40, height: 16 });
  assert.deepEqual(fragment(result, "caption").clipRect, owner.clipRect);
  assert.equal(result.terminal.hitTestIndex.regions.some((entry) => entry.action.node === node(result, "caption")), true);
  assert.equal(result.terminal.hitTestIndex.regions.some((entry) => entry.action.node === node(result, "cell")), false);
});

for (const position of ["sticky", "fixed"]) {
  test(`${position} table scrolling keeps caption and grid attached to one wrapper`, () => {
    const result = render(`<div style="height:320px"><div style="height:64px"></div>
      <table id="table" style="position:${position};top:0;left:0;border-spacing:0;width:80px">
        <caption><a id="caption" href="/caption">Caption</a></caption>
        <tr><td style="padding:0"><a id="cell" href="/cell">Cell</a></td></tr></table></div>`, 40, 6);
    const wrapper = formattingFragment(result, "table", "table-wrapper");
    const grid = formattingFragment(result, "table", "table");
    assert.equal(result.layout.scrollAttachment(wrapper.id)?.kind, position);
    assert.equal(result.layout.scrollAttachment(grid.id), null);
    for (const scrollRow of [0, 5]) {
      const scrolled = viewport(result, scrollRow);
      const topRow = position === "fixed" ? scrollRow : Math.max(4, scrollRow);
      assert.equal(scrolled.terminal.hitTestIndex.at(topRow, 0)?.action.node, node(result, "caption"));
      assert.equal(scrolled.terminal.hitTestIndex.at(topRow + 1, 0)?.action.node, node(result, "cell"));
      const caption = scrolled.displayList.commands.find((command) => command.kind === "text" && command.text === "Caption");
      const cell = scrolled.displayList.commands.find((command) => command.kind === "text" && command.text === "Cell");
      assert.ok(caption && cell);
      assert.equal(caption.rect.y, cssPx(topRow * 16));
      assert.equal(cell.rect.y, cssPx((topRow + 1) * 16));
    }
  });
}
