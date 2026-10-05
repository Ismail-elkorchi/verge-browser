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
import { terminalCellMeasurer, terminalCssControlMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";
import { paintedSourceUnits } from "../../scripts/compat/paint-coverage.mjs";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);

function render(html, columns = 80, rows = 40, images = []) {
  const document = parseWebDocument(`<style>html,body,p{margin:0}</style>${html}`, {
    requestUrl: "https://percentage-ownership.example/",
    finalUrl: "https://percentage-ownership.example/"
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
  const formatting = buildFormattingTree({ document, state, styles, images });
  const width = cssLengthFromFixed(columns * CELL_WIDTH);
  const height = cssLengthFromFixed(rows * ROW_HEIGHT);
  const viewport = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), width, height);
  const layout = buildLayoutFragmentTree({
    formatting,
    inlineItemStreams: buildInlineItemStreamSet(formatting),
    context: {
      viewport: { width, height },
      initialContainingBlock: viewport,
      scrollport: viewport,
      controlMeasurer: terminalCssControlMeasurer(),
      textMeasurer: terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT)
    }
  });
  assert.equal(layout.outcome.status, "complete", JSON.stringify(layout.outcome));
  return { document, layout, columns, rows };
}

function node(result, id) {
  const value = result.document.elementById(id);
  assert.ok(value, `missing #${id}`);
  return value;
}

function fragment(result, id, kind) {
  const value = result.layout.forDocumentNode(node(result, id)).find((candidate) =>
    candidate.kind !== "text" && (kind === undefined || result.layout.formatting.node(candidate.formattingNode).kind === kind));
  assert.ok(value, `missing ${kind ?? "principal"} fragment for #${id}`);
  return value;
}

function offset(result, child, parent, axis = "y") {
  return cssPixels(fragment(result, child).borderRect[axis] - fragment(result, parent).contentRect[axis]);
}

function contentHeight(result, id, kind) {
  return cssPixels(fragment(result, id, kind).contentRect.height);
}

function displayList(result) {
  return buildDocumentDisplayList({
    styles: result.layout.formatting.styles,
    layout: result.layout,
    context: {
      columns: result.columns,
      rows: result.rows,
      cellWidthCssPx: CELL_WIDTH,
      rowHeightCssPx: ROW_HEIGHT,
      unicode: true,
      ambiguousWidth: 1,
      colorDepth: 24,
      cellMeasurer: terminalCellMeasurer()
    }
  });
}

function viewport(documentDisplayList, scrollRow, scrollOffsets = []) {
  const retained = buildViewportDisplayList({
    documentDisplayList,
    spatialIndex: buildDisplayListSpatialIndex(documentDisplayList),
    context: documentDisplayList.context,
    window: { scrollRow, scrollOffsets, viewportRows: documentDisplayList.context.rows, overscanBefore: 0, overscanAfter: 0 }
  });
  const cells = rasterizeViewportDisplayList({ displayList: retained });
  const terminal = buildViewportTerminalResult({
    displayList: retained,
    cellBuffer: cells.cellBuffer,
    documentGeometry: buildDocumentGeometryIndex(documentDisplayList),
    truncations: cells.truncations
  });
  return { displayList: retained, terminal };
}

for (const [name, parentStyle, inset, expected] of [
  ["automatic height", "", "50%", 0],
  ["minimum height only", "min-height:100px", "50%", 0],
  ["unresolved calculated inset", "min-height:100px", "calc(50% + 8px)", 0],
  ["definite height", "height:100px", "50%", 50],
  ["calculated definite inset", "height:100px", "calc(50% + 8px)", 58],
  ["zero definite height", "height:0", "calc(50% + 8px)", 8],
  ["pixel-only calculation", "", "calc(4px + 4px)", 8]
]) {
  test(`relative block inset preserves ${name} percentage basis`, () => {
    const result = render(`<div id="owner" style="${parentStyle}">
      <div id="target" style="position:relative;top:${inset};height:16px">x</div>
      <div id="following" style="height:16px">y</div></div>`);
    assert.equal(offset(result, "target", "owner"), expected);
    assert.equal(offset(result, "following", "owner"), 16, "relative offsets do not move normal-flow siblings");
  });
}

