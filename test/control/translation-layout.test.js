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

function reachable(layout) {
  const reached = new Set();
  const pending = [layout.root];
  while (pending.length > 0) {
    const id = pending.pop();
    assert.ok(!reached.has(id), "each fragment has exactly one tree owner");
    reached.add(id);
    pending.push(...layout.fragment(id).children);
  }
  return [...reached];
}

for (const [sizing, width, height] of [
  ["content-box", 104, 56],
  ["border-box", 80, 32]
]) {
  test(`translation calc percentages use the final ${sizing} border box`, () => {
    const source = (transform) => `<div id="box" style="box-sizing:${sizing};width:80px;height:32px;
      padding:8px;border:4px solid;margin:16px;transform:${transform}"><span id="child">content</span></div>`;
    const baseline = render(source("none"));
    const shifted = render(source("translate(calc(50% + 8px), calc(100% - 8px))"));
    assert.equal(cssPixels(fragment(baseline, "box").borderRect.width), width);
    assert.equal(cssPixels(fragment(baseline, "box").borderRect.height), height);
    assertTranslation(fragment(baseline, "box"), fragment(shifted, "box"), width / 2 + 8, height - 8);
    assertTranslation(fragment(baseline, "child"), fragment(shifted, "child"), width / 2 + 8, height - 8);
  });
}

test("sequential and nested translations compose exactly once through ordinary ancestors", () => {
  const source = (outer, inner) => `<div id="outer" style="width:160px;height:96px;transform:${outer}">
    <div id="ordinary" style="padding:8px"><div id="inner" style="width:80px;height:32px;transform:${inner}">
      <span id="leaf">nested</span></div></div></div>`;
  const baseline = render(source("none", "none"));
  const shifted = render(source("translate(16px, 32px) translateX(-8px) translateY(16px)", "translate(25%, -50%)"));
  assertTranslation(fragment(baseline, "outer"), fragment(shifted, "outer"), 8, 48);
  assertTranslation(fragment(baseline, "ordinary"), fragment(shifted, "ordinary"), 8, 48);
  assertTranslation(fragment(baseline, "inner"), fragment(shifted, "inner"), 28, 32);
  assertTranslation(fragment(baseline, "leaf"), fragment(shifted, "leaf"), 28, 32);
  const before = baseline.displayList.commands.find((command) => command.kind === "text" && command.text === "nested");
  const after = shifted.displayList.commands.find((command) => command.kind === "text" && command.text === "nested");
  assert.ok(before && after);
  assert.deepEqual(rectangle(after.rect), { ...rectangle(before.rect), x: cssPixels(before.rect.x) + 28, y: cssPixels(before.rect.y) + 32 });
});

test("translations preserve normal-flow placement and auto-sized parent dimensions", () => {
  const source = (transform) => `<div id="parent" style="width:96px">
    <div id="moving" style="height:32px;transform:${transform}">translated</div>
    <div id="following" style="height:16px">following</div></div><div id="after" style="height:16px">after</div>`;
  const baseline = render(source("none"));
  const shifted = render(source("translate(-24px, 96px)"));
  assertTranslation(fragment(baseline, "moving"), fragment(shifted, "moving"), -24, 96);
  for (const id of ["parent", "following", "after"]) {
    assert.deepEqual(fragment(shifted, id).borderRect, fragment(baseline, id).borderRect, id);
  }
  assert.equal(cssPixels(fragment(shifted, "following").borderRect.y), 32);
  assert.equal(cssPixels(fragment(shifted, "parent").borderRect.height), 48);
  assert.ok(shifted.documentGeometry.documentExtent.height >= cssPx(128), "translated paint extends the document overflow");
});

for (const [x, y] of [[96, 80], [-96, -80]]) {
  test(`translation (${x}, ${y}) preserves the original flow footprint in overflow`, () => {
    const source = (transform) => `<div style="height:96px"></div><div id="owner" style="width:80px;margin-left:96px">
      <div id="moving" style="width:80px;height:32px;transform:${transform}">moving</div></div>`;
    const baseline = render(source("none"));
    const shifted = render(source(`translate(${x}px,${y}px)`));
    const original = fragment(baseline, "moving").borderRect;
    const moved = fragment(shifted, "moving").borderRect;
    const overflow = fragment(shifted, "owner").overflowRect;
    assert.deepEqual(fragment(shifted, "owner").borderRect, fragment(baseline, "owner").borderRect);
    assertTranslation(fragment(baseline, "moving"), fragment(shifted, "moving"), x, y);
    for (const rect of [original, moved]) {
      assert.ok(overflow.x <= rect.x && overflow.y <= rect.y);
      assert.ok(overflow.x + overflow.width >= rect.x + rect.width);
      assert.ok(overflow.y + overflow.height >= rect.y + rect.height);
    }
  });
}

