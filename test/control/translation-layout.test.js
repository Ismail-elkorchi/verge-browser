import assert from "node:assert/strict";
import test from "node:test";
import { scrollDocument } from "../../dist/ui/document-scroll.js";

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

for (const [layout, container, expectedInline, expectedBlock] of [
  ["row flex", "display:flex;align-items:center", 0, 64],
  ["column flex", "display:flex;flex-direction:column;align-items:center", null, 0],
  ["grid", "display:grid;align-items:center;justify-items:center", 80, 64],
]) {
  for (const position of ["absolute", "fixed"]) {
    test(`${layout} alignment moves only the static-position axes of external ${position} descendants`, () => {
      for (const [insets, x, y] of [
        ["", expectedInline, expectedBlock],
        ["left:8px", 8, expectedBlock],
        ["right:8px", 616, expectedBlock],
        ["top:16px", expectedInline, 16],
        ["bottom:16px", expectedInline, 352],
        ["left:8px;top:16px", 8, 16],
      ]) {
        const result = render(`<div style="${container};width:240px;height:160px">
          <div id="inner" style="width:80px;height:32px"><div>
            <a id="target" href="/target" style="position:${position};${insets};width:16px;height:16px">
              <span id="leaf" style="position:absolute;left:0;top:0;width:8px;height:16px">X</span>
            </a></div></div></div>`);
        const innerX = cssPixels(fragment(result, "inner").borderRect.x);
        if (expectedInline === null) assert.ok(innerX > 0, "column cross-axis alignment moves the normal-flow item");
        else assert.equal(innerX, expectedInline);
        assert.equal(cssPixels(fragment(result, "inner").borderRect.y), expectedBlock);
        for (const id of ["target", "leaf"]) {
          assert.deepEqual(rectangle(fragment(result, id).borderRect), {
            x: x ?? innerX, y, width: id === "target" ? 16 : 8, height: 16,
          }, `${insets || "auto"}: ${id}`);
        }
      }
    });
  }
}

for (const position of ["absolute", "fixed"]) {
  test(`atomic inline alignment preserves external ${position} explicit insets and moves static axes`, () => {
    const result = render(`<div style="line-height:100px;text-align:center;width:240px">
      <span id="inner" style="display:inline-block;vertical-align:bottom;width:80px;height:32px">
        <a id="automatic" href="/auto" style="position:${position};width:8px;height:16px">A</a>
        <a id="horizontal" href="/horizontal" style="position:${position};left:8px;width:8px;height:16px">H</a>
        <a id="vertical" href="/vertical" style="position:${position};top:16px;width:8px;height:16px">V</a>
        <a id="explicit" href="/explicit" style="position:${position};left:8px;top:16px;width:8px;height:16px">E</a>
      </span></div>`);
    assert.equal(cssPixels(fragment(result, "inner").borderRect.x), 80);
    assert.equal(cssPixels(fragment(result, "inner").borderRect.y), 68);
    for (const [id, x, y] of [["automatic", 80, 68], ["horizontal", 8, 68], ["vertical", 80, 16], ["explicit", 8, 16]]) {
      assert.deepEqual(rectangle(fragment(result, id).borderRect), { x, y, width: 8, height: 16 }, id);
    }
  });
}

for (const ownerStyle of ["position:relative", "transform:translate(16px,32px)"]) {
  test(`aligned deferred descendants use static positions and final ${ownerStyle} containing blocks`, () => {
    for (const position of ["absolute", "fixed"]) {
      const result = render(`<div id="owner" style="${ownerStyle};display:grid;align-items:center;justify-items:center;width:240px;height:160px">
        <div id="inner" style="width:80px;height:32px"><div>
          <span id="automatic" style="position:${position};width:16px;height:16px">A</span>
          <span id="horizontal" style="position:${position};left:8px;width:16px;height:16px">H</span>
          <span id="vertical" style="position:${position};top:16px;width:16px;height:16px">V</span>
          <span id="explicit" style="position:${position};right:8px;bottom:16px;width:16px;height:16px">E</span>
        </div></div></div>`);
      const inner = rectangle(fragment(result, "inner").borderRect);
      const owner = position === "fixed" && ownerStyle === "position:relative"
        ? { x: 0, y: 0, width: 640, height: 384 }
        : rectangle(fragment(result, "owner").paddingRect);
      for (const [id, x, y] of [
        ["automatic", inner.x, inner.y],
        ["horizontal", owner.x + 8, inner.y],
        ["vertical", inner.x, owner.y + 16],
        ["explicit", owner.x + owner.width - 24, owner.y + owner.height - 32],
      ]) {
        assert.deepEqual(rectangle(fragment(result, id).borderRect), { x, y, width: 16, height: 16 }, `${position}: ${id}`);
      }
    }
  });
}