test("unresolved top becomes auto before a definite bottom inset is selected", () => {
  const result = render(`<div id="owner"><div id="target"
    style="position:relative;top:calc(50% + 8px);bottom:4px;height:16px">x</div></div>`);
  assert.equal(offset(result, "target", "owner"), -4);
});

test("nested relative inline uses its owning block rather than an ancestor text union", () => {
  const markup = (insets) => `<div id="owner" style="width:160px;height:100px"><span><span id="target"
    style="position:relative;${insets}">abc</span></span></div>`;
  const normal = render(markup(""));
  const shifted = render(markup("left:50%;top:50%"));
  const before = fragment(normal, "target");
  const after = fragment(shifted, "target");
  assert.equal(cssPixels(before.borderRect.width), 24);
  assert.equal(cssPixels(before.borderRect.height), 16);
  assert.equal(cssPixels(after.borderRect.x - before.borderRect.x), 80);
  assert.equal(cssPixels(after.borderRect.y - before.borderRect.y), 50);
});

for (const display of ["inline-block", "inline-flex", "inline-grid"]) {
  test(`${display} keeps its external inset basis separate from the basis it owns for descendants`, () => {
    const result = render(`<div id="outer" style="width:160px;height:100px"><span id="atomic"
      style="display:${display};width:80px;height:40px;position:relative;left:50%;top:50%;vertical-align:top">
      <span id="target" style="display:block;position:relative;top:50%;height:16px">abc</span>
    </span></div>`);
    assert.equal(offset(result, "atomic", "outer", "x"), 80);
    assert.equal(offset(result, "atomic", "outer"), 50);
    assert.equal(offset(result, "target", "atomic"), 20);
  });

  test(`${display} percentage width uses the owning block despite a float-reduced line`, () => {
    const result = render(`<div id="owner" style="width:160px"><div style="float:left;width:48px;height:32px"></div>
      <span id="atomic" style="display:${display};width:50%;height:16px;vertical-align:top">x</span></div>`);
    assert.equal(cssPixels(fragment(result, "atomic").contentRect.width), 80);
    assert.equal(offset(result, "atomic", "owner", "x"), 48);
  });
}

test("flex principal percentage padding and margins use the flex container width", () => {
  const result = render(`<div style="display:flex;width:160px;align-items:start"><div id="item"
    style="flex:0 0 40px;min-width:0;padding:10%;margin-left:10%">x</div></div>`);
  const item = fragment(result, "item");
  assert.equal(cssPixels(item.contentRect.width), 40);
  assert.equal(cssPixels(item.contentRect.x - item.borderRect.x), 16);
  assert.equal(cssPixels(item.contentRect.y - item.borderRect.y), 16);
  assert.equal(cssPixels(item.borderRect.x - item.marginRect.x), 16);
});

for (const display of ["flex", "grid"]) {
  test(`${display} resolves its own percentage height against the incoming definite block`, () => {
    const result = render(`<div style="height:100px"><div id="container" style="display:${display};height:50%">
      <div id="child" style="height:50%">x</div></div></div>`);
    assert.equal(contentHeight(result, "container"), 50);
    assert.equal(contentHeight(result, "child"), 25);
  });

  test(`${display} leaves its own percentage height indefinite under an auto block`, () => {
    const result = render(`<div><div id="container" style="display:${display};height:50%;align-items:start">
      <div id="child" style="height:16px">x</div></div></div>`);
    assert.equal(contentHeight(result, "container"), 16);
    assert.equal(contentHeight(result, "child"), 16);
  });
}