for (const display of ["inline-block", "inline-flex", "inline-grid"]) {
  test(`translations preserve ${display} intrinsic sizing`, () => {
    const source = (transform) => `<div id="shrink" style="display:${display}">
      <div id="moving" style="transform:${transform}">alpha beta</div></div>`;
    const baseline = render(source("none"));
    const shifted = render(source("translate(200%, 96px)"));
    for (const id of ["shrink", "moving"]) {
      const before = fragment(baseline, id);
      const after = fragment(shifted, id);
      assert.equal(after.borderRect.width, before.borderRect.width, `${id} width`);
      assert.equal(after.borderRect.height, before.borderRect.height, `${id} height`);
      assert.equal(after.minContentContribution, before.minContentContribution, `${id} min-content`);
      assert.equal(after.maxContentContribution, before.maxContentContribution, `${id} max-content`);
    }
    assertTranslation(fragment(baseline, "moving"), fragment(shifted, "moving"), cssPixels(fragment(baseline, "moving").borderRect.width) * 2, 96);
  });
}

test("translate(0) establishes a stacking context and containing block while none does not", () => {
  const source = (transform) => `<div id="owner" style="margin:48px 0 0 32px;width:80px;height:64px;
      padding:8px;border:4px solid;transform:${transform}">
    <div id="absolute" style="position:absolute;left:0;top:0;width:8px;height:16px;z-index:9">A</div>
    <div id="fixed" style="position:fixed;left:0;top:16px;width:8px;height:16px">F</div></div>`;
  const untransformed = render(source("none"));
  const transformed = render(source("translate(0)"));
  const owner = fragment(transformed, "owner");
  assert.equal(untransformed.layout.stacking(fragment(untransformed, "owner").id).establishesStackingContext, false);
  assert.equal(transformed.layout.stacking(owner.id).establishesStackingContext, true);
  assert.equal(transformed.layout.stacking(fragment(transformed, "absolute").id).containingStackingContext, owner.id);
  assert.equal(untransformed.layout.stacking(fragment(untransformed, "absolute").id).containingStackingContext, untransformed.layout.root);
  assert.equal(fragment(untransformed, "absolute").borderRect.x, 0);
  assert.equal(fragment(untransformed, "absolute").borderRect.y, 0);
  assert.equal(fragment(transformed, "absolute").borderRect.x, owner.paddingRect.x);
  assert.equal(fragment(transformed, "absolute").borderRect.y, owner.paddingRect.y);
  assert.equal(fragment(transformed, "fixed").borderRect.x, owner.paddingRect.x);
  assert.equal(fragment(transformed, "fixed").borderRect.y, owner.paddingRect.y + cssPx(16));
  assert.equal(transformed.layout.scrollAttachment(fragment(transformed, "fixed").id), null);
  assert.equal(untransformed.layout.scrollAttachment(fragment(untransformed, "fixed").id)?.kind, "fixed");
});

test("transformed contexts contain high z-index descendants below a higher sibling context", () => {
  const source = (transform) => `<div id="owner" style="width:80px;height:16px;transform:${transform}">
      <div id="nested" style="position:relative;z-index:99;background:red">nested</div></div>
    <div id="sibling" style="position:relative;z-index:1;background:blue">sibling</div>`;
  const paintOrder = (result, id) => {
    const command = result.displayList.commands.find((candidate) => candidate.kind === "background" && candidate.documentNode === node(result, id));
    assert.ok(command);
    return command.paintOrder;
  };
  const baseline = render(source("none"));
  const transformed = render(source("translateX(0px)"));
  assert.ok(paintOrder(baseline, "nested") > paintOrder(baseline, "sibling"));
  assert.ok(paintOrder(transformed, "nested") < paintOrder(transformed, "sibling"));
});