for (const display of ["inline-block", "inline-flex", "inline-grid"]) {
  for (const [ownerStyle, position] of [["position:relative", "absolute"], ["transform:translate(0)", "fixed"]]) {
    test(`${display} line alignment updates the containing block used by deferred ${position} descendants`, () => {
      const result = render(`<div style="line-height:100px;text-align:center;width:240px">
        <span id="owner" style="display:${display};vertical-align:bottom;width:80px;height:32px;${ownerStyle}">
          <div style="height:16px"><a id="target" href="/target" style="position:${position};top:0;left:0;width:8px;height:16px">X</a></div>
        </span></div>`);
      const owner = fragment(result, "owner");
      assert.equal(cssPixels(owner.borderRect.x), 80);
      assert.equal(cssPixels(owner.borderRect.y), 68);
      assert.equal(fragment(result, "target").borderRect.x, owner.paddingRect.x);
      assert.equal(fragment(result, "target").borderRect.y, owner.paddingRect.y);
    });
  }
}

test("relative ancestors move fixed static positions without capturing explicit fixed insets", () => {
  for (const transform of ["none", "translate(16px,32px)"]) {
    const result = render(`<div id="owner" style="width:240px;height:160px;transform:${transform}">
      <div id="relative" style="position:relative;left:24px;top:32px;width:80px;height:32px">
        <div><a id="automatic" href="/auto" style="position:fixed;width:8px;height:16px">A</a>
          <a id="horizontal" href="/horizontal" style="position:fixed;left:8px;width:8px;height:16px">H</a>
          <a id="vertical" href="/vertical" style="position:fixed;top:16px;width:8px;height:16px">V</a>
          <a id="explicit" href="/explicit" style="position:fixed;left:8px;top:16px;width:8px;height:16px">E</a>
        </div></div></div>`);
    const relative = rectangle(fragment(result, "relative").borderRect);
    const owner = rectangle(fragment(result, "owner").paddingRect);
    for (const [id, x, y] of [
      ["automatic", relative.x, relative.y],
      ["horizontal", owner.x + 8, relative.y],
      ["vertical", relative.x, owner.y + 16],
      ["explicit", owner.x + 8, owner.y + 16],
    ]) {
      assert.deepEqual(rectangle(fragment(result, id).borderRect), { x, y, width: 8, height: 16 }, `${transform}: ${id}`);
    }
  }
});