test("a relatively positioned grid item resolves top against its grid area", () => {
  const result = render(`<div id="grid" style="display:grid;width:160px;height:100px;grid-template-rows:40px">
    <div id="item" style="position:relative;top:50%;height:16px">abc</div></div>`);
  assert.equal(offset(result, "item", "grid"), 20);
});

test("a definite column flex main size is a percentage basis for item descendants", () => {
  const result = render(`<div style="display:flex;flex-direction:column;height:100px;width:160px">
    <div id="item" style="flex:1;min-height:0"><div id="child" style="height:50%">x</div></div></div>`);
  assert.equal(contentHeight(result, "item"), 100);
  assert.equal(contentHeight(result, "child"), 50);
});

test("a definite flex basis supplies an item main-size basis in an auto-height column", () => {
  const result = render(`<div style="display:flex;flex-direction:column;width:160px">
    <div id="item" style="flex:0 0 40px;min-height:0"><div id="child"
      style="position:relative;top:50%;height:16px">x</div></div></div>`);
  assert.equal(contentHeight(result, "item"), 40);
  assert.equal(offset(result, "child", "item"), 20);
});

test("an auto flex main size does not become definite merely by having final pixels", () => {
  const result = render(`<div style="display:flex;flex-direction:column;width:160px">
    <div id="item"><div id="child" style="position:relative;top:50%;height:16px">x</div></div></div>`);
  assert.equal(contentHeight(result, "item"), 16);
  assert.equal(offset(result, "child", "item"), 0);
});

// https://www.w3.org/TR/css-flexbox-1/#definite-sizes and #cross-sizing:
// stretching must relayout contents even when the cross-size pixels do not change.
for (const [height, expected] of [["16px", 16], ["100px", 100], ["auto", 16]]) {
  test(`flex cross-axis stretch relayout propagates definiteness with height:${height}`, () => {
    const result = render(`<div style="display:flex;width:160px;height:${height};align-items:stretch">
      <div id="item"><div id="child" style="height:50%">x</div></div></div>`);
    assert.equal(contentHeight(result, "item"), expected);
    assert.equal(contentHeight(result, "child"), expected / 2,
      "the equal-pixel 16px case still needs percentage-aware relayout");
  });
}

test("sticky percentage insets use the nearest scrollport dimensions", () => {
  const result = render(`<div style="height:200px;overflow:auto"><div id="scrollport"
    style="width:160px;height:100px;overflow:auto"><div style="height:400px"><div id="sticky"
    style="position:sticky;top:10%;left:10%;height:16px">x</div></div></div></div>`);
  const sticky = fragment(result, "sticky");
  const attachment = result.layout.scrollAttachment(sticky.id);
  assert.equal(attachment?.kind, "sticky");
  assert.equal(cssPixels(attachment.top), 10);
  assert.equal(cssPixels(attachment.left), 16);
});

test("nested relative ancestors translate sticky normal geometry and containment together", () => {
  const result = render(`<div style="position:relative;top:32px"><div id="scrollport"
    style="width:160px;height:100px;overflow:auto"><div id="owner" style="position:relative;top:16px;height:64px">
    <a id="sticky" href="/sticky" style="display:block;position:sticky;top:10%;height:16px">abc</a>
    </div><div style="height:320px"></div></div></div>`);
  const sticky = fragment(result, "sticky");
  const attachment = result.layout.scrollAttachment(sticky.id);
  assert.equal(attachment?.kind, "sticky");
  assert.equal(cssPixels(attachment.top), 10);
  assert.equal(cssPixels(sticky.borderRect.y), 48);
  assert.equal(cssPixels(attachment.normalBorderRect.y), 48);
  assert.equal(attachment.containingBlock.y, fragment(result, "owner").contentRect.y);
  const retained = viewport(displayList(result), 0, [{ node: node(result, "scrollport"), inline: 0, block: cssPx(64) }]);
  const command = [...retained.displayList.commands].find((value) => value.kind === "text" && value.text === "abc");
  assert.ok(command);
  assert.equal(cssPixels(command.rect.y), 32, "sticky box is constrained by the translated owner bottom");
  assert.equal(retained.terminal.hitTestIndex.at(2, 0)?.action.node, node(result, "sticky"));
});