for (const position of ["absolute", "fixed"]) {
  test(`${position} descendants resolve against transformed padding boxes through normal ancestors`, () => {
    const result = render(`<div id="owner" style="margin:32px;width:80px;height:64px;padding:8px;border:4px solid;
        transform:translate(16px,32px)"><div style="margin:16px;padding:8px;width:24px;height:16px">
        <div id="positioned" style="position:${position};left:50%;top:50%;width:8px;height:16px">P</div>
      </div></div>`);
    const owner = fragment(result, "owner");
    const positioned = fragment(result, "positioned");
    assert.equal(positioned.borderRect.x, owner.paddingRect.x + owner.paddingRect.width / 2);
    assert.equal(positioned.borderRect.y, owner.paddingRect.y + owner.paddingRect.height / 2);
    assert.equal(result.layout.scrollAttachment(positioned.id), null);
  });

  test(`${position} descendants use final auto-height transformed owners`, () => {
    const result = render(`<div id="owner" style="width:80px;padding:8px;border:4px solid;transform:translateY(50%)">
        <div style="height:64px"></div><div style="height:0">
          <div id="bottom" style="position:${position};bottom:0;right:0;width:8px;height:16px">B</div>
          <div id="middle" style="position:${position};top:50%;left:0;width:8px;height:16px">M</div>
        </div></div><div id="following" style="height:16px">following</div>`);
    const owner = fragment(result, "owner");
    const bottom = fragment(result, "bottom");
    const middle = fragment(result, "middle");
    assert.equal(cssPixels(owner.borderRect.height), 88);
    assert.equal(cssPixels(owner.borderRect.y), 44);
    assert.equal(bottom.borderRect.y + bottom.borderRect.height, owner.paddingRect.y + owner.paddingRect.height);
    assert.equal(bottom.borderRect.x + bottom.borderRect.width, owner.paddingRect.x + owner.paddingRect.width);
    assert.equal(middle.borderRect.y, owner.paddingRect.y + owner.paddingRect.height / 2);
    assert.equal(cssPixels(fragment(result, "following").borderRect.y), 88);
  });
}

test("fixed descendants under transforms scroll with the document while viewport-fixed content stays put", () => {
  const result = render(`<div style="height:64px"></div>
    <div id="owner" style="transform:translate(16px,16px);height:64px">
      <div><a id="trapped" href="/trapped" style="position:fixed;left:0;top:0">trapped</a></div></div>
    <div style="height:1000px"></div><a id="free" href="/free" style="position:fixed;left:160px;top:0">free</a>`, 40, 4);
  const trapped = node(result, "trapped");
  const free = node(result, "free");
  for (const scrollRow of [3, 6]) {
    const scrolled = viewport(result, scrollRow);
    const freeCommand = scrolled.displayList.commands.find((command) => command.kind === "text" && command.text === "free");
    assert.ok(freeCommand);
    assert.equal(cssPixels(freeCommand.rect.y), scrollRow * 16);
    assert.equal(scrolled.terminal.hitTestIndex.at(scrollRow, 20)?.action.node, free);
    const trappedCommand = scrolled.displayList.commands.find((command) => command.kind === "text" && command.text === "trapped");
    if (scrollRow === 3) {
      assert.ok(trappedCommand);
      assert.equal(cssPixels(trappedCommand.rect.y), 80);
      assert.equal(scrolled.terminal.hitTestIndex.at(5, 2)?.action.node, trapped);
      assert.equal(scrolled.terminal.focusMap.forNode(trapped)?.rects[0].row, 5);
      assert.equal(scrolled.terminal.accessibilityBounds.find((entry) => entry.documentNode === trapped)?.rect.row, 5);
    } else {
      assert.equal(trappedCommand, undefined);
      assert.ok(!scrolled.terminal.hitTestIndex.regions.some((entry) => entry.action.node === trapped));
      assert.equal(scrolled.terminal.focusMap.forNode(trapped), null);
    }
  }
});