test("aligned fixed static positions retain viewport paint and interaction geometry while scrolling", () => {
  const result = render(`<div style="display:grid;align-items:center;justify-items:center;width:240px;height:160px">
    <div style="width:80px;height:32px"><a id="fixed" href="/fixed" style="position:fixed;width:8px;height:16px">F</a>
      <a id="absolute" href="/absolute" style="position:absolute;margin-left:16px;width:8px;height:16px">A</a>
    </div></div><div style="height:1000px"></div>`, 40, 8);
  for (const scrollRow of [0, 2, 5]) {
    const scrolled = viewport(result, scrollRow);
    const fixed = node(result, "fixed");
    const expected = { row: scrollRow + 4, column: 10, width: 1, height: 1 };
    const command = scrolled.displayList.commands.find((value) => value.kind === "text" && value.text === "F");
    assert.ok(command);
    assert.equal(cssPixels(command.rect.y), expected.row * 16);
    assert.equal(scrolled.terminal.hitTestIndex.at(expected.row, expected.column)?.action.node, fixed);
    assert.deepEqual(scrolled.terminal.focusMap.forNode(fixed)?.rects[0], expected);
    assert.deepEqual(scrolled.terminal.accessibilityBounds.find((value) => value.documentNode === fixed)?.rect, expected);
    assert.equal(scrolled.terminal.hitTestIndex.regions.some((value) => value.action.node === node(result, "absolute")), scrollRow <= 4);
  }
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

test("scroll owners preserve flow, stop trapped extents, and retain unclipped content", () => {
  const result = render(`<style>#outer{height:64px;overflow:auto}#inner{height:32px;overflow:auto}p{height:32px}</style><div id=outer><div id=inner><p>A</p><p>B</p><p>C</p></div><p>D</p></div><article id=after>ARTICLE</article>`);
  const outer = result.layout.scrollContainer(fragment(result,"outer").id);
  const inner = result.layout.scrollContainer(fragment(result,"inner").id);
  assert.ok(outer && inner);
  assert.equal(cssPixels(outer.maxBlock), 0);
  assert.equal(cssPixels(inner.maxBlock), 64);
  assert.equal(inner.parent, outer.fragment);
  assert.equal(cssPixels(fragment(result,"after").borderRect.y), 64);
  const text = result.layout.forDocumentNode(node(result,"inner")).find(value => value.kind === "text");
  if (text) assert.equal(result.layout.scrollAncestor(text.id)?.fragment, inner.fragment);
});

test("paint containment clips descendants and establishes local fixed and stacking ownership", () => {
  const result = render(`<div style="height:32px"></div><div id=owner style="contain:paint;width:80px;height:32px"><div id=fixed style="position:fixed;top:0;height:16px">FIXED</div><div style="height:96px">CONTENT</div></div>`);
  const owner = fragment(result,"owner");
  const fixed = fragment(result,"fixed");
  assert.equal(result.layout.stacking(owner.id).establishesStackingContext,true);
  assert.equal(result.layout.scrollAttachmentParent(fixed.id)?.id,owner.id);
  assert.equal(cssPixels(fixed.borderRect.y),32);
  assert.equal(result.layout.scrollContainer(owner.id),null);
  assert.ok(result.layout.clipChain(owner.id).kind === "contain");
});

test("viewport overflow propagation keeps body out of nested owner indexes", () => {
  const result = render(`<style>body{overflow:hidden auto;height:32px}</style><div style="height:160px">Tall</div>`);
  assert.deepEqual(result.layout.viewportOverflow,{x:"hidden",y:"auto"});
  assert.equal(result.layout.scrollOwners.some(owner=>owner.documentNode===result.document.body),false);
  const overridden = render(`<style>html{overflow:clip}body{overflow:auto;height:32px}</style><div style="height:160px">Tall</div>`);
  assert.deepEqual(overridden.layout.viewportOverflow,{x:"hidden",y:"hidden"});
  assert.equal(overridden.layout.scrollOwners.some(owner=>owner.documentNode===overridden.document.body),true);
});

test("RTL owners expose negative reachable inline offsets and clip never owns scrolling", () => {
  const result = render(`<div id=rtl style="direction:rtl;width:64px;height:32px;overflow:auto"><div style="position:relative;left:-64px;width:128px;height:32px">wide</div></div><div id=clip style="width:64px;height:32px;overflow:clip"><div style="height:96px">tall</div></div>`);
  const owner = result.layout.scrollContainer(fragment(result,"rtl").id);
  assert.equal(cssPixels(owner.minInline),-64);
  assert.equal(owner.maxInline,0);
  assert.equal(result.layout.scrollContainer(fragment(result,"clip").id),null);
});

test("control intrinsic allocations honor HTML dimensions and CSS box sizing", () => {
  const result = render(`<textarea id=area rows=3 cols=10></textarea><input id=input size=5><textarea id=css rows=6 style="height:32px;box-sizing:border-box;border:1px solid"></textarea><input id=disabled disabled style="width:48px;height:32px">`);
  assert.equal(cssPixels(fragment(result,"area").contentRect.height),48);
  assert.equal(cssPixels(fragment(result,"area").contentRect.width),80);
  assert.equal(cssPixels(fragment(result,"input").contentRect.width),40);
  assert.equal(cssPixels(fragment(result,"css").borderRect.height),32);
  assert.equal(cssPixels(fragment(result,"disabled").contentRect.width),48);
});

test("nested scroll projection moves unclipped content while retaining control allocations and sibling flow", () => {
  const result = render(`<div id="scroller" style="width:160px;height:32px;overflow:auto"><div style="height:64px">TOP</div><input id="field" value="VALUE" style="width:120px;height:32px"><a id="last" href="/last">LAST</a></div><p id="article">ARTICLE</p>`);
  const owner = result.layout.scrollContainer(fragment(result, "scroller").id);
  assert.ok(owner);
  const spatial = buildDisplayListSpatialIndex(result.displayList);
  const list = buildViewportDisplayList({ documentDisplayList: result.displayList, spatialIndex: spatial,
    context: result.displayList.context, window: { scrollRow: 0, viewportRows: 24, overscanBefore: 0, overscanAfter: 0,
      scrollOffsets: [{ node: node(result, "scroller"), inline: 0, block: cssPx(64) }] } });
  const raster = rasterizeViewportDisplayList({ displayList: list });
  const terminal = buildViewportTerminalResult({ displayList: list, cellBuffer: raster.cellBuffer, documentGeometry: result.documentGeometry });
  const control = terminal.controls.find((entry) => entry.node === node(result, "field"));
  assert.ok(control, "offscreen unpainted controls are discovered after inner scrolling");
  assert.equal(control.allocation.row, 0);
  assert.equal(control.allocation.height, 2);
  assert.equal(control.visible.height, 2);
  assert.equal(fragment(result, "article").borderRect.y, cssPx(32));
  assert.ok(terminal.cellBuffer.rows.find((row) => row.row === 2)?.text.includes("ARTICLE"));
  assert.ok(terminal.focusMap.forNode(node(result, "field")));
});

test("textarea fallback retains separate bidi paragraphs and original value offsets", () => {
  const result = render(`<textarea id=t rows=3 cols=5>first\n\nthird</textarea>`);
  const control = fragment(result,"t");
  assert.deepEqual(control.controlLines.map(line=>line.text),["first","","third"]);
  assert.deepEqual(control.controlLines.map(line=>cssPixels(line.blockOffset)),[0,16,32]);
  assert.equal(control.visualClusters.length,0);
  assert.equal(control.controlLines[2].clusters[0].contentStartCodeUnit,7);
  const commands = result.displayList.commands.filter(command=>command.kind==="text" && command.layoutFragment===control.id);
  assert.deepEqual(commands.map(command=>command.text),["first","third"]);
  assert.equal(cssPixels(commands[1].rect.y-commands[0].rect.y),32);
});

test("non-atomic inline overflow and containment do not create box ownership", () => {
  const result = render(`<span id=t style="overflow:auto;contain:paint">inline content</span>`);
  const span = fragment(result,"t");
  assert.equal(result.layout.scrollContainer(span.id),null);
  assert.equal(result.layout.stacking(span.id).establishesStackingContext,false);
});

function projected(result, offsets = [], reveal) {
  const list = buildViewportDisplayList({documentDisplayList:result.displayList,spatialIndex:buildDisplayListSpatialIndex(result.displayList),context:result.displayList.context,
    window:{scrollRow:0,viewportRows:24,overscanBefore:0,overscanAfter:0,scrollOffsets:offsets,...(reveal===undefined?{}:{reveal})}});
  const raster = rasterizeViewportDisplayList({displayList:list});
  return {list,terminal:buildViewportTerminalResult({displayList:list,cellBuffer:raster.cellBuffer,documentGeometry:result.documentGeometry})};
}

test("semantic reveal traverses hidden inner and auto outer scroll owners", () => {
  const result = render(`<div id=outer style="height:64px;width:160px;overflow:auto"><div style="height:64px">OUTER TOP</div><div id=inner style="height:32px;overflow:hidden"><div style="height:64px">INNER TOP</div><input id=target style="width:80px;height:16px"></div><div style="height:32px">END</div></div><p id=article>ARTICLE</p>`);
  const reveal=projected(result,[],{node:node(result,"target"),blockAlign:"nearest"});
  assert.equal(reveal.list.window.scrollOffsets.length,2);
  const target=reveal.terminal.controls.find(control=>control.node===node(result,"target"));
  assert.ok(target);
  assert.ok(target.visible.row>=0&&target.visible.row<4);
  assert.equal(fragment(result,"article").borderRect.y,cssPx(64));
  assert.equal(reveal.terminal.scrollPorts.find(port=>port.node===node(result,"inner"))?.userScrollBlock,false);
});

test("nested sticky stays at its scrollport while viewport fixed escapes clipping and scrolling", () => {
  const result=render(`<div id=owner style="height:64px;width:160px;overflow:auto"><div style="height:32px">TOP</div><a id=sticky href=/sticky style="display:block;position:sticky;top:0;height:16px">STICKY</a><div style="height:128px">BOTTOM</div><input id=fixed style="position:fixed;top:96px;width:80px;height:16px"></div>`);
  const initial=projected(result);
  const moved=projected(result,[{node:node(result,"owner"),inline:0,block:cssPx(64)}]);
  const sticky=moved.terminal.focusMap.forNode(node(result,"sticky"));
  assert.ok(sticky,"sticky action remains a visible semantic candidate");
  assert.equal(sticky.rects[0].row,0);
  assert.deepEqual(moved.terminal.controls.find(control=>control.node===node(result,"fixed")),initial.terminal.controls.find(control=>control.node===node(result,"fixed")));
});

test("empty named anchor reveal retains its layout origin", () => {
  const result=render(`<div id=owner style="height:32px;overflow:auto"><div style="height:64px">top</div><a id=empty name=empty></a><div style="height:16px">end</div></div>`);
  const revealed=projected(result,[],{node:node(result,"empty"),blockAlign:"start"});
  assert.ok(revealed.list.window.scrollOffsets.length>0);
});

test("nested sticky descendants remain queried after the outer sticky leaves normal position", () => {
  const result=render(`<div style="height:320px"><div id=outer style="position:sticky;top:0;height:32px"><input id=inner style="position:sticky;top:0;width:80px;height:16px"></div></div>`);
  const list=buildViewportDisplayList({documentDisplayList:result.displayList,spatialIndex:buildDisplayListSpatialIndex(result.displayList),context:result.displayList.context,
    window:{scrollRow:8,viewportRows:8,overscanBefore:0,overscanAfter:0}});
  const raster=rasterizeViewportDisplayList({displayList:list});
  const terminal=buildViewportTerminalResult({displayList:list,cellBuffer:raster.cellBuffer,documentGeometry:result.documentGeometry});
  assert.ok(terminal.controls.find(control=>control.node===node(result,"inner")),"nested sticky empty control remains allocated");
});

test("two-axis nested reveal shares paint, focus and full versus clipped control geometry", () => {
  const result=render(`<div id=outer style="width:64px;height:64px;overflow:auto"><div id=inner style="width:128px;height:128px;overflow:auto"><div style="position:relative;left:192px;top:192px;width:32px;height:32px"><input id=target value=XY style="width:32px;height:32px"></div></div></div><p id=after>AFTER</p>`);
  const shown=projected(result,[],{node:node(result,"target"),blockAlign:"nearest"});
  const offsets=shown.list.window.scrollOffsets;
  assert.equal(offsets.length,2);
  assert.ok(offsets.every(offset=>offset.inline>0&&offset.block>0));
  const control=shown.terminal.controls.find(entry=>entry.node===node(result,"target"));
  assert.ok(control);
  assert.equal(control.allocation.width,4);
  assert.equal(control.allocation.height,2);
  assert.deepEqual(shown.terminal.focusMap.forNode(node(result,"target")).rects[0],control.visible);
  assert.equal(fragment(result,"after").borderRect.y,cssPx(64));
  const partially=projected(result,offsets.map(offset=>offset.node===node(result,"inner")?{...offset,block:offset.block-16*64}:offset));
  const clipped=partially.terminal.controls.find(entry=>entry.node===node(result,"target"));
  assert.ok(clipped);
  assert.equal(clipped.allocation.height,2);
  assert.equal(clipped.visible.height,1);
});

test("scroll and containment clips do not cut their own border chrome", () => {
  for (const policy of ["overflow:hidden","contain:paint"]) {
    const result=render(`<div id=box style="${policy};width:64px;height:32px;border:8px solid;background:red">TEXT</div>`);
    const shown=projected(result);
    const box=fragment(result,"box");
    const border=shown.list.commands.find(command=>command.layoutFragment===box.id&&command.kind==="border-side");
    assert.ok(border);
    assert.ok(border.clipRect.x<=box.borderRect.x);
    assert.ok(border.clipRect.y<=box.borderRect.y);
    assert.ok(border.clipRect.width>=box.borderRect.width);
  }
});

test("trapped descendant overflow does not inflate the root scroll extent", () => {
  const result=render(`<div id=owner style="height:32px;overflow:auto"><div style="height:1600px">tall</div></div><p style="height:32px">AFTER</p>`,80,4);
  assert.equal(cssPixels(result.layout.scrollExtent.height),64);
  assert.equal(cssPixels(result.documentGeometry.documentExtent.height),64);
  assert.equal(cssPixels(result.layout.scrollOwners[0].maxBlock),1568);
});

test("removed and resized scroll owners reconcile controlled offsets without retaining obsolete identities", () => {
  const initial=render(`<div id=owner style="height:32px;overflow:auto"><div style="height:160px">tall</div></div>`);
  const prior=projected(initial,[{node:node(initial,"owner"),inline:0,block:cssPx(128)}]);
  const resized=render(`<div id=owner style="height:128px;overflow:auto"><div style="height:160px">tall</div></div>`);
  const next=projected(resized,prior.list.window.scrollOffsets);
  assert.equal(next.list.window.scrollOffsets[0].block,cssPx(32));
  const removed=render(`<div id=owner style="height:128px;overflow:clip"><div style="height:160px">tall</div></div>`);
  assert.deepEqual(projected(removed,next.list.window.scrollOffsets).list.window.scrollOffsets,[]);
});

test("scroll hit ports follow CSS paint order with deepest owners after their parent", () => {
  const result=render(`<div id=high style="position:absolute;z-index:2;top:0;width:96px;height:64px;overflow:auto"><div id=deep style="height:32px;overflow:auto"><div style="height:96px">D</div></div></div><div id=low style="position:absolute;z-index:1;top:0;width:96px;height:64px;overflow:auto"><div style="height:96px">L</div></div>`);
  const ports=projected(result).terminal.scrollPorts.map(port=>port.node);
  assert.ok(ports.indexOf(node(result,"low"))<ports.indexOf(node(result,"high")));
  assert.ok(ports.indexOf(node(result,"high"))<ports.indexOf(node(result,"deep")));
});

test("many offscreen owners keep viewport queries bounded and preserve retained layout identity", () => {
  const result=render(Array.from({length:300},(_,index)=>`<div style="height:32px;overflow:auto"><input value="${index}" style="height:16px"><div style="height:96px">MORE</div></div>`).join(""),80,4);
  const spatial=buildDisplayListSpatialIndex(result.displayList);
  const list=buildViewportDisplayList({documentDisplayList:result.displayList,spatialIndex:spatial,context:result.displayList.context,
    window:{scrollRow:100,viewportRows:4,overscanBefore:0,overscanAfter:0}});
  assert.equal(list.documentDisplayList,result.displayList);
  assert.equal(list.documentDisplayList.layout,result.layout);
  assert.ok(list.spatialQuery.visitedIntervals<100,String(list.spatialQuery.visitedIntervals));
  const raster=rasterizeViewportDisplayList({displayList:list});
  const terminal=buildViewportTerminalResult({displayList:list,cellBuffer:raster.cellBuffer,documentGeometry:result.documentGeometry});
  assert.ok(terminal.controls.length<=2);
  assert.ok(terminal.scrollPorts.length<=2);
});

test("containment on html or body disables body overflow propagation",()=>{
  for (const selector of ["html","body"]) {
    const result=render(`<style>${selector}{contain:paint}body{overflow:hidden;height:32px}</style><div style="height:160px">TALL</div>`);
    assert.deepEqual(result.layout.viewportOverflow,{x:"auto",y:"auto"});
    assert.ok(result.layout.scrollOwners.some(owner=>owner.documentNode===result.document.body));
  }
});

test("nearest reveal does not move an oversized target already spanning the scrollport",()=>{
  const result=render(`<div id=owner style="height:64px;overflow:auto"><div id=large style="height:192px">LARGE</div></div>`);
  const offset={node:node(result,"owner"),inline:0,block:cssPx(64)};
  const revealed=projected(result,[offset],{node:node(result,"large"),blockAlign:"nearest"});
  assert.deepEqual(revealed.list.window.scrollOffsets,[offset]);
});

test("accessibility geometry budget caps rectangles rather than semantic entry count",()=>{
  const result=render(`<div role=region aria-label=Region>${Array.from({length:30},(_,i)=>`<span>${i} WORD </span>`).join("")}</div>`,10,8);
  const geometry=buildDocumentGeometryIndex({...result.displayList,context:{...result.displayList.context,budgets:{maxRetainedAccessibilityRectangles:3}}});
  assert.ok(geometry.accessibility.reduce((count,entry)=>count+Math.max(1,entry.rects.length),0)<=3);
  assert.ok(geometry.truncations.some(entry=>entry.budget==="maxRetainedAccessibilityRectangles"));
});

test("paint containment contains floats and child margins while overflow clip alone does not establish a formatting context",()=>{
  const contained=render(`<div id=parent style="contain:paint"><div style="float:left;width:32px;height:64px">FLOAT</div></div><p id=after>AFTER</p>`);
  assert.equal(cssPixels(fragment(contained,"parent").contentRect.height),64);
  assert.equal(cssPixels(fragment(contained,"after").borderRect.y),64);
  const clipped=render(`<div id=parent style="overflow:clip"><div style="float:left;width:32px;height:64px">FLOAT</div></div><p id=after>AFTER</p>`);
  assert.equal(cssPixels(fragment(clipped,"parent").contentRect.height),0);
  const margins=render(`<div style="height:16px"></div><div id=parent style="contain:paint"><p id=child style="margin-top:32px;height:16px">CHILD</p></div>`);
  assert.equal(cssPixels(fragment(margins,"child").borderRect.y-fragment(margins,"parent").borderRect.y),32);
});

test("a standalone relatively positioned control participates in the shared final geometry pass",()=>{
  const result=render(`<input id=t style="position:relative;left:32px;top:16px;width:32px;height:16px">`);
  const control=fragment(result,"t");
  assert.equal(cssPixels(control.borderRect.x),32);
  assert.equal(cssPixels(control.borderRect.y),16);
  const geometry=projected(result).terminal.controls.find(entry=>entry.node===node(result,"t"));
  assert.equal(geometry.allocation.column,4);
  assert.equal(geometry.allocation.row,1);
});

test("scrollable content retains end padding at the reachable scroll boundary",()=>{
  const result=render(`<div id=t style="height:32px;padding:8px;overflow:auto"><div style="height:96px">TALL</div></div>`);
  const owner=result.layout.scrollContainer(fragment(result,"t").id);
  assert.equal(cssPixels(owner.maxBlock),64);
});

test("absolute and fixed controls finalize physical insets after bidi line alignment",()=>{
  for (const direction of ["ltr","rtl"]) for (const position of ["absolute","fixed"]) {
    for (const [inset,expected] of [["left:-640px",-640],["right:16px",536]]) {
      const result=render(`<html dir=${direction}><style>body{margin:0}input{position:${position};${inset};top:0;width:80px}</style><input id=t value=alpha>`,79,24);
      assert.equal(cssPixels(fragment(result,"t").borderRect.x),expected,`${direction}/${position}/${inset}`);
    }
  }
});

for (const [label,fixture,expectedOwner] of [
  ["viewport-fixed",`<div id=scroller style="overflow:auto;height:64px"><a id=target href=/target style="position:fixed;top:0">TARGET</a><div style="height:512px">CONTENT</div></div>`,null],
  ["absolute escaping intermediate overflow",`<main style="position:relative"><div id=scroller style="overflow:auto;height:64px"><a id=target href=/target style="position:absolute;top:0">TARGET</a><div style="height:512px">CONTENT</div></div></main>`,null],
  ["absolute owned by positioned scroller",`<div id=scroller style="position:relative;overflow:auto;height:64px"><a id=target href=/target style="position:absolute;top:0">TARGET</a><div style="height:512px">CONTENT</div></div>`,"scroller"],
  ["normal nested",`<div id=outer style="overflow:auto;height:128px"><div id=scroller style="overflow:auto;height:64px"><a id=target href=/target>TARGET</a><div style="height:512px">CONTENT</div></div><div style="height:512px">OUTER</div></div>`,"scroller"],
  ["focused scroll container",`<a id=target href=/target style="display:block;overflow:auto;height:64px"><div style="height:512px">CONTENT</div></a>`,"target"],
]) {
  test(`keyboard scroll uses accepted layout ownership: ${label}`,()=>{
    const result=render(`${fixture}<div style="height:2048px">ROOT</div>`);
    const shown=projected(result);
    const target=node(result,"target");
    const owner=expectedOwner===null?null:node(result,expectedOwner);
    assert.equal(result.documentGeometry.focusForNode(target).scrollOwner,owner);
    assert.equal(shown.terminal.focusMap.forNode(target).scrollOwner,owner);
    for (const visible of [true,false]) {
      const initial={scrollOffsets:[],scrollAnchor:{source:null,rowOffset:0},scrollColumn:0,
        documentState:{focus:target},snapshot:{document:result.document},rendering:{pendingReveal:null,pendingFocus:null,
          summary:{documentRowCount:200,scrollAnchors:[],focusOrder:result.documentGeometry.focusOrder},
          viewport:{focusTargets:visible?shown.terminal.focusMap.targets:[],scrollPorts:shown.terminal.scrollPorts,
            cellInline:cssPx(8),cellBlock:cssPx(16),viewportOverflow:result.layout.viewportOverflow,minScrollColumn:0,maxScrollColumn:0}}};
      const updated=scrollDocument(initial,1,0,24);
      assert.equal(updated.scrollAnchor.rowOffset,owner===null?1:0,visible?"visible focus":"summary focus");
      assert.deepEqual(updated.scrollOffsets,owner===null?[]:[{node:owner,inline:0,block:cssPx(16)}]);
    }
  });
}

test("block-start root reveal keeps visible indentation and minimally reveals offscreen targets", () => {
  for (const [left, expectedColumn] of [[64, 0], [480, 30]]) {
    const result = render(`<main style="width:1000px;height:1600px"><div id=target style="position:absolute;left:${left}px;top:640px;width:80px;height:32px">TARGET</div></main>`, 40, 24);
    const shown = projected(result, [], { node: node(result, "target"), blockAlign: "start" });
    assert.equal(shown.list.window.scrollRow, 40);
    assert.equal(shown.list.window.scrollColumn, expectedColumn);
    assert.match(shown.terminal.cellBuffer.rows.map((row) => row.text).join("\n"), /TARGET/);
  }
});

test("block-start nested reveal uses inline nearest for visible, offscreen, and RTL targets", () => {
  for (const [direction, left, expectedInline] of [["ltr", 80, 0], ["ltr", 240, 128], ["rtl", -160, -160]]) {
    const result = render(`<div id=owner style="direction:${direction};margin-left:32px;width:160px;height:64px;overflow:auto"><div style="height:64px">TOP</div><div id=target style="position:relative;left:${left}px;width:48px;height:32px">TARGET</div><div style="height:128px">END</div></div>`);
    const shown = projected(result, [], { node: node(result, "target"), blockAlign: "start" });
    const offset = shown.list.window.scrollOffsets.find((entry) => entry.node === node(result, "owner"));
    assert.ok(offset);
    assert.equal(cssPixels(offset.inline), expectedInline, direction);
    assert.equal(cssPixels(offset.block), 64, direction);
    assert.equal(shown.list.window.scrollColumn, 0, direction);
  }
});

test("block-start reveal preserves inline position when oversized targets span root or nested ports", () => {
  const root = render(`<div id=target style="width:800px;height:640px">WIDE</div>`, 40, 24);
  const shown = buildViewportDisplayList({ documentDisplayList: root.displayList,
    spatialIndex: buildDisplayListSpatialIndex(root.displayList), context: root.displayList.context,
    window: { scrollRow: 5, scrollColumn: 10, viewportRows: 24, overscanBefore: 0, overscanAfter: 0,
      reveal: { node: node(root, "target"), blockAlign: "start" } } });
  assert.equal(shown.window.scrollColumn, 10);
  assert.equal(shown.window.scrollRow, 0);
  const nested = render(`<div id=owner style="width:160px;height:64px;overflow:auto"><div id=target style="width:480px;height:320px">WIDE</div></div>`);
  const offset = { node: node(nested, "owner"), inline: cssPx(80), block: cssPx(64) };
  const revealed = projected(nested, [offset], { node: node(nested, "target"), blockAlign: "start" });
  assert.deepEqual(revealed.list.window.scrollOffsets, [{ ...offset, block: 0 }]);
});

test("source-owned reveal ignores generated marker and pseudo boxes before the principal fragment", async () => {
  const { revealDocumentNode } = await import("../../dist/presentation/terminal/viewport-geometry.js");
  for (const html of [
    `<ol style="margin:0;padding-left:64px"><li id=target style="height:32px">SOURCE</li></ol>`,
    `<style>#target::before{content:'GENERATED';display:block;position:relative;left:480px;top:64px;width:80px;height:32px}</style><div id=target style="margin-left:64px;width:160px;height:96px">SOURCE</div>`,
  ]) {
    const result = render(html, 40, 24);
    const target = node(result, "target");
    const fragments = result.layout.forDocumentNode(target);
    const principal = fragments.find((entry) => entry.kind !== "text" && entry.pseudoElement === null
      && result.formatting.node(entry.formattingNode).appliesBoxStyle);
    assert.ok(principal);
    assert.notEqual(fragments.find((entry) => entry.kind !== "text"), principal, "generated fragment precedes source box");
    const revealed = revealDocumentNode(result.layout, result.layout.context.scrollport, [], target, "start");
    assert.deepEqual(revealed.rect, principal.borderRect);
    assert.equal(projected(result, [], { node: target, blockAlign: "start" }).list.window.scrollColumn, 0);
  }
});

test("boxless reveal follows rendered descendants and inline reveal retains continuation bounds", async () => {
  const { revealDocumentNode } = await import("../../dist/presentation/terminal/viewport-geometry.js");
  const contents = render(`<div id=owner style="height:64px;overflow:auto"><div style="height:96px">TOP</div><div id=contents style="display:contents"><span hidden>HIDDEN</span><a id=child href=/child style="display:block;height:32px">CHILD</a></div><div style="height:160px">END</div></div>`);
  const shown = projected(contents, [], { node: node(contents, "contents"), blockAlign: "start" });
  assert.equal(cssPixels(shown.list.window.scrollOffsets[0].block), 96);
  assert.ok(shown.terminal.focusMap.forNode(node(contents, "child")));
  const inline = render(`<p style="width:48px"><a id=inline href=/target>abcd efgh ijkl</a></p>`);
  const source = fragment(inline, "inline");
  assert.ok(source.inlineContinuations.length > 1);
  const revealed = revealDocumentNode(inline.layout, inline.layout.context.scrollport, [], node(inline, "inline"), "start");
  assert.deepEqual(revealed.rect, source.borderRect);
});

test("fractional block-start reveal retains the first painted target line", () => {
  const result = render(`<main style="height:1600px"><div id=target style="position:absolute;left:64px;top:640.25px;width:128px;height:32px">FIRST LINE</div></main>`, 40, 24);
  const shown = projected(result, [], { node: node(result, "target"), blockAlign: "start" });
  assert.equal(shown.list.window.scrollRow, 40);
  assert.equal(shown.list.window.scrollColumn, 0);
  const first = shown.terminal.cellBuffer.rows.find((row) => row.row === shown.list.window.scrollRow);
  assert.match(first?.text ?? "", /FIRST LINE/);
  assert.ok(shown.list.viewportRect.y <= fragment(result, "target").borderRect.y);
});

test("document reveal cancellation covers boxless descent and large inline continuation bounds", async () => {
  const { revealDocumentNode } = await import("../../dist/presentation/terminal/viewport-geometry.js");
  const hidden = render(`<div id=target style="display:contents;visibility:hidden">${"<span>hidden</span>".repeat(600)}<span style="visibility:visible">VISIBLE</span></div>`);
  const aborted = new globalThis.DOMException("reveal cancelled", "AbortError");
  let traversals = 0;
  const signal = { throwIfAborted() { traversals += 1; if (traversals === 200) throw aborted; } };
  assert.throws(() => buildViewportDisplayList({ documentDisplayList: hidden.displayList,
    spatialIndex: buildDisplayListSpatialIndex(hidden.displayList), context: hidden.displayList.context, signal,
    window: { scrollRow: 0, viewportRows: 24, overscanBefore: 0, overscanAfter: 0,
      reveal: { node: node(hidden, "target"), blockAlign: "start" } } }), (error) => error === aborted);
  assert.equal(traversals, 200);

  const inline = render(`<p style="width:16px"><a id=target href=/target>${"ab ".repeat(600)}</a></p>`);
  assert.ok(fragment(inline, "target").inlineContinuations.length > 512);
  let checks = 0;
  revealDocumentNode(inline.layout, inline.layout.context.scrollport, [], node(inline, "target"), "start",
    { throwIfAborted() { checks += 1; } });
  assert.ok(checks >= 5);
  let cancelledChecks = 0;
  assert.throws(() => revealDocumentNode(inline.layout, inline.layout.context.scrollport, [], node(inline, "target"), "start",
    { throwIfAborted() { cancelledChecks += 1; if (cancelledChecks === checks) throw aborted; } }), (error) => error === aborted);
  assert.equal(cancelledChecks, checks, "late continuation accumulation remains cancellable");
});

test("boxless reveal skips display-none subtrees but retains visible descendants of hidden ancestors", async () => {
  const { revealDocumentNode } = await import("../../dist/presentation/terminal/viewport-geometry.js");
  const result = render(`<div id=target style="display:contents;visibility:hidden"><div style="display:none">${"<span>suppressed</span>".repeat(600)}</div><span id=visible style="visibility:visible">VISIBLE</span></div>`);
  let checks = 0;
  const revealed = revealDocumentNode(result.layout, result.layout.context.scrollport, [], node(result, "target"), "start",
    { throwIfAborted() { checks += 1; } });
  assert.ok(checks < 20, "display:none descendants are skipped as a subtree");
  assert.deepEqual(revealed.rect, fragment(result, "visible").borderRect);
});