for (const position of ["absolute", "fixed"]) {
  test(`${position} opposing insets give descendants a definite derived height`, () => {
    const result = render(`<div style="position:relative;width:160px;height:100px"><div id="owner"
      style="position:${position};left:0;right:0;top:10px;bottom:10px"><div id="child"
      style="position:relative;top:50%;height:16px">x</div></div></div>`, 20, 10);
    const expectedHeight = position === "absolute" ? 80 : 140;
    assert.equal(contentHeight(result, "owner"), expectedHeight);
    assert.equal(offset(result, "child", "owner"), expectedHeight / 2);
  });

  test(`${position} inset-derived height constraints agree with descendant percentage bases`, () => {
    for (const [constraint, expected] of [["max-height:40px", 40], ["min-height:200px", 200]]) {
      const result = render(`<div style="position:relative;width:160px;height:100px"><div id="owner"
        style="position:${position};left:0;right:0;top:10px;bottom:10px;${constraint}"><div id="child"
        style="position:relative;top:50%;height:50%">x</div></div></div>`, 20, 10);
      assert.equal(contentHeight(result, "owner"), expected, constraint);
      assert.equal(contentHeight(result, "child"), expected / 2, constraint);
      assert.equal(offset(result, "child", "owner"), expected / 2, constraint);
    }
  });
}

test("flex row stretch constraints agree with item geometry and descendant percentage bases", () => {
  for (const [height, constraint, expected] of [[100, "max-height:40px", 40], [16, "min-height:40px", 40]]) {
    const result = render(`<div style="display:flex;width:160px;height:${height}px;align-items:stretch">
      <div id="item" style="${constraint}"><div id="child"
      style="position:relative;top:50%;height:50%">x</div></div></div>`);
    assert.equal(contentHeight(result, "item"), expected, constraint);
    assert.equal(contentHeight(result, "child"), expected / 2, constraint);
    assert.equal(offset(result, "child", "item"), expected / 2, constraint);
  }
});

for (const display of ["flex", "grid"]) {
  test(`an auto-height column flex allocation preserves its ${display} item's used size independently of definiteness`, () => {
    const result = render(`<div id="outer" style="display:flex;flex-direction:column;width:160px">
      <div id="item" style="display:${display};align-items:start"><div id="child"
      style="position:relative;top:50%;height:50%;min-height:0">one<br>two</div></div></div>`);
    assert.equal(contentHeight(result, "outer"), 32);
    assert.equal(contentHeight(result, "item"), 32, "an indefinite percentage basis does not erase allocated geometry");
    assert.equal(contentHeight(result, "child"), display === "grid" ? 16 : 32);
    assert.equal(offset(result, "child", "item"), display === "grid" ? 16 : 0,
      "a final grid area owns its basis; an auto-height flex container remains indefinite");
  });
}

test("absolute percentage insets retain the final auto-height positioned containing block", () => {
  const result = render(`<div id="owner" style="position:relative;width:160px"><div style="height:100px"></div>
    <div id="absolute" style="position:absolute;top:50%;height:16px">a</div>
    <div id="fixed" style="position:fixed;top:50%;height:16px">f</div></div>`, 20, 10);
  assert.equal(contentHeight(result, "owner"), 100);
  assert.equal(offset(result, "absolute", "owner"), 50);
  assert.equal(cssPixels(fragment(result, "fixed").borderRect.y), 80);
});

test("final cells of an explicit-height table own descendant percentage bases", () => {
  // This checks the supported final-cell relayout policy. It does not claim
  // complete CSS Tables percentage-height behavior for auto-sized tables.
  const result = render(`<table style="height:100px;width:160px;border-spacing:0"><tr><td id="cell"
    style="padding:0;vertical-align:top"><div id="relative" style="position:relative;top:50%;height:16px">x</div>
    <div id="sized" style="height:50%">y</div></td></tr></table>`);
  const cell = fragment(result, "cell", "table-cell");
  assert.equal(cssPixels(cell.contentRect.height), 100);
  assert.equal(cssPixels(fragment(result, "relative").borderRect.y - cell.contentRect.y), 50);
  assert.equal(contentHeight(result, "sized"), 50);
});