test("translated overflow owners move their clips, paint, hit targets, focus, and accessibility together", () => {
  const result = render(`<div style="width:48px;height:16px;overflow:hidden;transform:translate(16px,32px)">
    <a id="link" href="/next" style="white-space:nowrap">abcdefghij</a></div>`);
  const link = node(result, "link");
  assert.match(result.terminal.cellBuffer.rows.find((row) => row.row === 2)?.text ?? "", /^ {2}abcdef$/u);
  assert.equal(result.terminal.hitTestIndex.at(0, 0), null);
  assert.equal(result.terminal.hitTestIndex.at(2, 2)?.action.node, link);
  assert.equal(result.terminal.hitTestIndex.at(2, 7)?.action.node, link);
  assert.equal(result.terminal.hitTestIndex.at(2, 8), null);
  const expected = { row: 2, column: 2, width: 6, height: 1 };
  const focus = result.terminal.focusMap.forNode(link);
  assert.ok(focus && focus.rects.length > 0);
  for (const rect of focus.rects) assert.deepEqual(rect, expected);
  assert.deepEqual(result.terminal.accessibilityBounds.find((entry) => entry.documentNode === link)?.rect, expected);
});

test("a translated child remains clipped by its untranslated ancestor", () => {
  const result = render(`<div style="width:48px;height:32px;overflow:hidden">
    <a id="link" href="/next" style="display:block;width:80px;height:16px;white-space:nowrap;
      transform:translate(32px,16px)">abcdefghij</a></div>`);
  const link = node(result, "link");
  assert.match(result.terminal.cellBuffer.rows.find((row) => row.row === 1)?.text ?? "", /^ {4}ab$/u);
  assert.equal(result.terminal.hitTestIndex.at(1, 4)?.action.node, link);
  assert.equal(result.terminal.hitTestIndex.at(1, 5)?.action.node, link);
  assert.equal(result.terminal.hitTestIndex.at(1, 6), null);
  assert.deepEqual(result.terminal.accessibilityBounds.find((entry) => entry.documentNode === link)?.rect,
    { row: 1, column: 4, width: 2, height: 1 });
});

test("translated positioned owners move explicit clips without changing ancestor clips", () => {
  const result = render(`<div style="width:40px;height:64px;overflow:hidden;position:relative">
    <div style="position:absolute;width:80px;height:32px;clip:rect(0px,32px,16px,0px);transform:translate(16px,32px)">
      <a id="link" href="/next" style="white-space:nowrap">abcdefghij</a></div></div>`);
  const link = node(result, "link");
  assert.match(result.terminal.cellBuffer.rows.find((row) => row.row === 2)?.text ?? "", /^ {2}abc$/u);
  assert.equal(result.terminal.hitTestIndex.at(2, 2)?.action.node, link);
  assert.equal(result.terminal.hitTestIndex.at(2, 4)?.action.node, link);
  assert.equal(result.terminal.hitTestIndex.at(2, 5), null);
  assert.deepEqual(result.terminal.accessibilityBounds.find((entry) => entry.documentNode === link)?.rect,
    { row: 2, column: 2, width: 3, height: 1 });
});

test("fixed descendants choose the transformed owner across a nearer positioned ordinary ancestor", () => {
  const result = render(`<div id="owner" style="width:160px;height:96px;padding:8px;border:4px solid;transform:translate(16px,32px)">
    <div id="relative" style="position:relative;left:8px;top:16px;margin:16px;padding:4px;width:32px;height:32px">
      <div id="absolute" style="position:absolute;left:0;top:0;width:8px;height:16px">A</div>
      <div id="fixed" style="position:fixed;left:0;top:0;width:8px;height:16px">F</div>
    </div></div>`);
  const owner = fragment(result, "owner");
  const relative = fragment(result, "relative");
  assert.equal(fragment(result, "absolute").borderRect.x, relative.paddingRect.x);
  assert.equal(fragment(result, "absolute").borderRect.y, relative.paddingRect.y);
  assert.equal(fragment(result, "fixed").borderRect.x, owner.paddingRect.x);
  assert.equal(fragment(result, "fixed").borderRect.y, owner.paddingRect.y);
});

test("nested transformed containing blocks compose with a fixed descendant's own translation", () => {
  const source = (outer, inner, fixed) => `<div id="outer" style="width:160px;height:128px;padding:8px;transform:${outer}">
    <div style="padding:8px"><div id="inner" style="width:80px;height:64px;padding:4px;transform:${inner}">
      <div><a id="fixed" href="/fixed" style="position:fixed;right:0;bottom:0;width:8px;height:16px;transform:${fixed}">F</a></div>
    </div></div></div>`;
  const baseline = render(source("translate(0)", "translate(0)", "none"));
  const shifted = render(source("translate(16px,32px)", "translate(8px,16px)", "translate(-4px,8px)"));
  assertTranslation(fragment(baseline, "inner"), fragment(shifted, "inner"), 24, 48);
  assertTranslation(fragment(baseline, "fixed"), fragment(shifted, "fixed"), 20, 56);
  assert.equal(shifted.layout.scrollAttachment(fragment(shifted, "fixed").id), null);
});

test("a transformed viewport-fixed owner retains viewport attachment for its locally fixed descendants", () => {
  const result = render(`<div style="height:1000px"></div>
    <div id="owner" style="position:fixed;left:16px;top:16px;width:80px;height:64px;transform:translate(16px,16px)">
      <div><a id="fixed" href="/fixed" style="position:fixed;left:16px;top:16px;width:8px;height:16px">F</a></div></div>`, 40, 6);
  const owner = fragment(result, "owner");
  const fixed = fragment(result, "fixed");
  assert.equal(result.layout.scrollAttachment(owner.id)?.kind, "fixed");
  assert.equal(result.layout.scrollAttachment(fixed.id), null);
  assert.equal(cssPixels(fixed.borderRect.x), 48);
  assert.equal(cssPixels(fixed.borderRect.y), 48);
  for (const scrollRow of [0, 5]) {
    const scrolled = viewport(result, scrollRow);
    assert.equal(scrolled.terminal.hitTestIndex.at(scrollRow + 3, 6)?.action.node, node(result, "fixed"));
    assert.equal(scrolled.terminal.accessibilityBounds.find((entry) => entry.documentNode === node(result, "fixed"))?.rect.row, scrollRow + 3);
  }
});

test("fixed descendants of a transform do not inherit an intervening sticky ancestor's scroll displacement", () => {
  const result = render(`<div style="height:32px"></div>
    <div id="owner" style="width:160px;height:400px;transform:translateX(16px)">
      <div style="height:32px"></div><div id="sticky" style="position:sticky;top:0;height:32px">
        <a id="fixed" href="/fixed" style="position:fixed;left:0;top:128px;width:8px;height:16px">F</a>
      </div></div>`, 40, 10);
  const fixed = fragment(result, "fixed");
  assert.equal(cssPixels(fixed.borderRect.y), 160);
  const scrolled = viewport(result, 8);
  const painted = scrolled.displayList.commands.find((command) => command.kind === "text" && command.text === "F");
  assert.ok(painted);
  assert.equal(painted.rect.y, fixed.borderRect.y);
  assert.equal(scrolled.terminal.hitTestIndex.at(10, 2)?.action.node, node(result, "fixed"));
  assert.equal(scrolled.terminal.accessibilityBounds.find((entry) => entry.documentNode === node(result, "fixed"))?.rect.row, 10);
});

for (const [label, owner, inner, visible] of [
  ["owner overflow", "overflow:hidden;width:48px;height:16px", "", false],
  ["intervening normal overflow", "width:160px;height:32px", "overflow:hidden;width:8px;height:8px", true]
]) {
  test(`transformed fixed descendants respect ${label}`, () => {
    const result = render(`<div style="transform:translate(16px,16px);${owner}"><div style="${inner}">
      <a id="fixed" href="/fixed" style="position:fixed;left:80px;top:0">fixed</a></div></div>`);
    const fixed = node(result, "fixed");
    assert.equal(text(result).includes("fixed"), visible);
    assert.equal(result.terminal.hitTestIndex.regions.some((entry) => entry.action.node === fixed), visible);
    assert.equal(result.terminal.focusMap.forNode(fixed) !== null, visible);
    if (visible) assert.equal(result.terminal.hitTestIndex.at(1, 12)?.action.node, fixed);
  });
}