for (const [name, tableStyle, cellStyle, relativeOffset, childHeight] of [
  ["auto table and cell", "", "", 0, 16],
  ["explicit table height", "height:100px", "", 50, 50],
  ["explicit cell height", "", "height:100px", 50, 50]
]) {
  test(`${name} preserves the supported table-cell percentage-height policy`, () => {
    const result = render(`<table style="width:160px;border-spacing:0;${tableStyle}"><tr>
      <td id="cell" style="padding:0;vertical-align:top;${cellStyle}">
      <div id="relative" style="position:relative;top:50%;height:16px">x</div>
      <div id="sized" style="height:50%">y</div></td>
      <td style="height:100px;padding:0;vertical-align:top">z</td></tr></table>`);
    const cell = fragment(result, "cell", "table-cell");
    assert.equal(cssPixels(cell.contentRect.height), 100);
    assert.equal(cssPixels(fragment(result, "relative").borderRect.y - cell.contentRect.y), relativeOffset);
    assert.equal(contentHeight(result, "sized"), childHeight);
  });
}

test("relative percentage movement preserves source hit geometry across retained scroll windows", () => {
  const result = render(`<div style="height:32px"></div><div style="width:160px;height:64px">
    <span><a id="target" href="/target" style="position:relative;left:50%;top:50%">abc</a></span>
    </div><div style="height:640px"></div>`, 40, 8);
  const original = { ...fragment(result, "target").borderRect };
  assert.equal(cssPixels(original.x), 80);
  assert.equal(cssPixels(original.y), 64);
  const sourceText = result.document.node(node(result, "target")).children.find((ref) => result.document.node(ref).kind === "text");
  assert.ok(sourceText);
  const list = displayList(result);
  for (const scrollRow of [0, 2, 4]) {
    const retained = viewport(list, scrollRow);
    const expected = { row: 4, column: 10, width: 3, height: 1 };
    const command = [...retained.displayList.commands].find((value) => value.kind === "text" && value.text === "abc");
    assert.ok(command, `retained text at scroll row ${scrollRow}`);
    assert.equal(command.documentNode, sourceText);
    assert.equal(command.contentStartCodeUnit, 0);
    assert.equal(command.contentEndCodeUnit, 3);
    assert.equal(cssPixels(command.rect.y), 64);
    const painted = paintedSourceUnits(retained.terminal.cellBuffer.rows, retained.displayList.commands, result.layout);
    assert.deepEqual(painted.malformedSpans, []);
    assert.deepEqual(painted.units.filter((unit) => unit.documentNode === sourceText)
      .map((unit) => [unit.contentStartCodeUnit, unit.contentEndCodeUnit, unit.text]),
    [[0, 1, "a"], [1, 2, "b"], [2, 3, "c"]]);
    assert.equal(retained.terminal.hitTestIndex.at(4, 10)?.action.node, node(result, "target"));
    assert.deepEqual(retained.terminal.focusMap.forNode(node(result, "target"))?.rects[0], expected);
    assert.deepEqual(retained.terminal.accessibilityBounds.find((value) => value.documentNode === node(result, "target"))?.rect, expected);
    assert.deepEqual(fragment(result, "target").borderRect, original, "viewport projection does not mutate layout");
  }
});