test("non-replaced inline transforms have no geometry, stacking, or containing-block effect", () => {
  const source = (transform) => `<div style="height:32px"></div><p style="padding-left:16px;width:80px">
    <span id="inline" style="transform:${transform}"><span id="leaf">inline text wraps</span>
      <span id="fixed" style="position:fixed;left:0;top:0;width:8px;height:16px">F</span></span></p>`;
  const baseline = render(source("none"));
  const shifted = render(source("translate(80px, 64px)"));
  for (const id of ["inline", "leaf", "fixed"]) {
    assert.deepEqual(fragment(shifted, id).borderRect, fragment(baseline, id).borderRect, id);
  }
  const inline = fragment(shifted, "inline");
  assert.equal(shifted.layout.stacking(inline.id).establishesStackingContext, false);
  assert.equal(shifted.layout.scrollAttachment(fragment(shifted, "fixed").id)?.kind, "fixed");
  assert.equal(text(shifted), text(baseline));
});

for (const transform of ["rotate(45deg)", "translate(32px,16px) rotate(45deg)"]) {
  test(`unsupported ${transform} does not partially translate geometry`, () => {
    const source = (value) => `<div id="box" style="width:80px;height:32px;transform:${value}">unrotated</div>`;
    const baseline = render(source("none"));
    const unsupported = render(source(transform));
    assert.deepEqual(fragment(unsupported, "box").borderRect, fragment(baseline, "box").borderRect);
    assert.equal(unsupported.layout.stacking(fragment(unsupported, "box").id).establishesStackingContext, false);
    assert.equal(text(unsupported), text(baseline));
  });
}

const deferredOwners = `<div style="width:160px;padding:8px;transform:translate(16px,16px)">
  ${Array.from({ length: 8 }, (_, index) => `<div id="item${index}" style="height:32px">
    item${index}<div><a href="/fixed${index}" style="position:fixed;left:${index * 8}px;bottom:0;width:8px;height:16px">F</a></div>
  </div>`).join("")}</div>`;

test("deferred transformed owners retain a deterministic connected fragment prefix at layout budgets", () => {
  for (let maxFragments = 2; maxFragments <= 40; maxFragments += 2) {
    const options = { budgets: { maxFragments } };
    const first = render(deferredOwners, 40, 30, options);
    const second = render(deferredOwners, 40, 30, options);
    assert.equal(first.layout.outcome.status, "truncated");
    assert.equal(first.layout.outcome.budget, "maxFragments");
    const ids = reachable(first.layout);
    const retained = new Set(ids);
    assert.equal(ids.length, first.layout.outcome.fragments);
    assert.ok(ids.length <= maxFragments);
    for (const id of ids) {
      const value = first.layout.fragment(id);
      if (id !== first.layout.root) {
        const parent = first.layout.parent(id);
        assert.ok(parent && retained.has(parent.id) && parent.children.includes(id));
      }
      assert.ok(first.layout.forFormattingNode(value.formattingNode).some((entry) => entry.id === id));
    }
    for (const line of first.layout.lineBoxes) {
      assert.ok(retained.has(line.containingFragment));
      assert.ok(line.fragments.every((id) => retained.has(id)));
    }
    const retainedItems = Array.from({ length: 8 }, (_, index) => index)
      .filter((index) => first.layout.forDocumentNode(node(first, `item${index}`)).length > 0);
    assert.deepEqual(retainedItems, retainedItems.map((_, index) => index), "normal-flow items remain a source-order prefix");
    const payload = (result) => reachable(result.layout).map((id) => result.layout.fragment(id));
    assert.deepEqual(payload(first), payload(second));
    assert.deepEqual(first.terminal.cellBuffer.rows, second.terminal.cellBuffer.rows);
  }
});

test("transformed deferred layout honors early and late cancellation checkpoints", () => {
  const controller = new globalThis.AbortController();
  controller.abort();
  assert.throws(() => render(deferredOwners, 40, 30, { signal: controller.signal }), { name: "AbortError" });
  let checkpoints = 0;
  render(deferredOwners, 40, 30, { signal: { throwIfAborted() { checkpoints += 1; } } });
  assert.ok(checkpoints > 10);
  for (const stopAt of [2, Math.floor(checkpoints / 2), checkpoints - 1]) {
    let checks = 0;
    const aborted = new globalThis.DOMException("translation cancelled", "AbortError");
    const signal = {
      throwIfAborted() {
        checks += 1;
        if (checks === stopAt) throw aborted;
      }
    };
    assert.throws(() => render(deferredOwners, 40, 30, { signal }), (error) => error === aborted);
    assert.equal(checks, stopAt);
  }
});