// Independent behavioral adaptations of WPT css/css-position/position-relative-015.html.
// Provenance and explicit exclusions are in ../fixtures/wpt-relative-percentage-provenance.json.
const relativeChild = '<div id="target" style="position:relative;top:50%;width:20px;height:20px"></div>';
const owner = (style = "") => `<div id="owner" style="${style}">${relativeChild}</div>`;
for (const [number, description, html, expected] of [
  [1, "fixed containing height", owner("height:200px"), 100],
  [2, "automatic containing height", owner(), 0],
  [3, "resolved percentage containing height", `<div style="height:200px">${owner("height:50%")}</div>`, 50],
  [4, "out-of-flow derived height", `<div style="position:relative;height:200px">${owner("position:absolute;inset:0")}</div>`, 100],
  [5, "stretched grid item", `<div style="display:grid;height:200px">${owner()}</div>`, 100],
  [6, "zero grid track", `<div style="display:grid;grid-template-rows:0px;height:200px">${owner()}</div>`, 0],
  [7, "explicit auto grid item height", `<div style="display:grid;height:200px">${owner("height:auto")}</div>`, 100],
  [8, "fixed grid track", `<div style="display:grid;grid-template-rows:100px;height:200px">${owner()}</div>`, 50],
  [9, "percentage grid track", `<div style="display:grid;grid-template-rows:50%;height:200px">${owner()}</div>`, 50],
  [10, "percentage against auto body", owner("height:100%"), 0],
  [11, "unresolved percentage with minimum", `<div>${owner("height:50%;min-height:200px")}</div>`, 0],
  [15, "nested unresolved percentages", `<div><div style="height:50%">${owner("height:50%;min-height:200px")}</div></div>`, 0],
  [16, "fixed calc height", owner("height:calc(100px + 100px)"), 100],
  [17, "resolvable percentage calc", `<div style="height:200px">${owner("height:calc(50% + 0px)")}</div>`, 50],
  [18, "unresolvable percentage calc", `<div>${owner("height:calc(50% + 0px);min-height:200px")}</div>`, 0],
  [20, "nested resolved percentages", `<div style="height:200px"><div style="height:50%">${owner("height:50%")}</div></div>`, 25]
]) {
  test(`WPT position-relative-015 case ${number}: ${description}`, () => {
    const result = render(html);
    assert.equal(offset(result, "target", "owner"), expected);
  });
}


for (const [name, attributes, css, expected, depends] of [
  ["HTML hints", 'width="160" height="80"', "", [160, 80], false],
  ["author auto overrides both hints", 'width="160" height="80"', "width:auto;height:auto", [48, 32], true],
  ["author width auto uses height and natural ratio", 'width="160" height="64"', "width:auto", [96, 64], true],
  ["author height auto uses width and natural ratio", 'width="96" height="80"', "height:auto", [96, 64], true],
  ["author CSS overrides hints", 'width="160" height="80"', "width:24px;height:16px", [24, 16], false],
  ["explicit zero hints", 'width="0" height="0"', "", [0, 0], false],
]) {
  test(`image size cascade and natural metadata dependency: ${name}`, () => {
    const id = "https://percentage-ownership.example/image.png";
    const result = render(`<img id="image" src="image.png" alt="fallback" ${attributes} style="${css}">`,
      80, 40, [{ id, width: 48, height: 32 }]);
    const image = fragment(result, "image", "image");
    assert.deepEqual([cssPixels(image.contentRect.width), cssPixels(image.contentRect.height)], expected);
    assert.equal(result.layout.imageDimensionsAffectLayout(id), depends);
  });
}

test("image natural metadata dependencies include unresolved resources and shared auto owners", () => {
  const id = "https://percentage-ownership.example/image.png";
  for (const images of [[], [{ id, width: null, height: null }], [{ id, width: 48, height: 32 }]]) {
    const fixed = render('<img src="image.png" width="160" height="80" alt="fixed">', 80, 40, images);
    assert.equal(fixed.layout.imageDimensionsAffectLayout(id), false);
    const mixed = render('<img src="image.png" width="160" height="80" alt="fixed"><img src="image.png" alt="auto">', 80, 40, images);
    assert.equal(mixed.layout.imageDimensionsAffectLayout(id), true);
  }
});
