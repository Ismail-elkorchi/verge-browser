import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import {
  CSS_FIXED_SCALE,
  buildLayoutFragmentTree,
  cssCoordinate,
  cssLengthFromFixed,
  cssPixels,
  cssPx,
  cssRect
} from "../../dist/presentation/layout/index.js";
import { buildTextSearchIndex } from "../../dist/presentation/search/index.js";
import { resolveStyles } from "../../dist/presentation/style/index.js";
import {
  buildTerminalDisplayList,
  rasterizeTerminalDisplayList
} from "../../dist/presentation/terminal/index.js";
import {
  terminalCellMeasurer,
  terminalCssTextMeasurer
} from "../../dist/ui/terminal-measure.js";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);
const ZERO = cssPx(0);

function media(columns, rows) {
  return {
    viewportWidthCssPx: columns * 8,
    viewportHeightCssPx: rows * 16,
    mediaType: "screen",
    prefersColorScheme: "dark",
    reducedMotion: false,
    hover: "hover",
    pointer: "fine"
  };
}

function formatting(html, columns = 80, rows = 24, formattingBudgets) {
  const document = parseWebDocument(html, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const state = createDocumentState(document);
  const styles = resolveStyles({ document, state, resources: [], environment: media(columns, rows) });
  return buildFormattingTree({
    document,
    state,
    styles,
    ...(formattingBudgets === undefined ? {} : { budgets: formattingBudgets })
  });
}

function renderFormatting(formattingTree, columns, rows = 24, budgets = {}, capabilities = {}) {
  const textMeasurer = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);
  const searchIndex = buildTextSearchIndex(formattingTree);
  const layout = buildLayoutFragmentTree({
    formatting: formattingTree,
    searchIndex,
    context: {
      viewport: {
        width: cssLengthFromFixed(columns * CELL_WIDTH),
        height: cssLengthFromFixed(rows * ROW_HEIGHT)
      },
      rootFontMetrics: textMeasurer.defaultFontMetrics(),
      textMeasurer,
      initialContainingBlock: cssRect(
        cssCoordinate(ZERO),
        cssCoordinate(ZERO),
        cssLengthFromFixed(columns * CELL_WIDTH),
        cssLengthFromFixed(rows * ROW_HEIGHT)
      ),
      ...(budgets.layout === undefined ? {} : { budgets: budgets.layout })
    }
  });
  const context = {
    columns,
    rows,
    cellWidthCssPx: CELL_WIDTH,
    rowHeightCssPx: ROW_HEIGHT,
    unicode: capabilities.unicode ?? true,
    ambiguousWidth: capabilities.ambiguousWidth ?? 1,
    colorDepth: capabilities.colorDepth ?? 24,
    cellMeasurer: terminalCellMeasurer(capabilities.ambiguousWidth ?? 1),
    ...(budgets.terminal === undefined ? {} : { budgets: budgets.terminal })
  };
  const displayList = buildTerminalDisplayList({ layout, context });
  const terminal = rasterizeTerminalDisplayList({ displayList });
  return { formatting: formattingTree, searchIndex, layout, displayList, terminal };
}

function render(html, columns = 80, rows = 24, budgets = {}, capabilities = {}) {
  return renderFormatting(formatting(html, columns, rows), columns, rows, budgets, capabilities);
}

function elementById(result, id) {
  const node = result.formatting.document.elementById(id);
  assert.ok(node, `Missing #${id}`);
  return node;
}

function principalFragment(result, node) {
  const fragment = result.layout.forDocumentNode(node)
    .find((candidate) => candidate.kind === "box" && candidate.borderRect.width > 0);
  assert.ok(fragment, `Missing layout fragment for ${node}`);
  return fragment;
}

function renderedText(result) {
  return result.terminal.cellBuffer.rows.map((row) => row.text).join("\n");
}

function reachableFragments(layout) {
  const reached = new Set();
  const pending = [layout.root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reached.has(id)) continue;
    reached.add(id);
    pending.push(...layout.fragment(id).children);
  }
  return reached;
}

function layoutPayload(layout) {
  return [...reachableFragments(layout)].map((id) => {
    const fragment = layout.fragment(id);
    return {
      id,
      kind: fragment.kind,
      formattingNode: fragment.formattingNode,
      contentRect: fragment.contentRect,
      children: fragment.children
    };
  });
}

test("the rendering stages expose immutable fixed-point contracts", () => {
  const result = render("<p><a href='/next'>immutable link</a></p>", 30);
  assert.equal(CSS_FIXED_SCALE, 64);
  assert.equal(Object.isFrozen(result.layout), true);
  assert.equal(Object.isFrozen(result.layout.context.viewport), true);
  assert.equal(Object.isFrozen(result.layout.fragment(result.layout.root)), true);
  assert.equal(Object.isFrozen(result.layout.lineBoxes), true);
  assert.equal(Object.isFrozen(result.displayList), true);
  assert.equal(Object.isFrozen(result.displayList.commands), true);
  assert.equal(Object.isFrozen(result.terminal.cellBuffer), true);
  assert.equal(Object.isFrozen(result.terminal.cellBuffer.rows), true);
  assert.equal(result.layout.outcome.status, "complete");
  assert.equal(result.displayList.outcome.status, "complete");
  assert.equal(result.terminal.cellBuffer.outcome.status, "complete");
});

test("fixed-point arithmetic saturates and invalid layout inputs are rejected by typed outcomes", () => {
  assert.equal(cssLengthFromFixed(Number.MAX_SAFE_INTEGER * 2), Number.MAX_SAFE_INTEGER);
  assert.throws(() => cssPx(Number.POSITIVE_INFINITY), RangeError);
  const tree = formatting(`<p>text</p>`, 20);
  const textMeasurer = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);
  const context = {
    viewport: { width: cssPx(160), height: cssPx(160) },
    rootFontMetrics: textMeasurer.defaultFontMetrics(),
    textMeasurer,
    initialContainingBlock: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), cssPx(160), cssPx(160))
  };
  const invalidContext = buildLayoutFragmentTree({
    formatting: tree,
    searchIndex: buildTextSearchIndex(tree),
    context: { ...context, viewport: { width: ZERO, height: cssPx(160) } }
  });
  assert.deepEqual(invalidContext.outcome, { status: "rejected", reason: "invalid-context" });
  const invalidMeasurement = buildLayoutFragmentTree({
    formatting: tree,
    searchIndex: buildTextSearchIndex(tree),
    context: {
      ...context,
      textMeasurer: { ...textMeasurer, measure() { throw new RangeError("invalid metric"); } }
    }
  });
  assert.deepEqual(invalidMeasurement.outcome, { status: "rejected", reason: "invalid-fixed-point-input" });
});

test("standards-derived layout cases pin WPT provenance and license", () => {
  const provenance = JSON.parse(readFileSync(
    new URL("../fixtures/wpt-layout-provenance.json", import.meta.url),
    "utf8"
  ));
  assert.match(provenance.commit, /^[0-9a-f]{40}$/u);
  assert.match(provenance.license, /BSD/u);
  assert.ok(provenance.adaptations.length >= 18);
  assert.ok(provenance.adaptations.every((entry) =>
    entry.source && entry.behavior && entry.terminalAdjustment && /BSD/u.test(entry.license)
  ));
});

test("nested percentages retain CSS-pixel precision until cell rasterization", () => {
  const result = render(`<div id="outer" style="width:75%"><div id="inner" style="width:33.333%">x</div></div>`, 37);
  const outer = principalFragment(result, elementById(result, "outer"));
  const inner = principalFragment(result, elementById(result, "inner"));
  assert.equal(cssPixels(outer.contentRect.width), 222);
  assert.ok(Math.abs(cssPixels(inner.contentRect.width) - 73.984375) <= 1 / CSS_FIXED_SCALE);
  assert.notEqual(inner.contentRect.width % CELL_WIDTH, 0);
});

test("content-box and border-box retain distinct content, padding, and border rectangles", () => {
  const result = render(`<style>.x{width:10ch;padding:1ch;border:solid 8px}</style>
    <div id="content" class="x">a</div><div id="border" class="x" style="box-sizing:border-box">b</div>`, 40);
  const content = principalFragment(result, elementById(result, "content"));
  const border = principalFragment(result, elementById(result, "border"));
  assert.equal(cssPixels(content.contentRect.width), 80);
  assert.equal(cssPixels(content.paddingRect.width), 96);
  assert.equal(cssPixels(content.borderRect.width), 112);
  assert.equal(cssPixels(border.borderRect.width), 80);
  assert.equal(cssPixels(border.contentRect.width), 48);
});

test("automatic horizontal margins and negative margins resolve as used values", () => {
  const centered = render(`<div id="box" style="width:10ch;margin-inline:auto">center</div>`, 20);
  const centeredBox = principalFragment(centered, elementById(centered, "box"));
  assert.equal(cssPixels(centeredBox.borderRect.x), 40);
  const negative = render(`<div id="one" style="height:1em;margin-bottom:-8px">one</div><div id="two">two</div>`, 20);
  const one = principalFragment(negative, elementById(negative, "one"));
  const two = principalFragment(negative, elementById(negative, "two"));
  assert.ok(two.borderRect.y < one.borderRect.y + one.borderRect.height);
});

test("over-constrained block widths resolve automatic margins before the inline-end margin", () => {
  const result = render(`<div id="parent" style="width:10ch"><div id="child"
    style="width:12ch;margin-inline:auto">wide</div></div>`, 20);
  const parent = principalFragment(result, elementById(result, "parent"));
  const child = principalFragment(result, elementById(result, "child"));
  assert.equal(child.borderRect.x, parent.contentRect.x);
  assert.equal(child.marginRect.x, parent.contentRect.x);
  assert.equal(child.marginRect.width, parent.contentRect.width);
  assert.ok(child.borderRect.width > parent.contentRect.width);
});

test("min/max constraints recompute content width and height", () => {
  const result = render(`<div id="min" style="width:2ch;min-width:6ch">min</div>
    <div id="max" style="width:12ch;max-width:5ch;height:5em;max-height:2em">max</div>`, 30);
  assert.equal(cssPixels(principalFragment(result, elementById(result, "min")).contentRect.width), 48);
  const maximum = principalFragment(result, elementById(result, "max"));
  assert.equal(cssPixels(maximum.contentRect.width), 40);
  assert.equal(cssPixels(maximum.contentRect.height), 32);
});

test("percentage heights require a definite containing height", () => {
  const indefinite = render(`<div><div id="child" style="height:50%">line</div></div>`, 20);
  const definite = render(`<div style="height:100px"><div id="child" style="height:50%">line</div></div>`, 20);
  assert.equal(cssPixels(principalFragment(indefinite, elementById(indefinite, "child")).contentRect.height), 16);
  assert.equal(cssPixels(principalFragment(definite, elementById(definite, "child")).contentRect.height), 50);
});

test("vertical percentage padding and margins resolve against containing-block width", () => {
  const result = render(`<div id="box" style="width:100px;padding-top:10%">x</div>
    <div id="parent" style="width:100px;padding-top:1px"><div id="child" style="margin-top:10%">y</div></div>`, 25);
  const box = principalFragment(result, elementById(result, "box"));
  const parent = principalFragment(result, elementById(result, "parent"));
  const child = principalFragment(result, elementById(result, "child"));
  assert.equal(cssPixels(box.contentRect.y - box.paddingRect.y), 20);
  assert.equal(cssPixels(child.borderRect.y - parent.contentRect.y), 10);
});

test("normal flow collapses adjoining sibling and parent margins", () => {
  const result = render(`<div id="parent"><div id="a" style="height:16px;margin:16px 0 24px">a</div>
    <div id="b" style="height:16px;margin-top:8px">b</div></div>`, 30);
  const parent = principalFragment(result, elementById(result, "parent"));
  const a = principalFragment(result, elementById(result, "a"));
  const b = principalFragment(result, elementById(result, "b"));
  assert.equal(a.borderRect.y, parent.contentRect.y);
  assert.equal(cssPixels(b.borderRect.y - (a.borderRect.y + a.borderRect.height)), 24);
});

test("parent first-child and last-child margins collapse outside the parent", () => {
  const result = render(`<div id="before" style="height:10px"></div><div id="parent"><div id="child"
    style="height:10px;margin-top:20px;margin-bottom:30px"></div></div><div id="after"
    style="height:10px"></div>`, 30);
  const before = principalFragment(result, elementById(result, "before"));
  const parent = principalFragment(result, elementById(result, "parent"));
  const child = principalFragment(result, elementById(result, "child"));
  const after = principalFragment(result, elementById(result, "after"));
  assert.equal(cssPixels(parent.borderRect.y - (before.borderRect.y + before.borderRect.height)), 20);
  assert.equal(child.borderRect.y, parent.contentRect.y);
  assert.equal(parent.borderRect.height, child.borderRect.height);
  assert.equal(cssPixels(after.borderRect.y - (parent.borderRect.y + parent.borderRect.height)), 30);
});

test("positive and negative margins collapse through an empty block", () => {
  const result = render(`<div id="before" style="height:10px;margin-bottom:10px"></div><div id="empty"
    style="margin-top:20px;margin-bottom:-5px"></div><div id="after"
    style="height:10px;margin-top:15px"></div>`, 30);
  const before = principalFragment(result, elementById(result, "before"));
  const empty = principalFragment(result, elementById(result, "empty"));
  const after = principalFragment(result, elementById(result, "after"));
  assert.equal(empty.borderRect.height, ZERO);
  assert.equal(cssPixels(after.borderRect.y - (before.borderRect.y + before.borderRect.height)), 15);
});

test("padding and borders stop parent-child margin collapse", () => {
  const result = render(`<div id="padding" style="padding-top:8px"><div id="a"
    style="margin-top:16px">a</div></div><div id="border" style="border-style:solid;border-top-width:4px"><div id="b"
    style="margin-top:16px">b</div></div>`, 30);
  const padding = principalFragment(result, elementById(result, "padding"));
  const a = principalFragment(result, elementById(result, "a"));
  const border = principalFragment(result, elementById(result, "border"));
  const b = principalFragment(result, elementById(result, "b"));
  assert.equal(cssPixels(a.borderRect.y - padding.contentRect.y), 16);
  assert.equal(cssPixels(b.borderRect.y - border.contentRect.y), 16);
});

test("overflow formatting-context boundaries prevent parent margin collapse", () => {
  const result = render(`<div id="parent" style="overflow:hidden"><div id="child" style="margin-top:16px">x</div></div>`, 20);
  const parent = principalFragment(result, elementById(result, "parent"));
  const child = principalFragment(result, elementById(result, "child"));
  assert.equal(cssPixels(child.borderRect.y - parent.contentRect.y), 16);
});

test("inline formatting creates explicit line boxes with source-linked text fragments", () => {
  const result = render(`<p id="p">alpha beta gamma delta</p>`, 8);
  const paragraph = principalFragment(result, elementById(result, "p"));
  assert.ok(paragraph.lineBoxes.length >= 3);
  assert.ok(paragraph.lineBoxes.every((line) => line.rect.height > 0 && line.baseline >= line.rect.y));
  assert.ok(paragraph.lineBoxes.flatMap((line) => line.textFragments)
    .every((id) => result.layout.fragment(id).sourceRange !== null));
});

test("line boxes calculate ascent, descent, height, baseline, and vertical alignment", () => {
  const result = render(`<p id="p"><span style="font-size:12px">small</span>
    <span style="font-size:24px;vertical-align:super;line-height:32px">large</span></p>`, 40);
  const line = principalFragment(result, elementById(result, "p")).lineBoxes[0];
  assert.ok(line);
  assert.ok(cssPixels(line.ascent) >= 18);
  assert.ok(cssPixels(line.descent) >= 4);
  assert.ok(cssPixels(line.rect.height) >= 32);
  assert.equal(line.baseline, line.rect.y + line.ascent);
  const compact = render(`<p id="p" style="font-size:8px;line-height:10px">small</p>`, 20);
  const compactLine = principalFragment(compact, elementById(compact, "p")).lineBoxes[0];
  assert.ok(compactLine);
  assert.equal(cssPixels(compactLine.rect.height), 10);
  assert.equal(cssPixels(compactLine.baseline - compactLine.rect.y), 7);
});

test("text alignment is resolved independently for each line box", () => {
  const result = render(`<p id="p" style="width:6ch;text-align:right">aa bb cc</p>`, 20);
  const paragraph = principalFragment(result, elementById(result, "p"));
  assert.equal(paragraph.lineBoxes.length, 2);
  const inlineOffset = (line) => Math.min(...line.textFragments.map(
    (fragment) => result.layout.fragment(fragment).contentRect.x - paragraph.contentRect.x
  ));
  assert.equal(cssPixels(inlineOffset(paragraph.lineBoxes[0])), 8);
  assert.equal(cssPixels(inlineOffset(paragraph.lineBoxes[1])), 32);
});

test("text indentation affects the first line but not continuation line boxes", () => {
  const result = render(`<p id="p" style="width:6ch;text-indent:1ch">aa bb cc</p>`, 20);
  const paragraph = principalFragment(result, elementById(result, "p"));
  assert.equal(paragraph.lineBoxes.length, 2);
  const first = result.layout.fragment(paragraph.lineBoxes[0].textFragments[0]);
  const second = result.layout.fragment(paragraph.lineBoxes[1].textFragments[0]);
  assert.equal(cssPixels(first.contentRect.x - paragraph.contentRect.x), 8);
  assert.equal(second.contentRect.x, paragraph.contentRect.x);
});

test("whitespace modes and forced breaks are resolved during line construction", () => {
  const collapsed = render(`<p>a   b\n c</p>`, 30);
  assert.match(renderedText(collapsed), /^a b c/mu);
  const preserved = render(`<pre>a  b\n c</pre>`, 30);
  assert.ok(preserved.terminal.cellBuffer.rows.some((row) => row.text === "a  b"));
  assert.ok(preserved.terminal.cellBuffer.rows.some((row) => row.text === " c"));
  const forced = render(`<p>a<br>b</p>`, 30);
  assert.equal(forced.terminal.cellBuffer.rows.filter((row) => row.text === "a" || row.text === "b").length, 2);
  const unbreakable = render(`<p id="p" style="width:4ch">abcdefgh</p>`, 20);
  const unbreakableBox = principalFragment(unbreakable, elementById(unbreakable, "p"));
  assert.equal(unbreakableBox.lineBoxes.length, 1);
  assert.ok(unbreakableBox.overflowRect.width > unbreakableBox.borderRect.width);
});

test("long unbreakable text remains one source-linked overflowing text fragment", () => {
  const text = "x".repeat(100_000);
  const result = render(`<p id="p" style="width:4ch">${text}</p>`, 20);
  const paragraph = principalFragment(result, elementById(result, "p"));
  assert.equal(paragraph.lineBoxes.length, 1);
  assert.equal(paragraph.lineBoxes[0].textFragments.length, 1);
  const fragment = result.layout.fragment(paragraph.lineBoxes[0].textFragments[0]);
  assert.equal(fragment.text, text);
  assert.equal(fragment.contentEndCodeUnit - fragment.contentStartCodeUnit, text.length);
  assert.ok(fragment.sourceRange);
  assert.equal(fragment.sourceRange.end - fragment.sourceRange.start, text.length);
  assert.ok(paragraph.overflowRect.width > paragraph.borderRect.width);
});

test("text transformation and line breaking preserve document source ranges", () => {
  const result = render(`<p style="text-transform:uppercase">a ß b</p>`, 2);
  assert.equal(result.terminal.cellBuffer.rows.map((row) => row.text).join(""), "ASSB");
  const spans = result.terminal.cellBuffer.rows.flatMap((row) => row.spans).filter((span) => span.sourceRange !== null);
  assert.ok(spans.length >= 3);
  assert.equal(spans[1].sourceRange.end - spans[1].sourceRange.start, 1);
});

test("generated text, list markers, controls, and replaced boxes share line-box layout", () => {
  const result = render(`<style>li::before{content:"prefix "}</style><ul><li>item</li></ul>
    <label for="q">Query</label><input id="q" value="value"><img alt="photo">`, 40);
  const text = renderedText(result);
  assert.match(text, /prefix/u);
  assert.match(text, /item/u);
  assert.match(text, /Query: value/u);
  assert.match(text, /photo/u);
  const kinds = new Set(result.displayList.commands.map((command) => result.layout.fragment(command.layoutFragment).kind));
  assert.ok(kinds.has("control"));
  assert.ok(kinds.has("replaced"));
});

test("atomic controls resolve box sizing and min/max constraints in CSS pixels", () => {
  const result = render(`<label for="q">Query</label><input id="q" value="value" style="width:10ch;
    height:4em;max-height:3em;padding:8px;border:solid 8px;box-sizing:border-box">`, 30);
  const node = elementById(result, "q");
  const control = result.layout.forDocumentNode(node).find((fragment) => fragment.kind === "control");
  assert.ok(control);
  assert.equal(cssPixels(control.borderRect.width), 80);
  assert.equal(cssPixels(control.contentRect.width), 48);
  assert.equal(cssPixels(control.borderRect.height), 48);
  assert.equal(cssPixels(control.contentRect.height), 16);
  assert.deepEqual(
    result.displayList.commands.filter((command) => command.layoutFragment === control.id).map((command) => command.kind),
    ["border", "text"]
  );
});

test("tables preserve rows, cells, captions, columns, and nested table geometry", () => {
  const result = render(`<table><caption>Caption</caption><colgroup><col><col></colgroup><tr><td>A</td>
    <td><table><tr><td>B</td><td>C</td></tr></table></td></tr></table>`, 30);
  assert.match(renderedText(result), /Caption/u);
  assert.match(renderedText(result), /A/u);
  const column = [...result.layout.forFormattingNode(
    (() => {
      const pending = [result.formatting.root];
      while (pending.length > 0) {
        const id = pending.pop();
        if (id !== undefined && result.formatting.node(id).kind === "table-column") return id;
        if (id !== undefined) pending.push(...result.formatting.node(id).children);
      }
      throw new Error("Missing table column");
    })()
  )][0];
  assert.ok(column && column.borderRect.width === 0 && column.borderRect.height === 0);
});

test("flex and grid geometry is fixed-point layout-owned", () => {
  const flex = render(`<div id="flex" style="display:flex;width:12ch;gap:1ch;flex-wrap:wrap">
    <span>aaaa</span><span>bbbb</span><span>cccc</span></div>`, 30);
  const flexBox = principalFragment(flex, elementById(flex, "flex"));
  assert.ok(flexBox.children.length >= 3);
  const grid = render(`<div id="grid" style="display:grid;width:12ch;grid-template-columns:1fr 2fr;gap:1ch">
    <span>one</span><span>two</span><span>three</span><span>four</span></div>`, 30);
  const gridBox = principalFragment(grid, elementById(grid, "grid"));
  const items = gridBox.children.map((id) => grid.layout.fragment(id));
  assert.equal(items[0].borderRect.y, items[1].borderRect.y);
  assert.ok(items[1].borderRect.width > items[0].borderRect.width);
  assert.equal(items[2].borderRect.y, items[3].borderRect.y);
});

test("flex cross-axis alignment moves complete fixed-point fragment subtrees", () => {
  const result = render(`<div id="flex" style="display:flex;width:12ch;align-items:flex-end">
    <div id="short" style="width:4ch;height:1em">short</div>
    <div id="tall" style="width:4ch;height:3em">tall</div></div>`, 30);
  const short = principalFragment(result, elementById(result, "short"));
  const tall = principalFragment(result, elementById(result, "tall"));
  assert.ok(short.borderRect.y > tall.borderRect.y);
  assert.equal(short.borderRect.y + short.borderRect.height, tall.borderRect.y + tall.borderRect.height);
  assert.ok(short.lineBoxes.every((line) => line.rect.y >= short.contentRect.y));
});

test("CSS geometry is invariant across color depth and Unicode capability", () => {
  const tree = formatting(`<div style="border:solid 1px;width:8ch">body</div>`, 20);
  const rich = renderFormatting(tree, 20, 10, {}, { unicode: true, colorDepth: 24 });
  const plain = renderFormatting(tree, 20, 10, {}, { unicode: false, colorDepth: 0 });
  assert.deepEqual(rich.layout.fragment(rich.layout.root), plain.layout.fragment(plain.layout.root));
  assert.notEqual(renderedText(rich), renderedText(plain));
});

test("terminal color depth changes actual cell styles without changing layout geometry", () => {
  const tree = formatting(`<p style="color:#123456;background:#abcdef">color</p>`, 20);
  const trueColor = renderFormatting(tree, 20, 10, {}, { colorDepth: 24 });
  const ansi = renderFormatting(tree, 20, 10, {}, { colorDepth: 4 });
  const monochrome = renderFormatting(tree, 20, 10, {}, { colorDepth: 0 });
  assert.deepEqual(layoutPayload(trueColor.layout), layoutPayload(ansi.layout));
  const trueStyle = trueColor.terminal.cellBuffer.rows.flatMap((row) => row.cells)[0]?.style;
  const ansiStyle = ansi.terminal.cellBuffer.rows.flatMap((row) => row.cells)[0]?.style;
  const monochromeStyle = monochrome.terminal.cellBuffer.rows.flatMap((row) => row.cells)[0]?.style;
  assert.deepEqual(trueStyle?.foreground, { r: 18, g: 52, b: 86, a: 1 });
  assert.notDeepEqual(ansiStyle?.foreground, trueStyle?.foreground);
  assert.equal(monochromeStyle?.foreground, null);
  assert.equal(monochromeStyle?.background, null);
});

test("cell differences arise only during terminal snapping", () => {
  const tree = formatting(`<div id="box" style="width:17px">x</div>`, 20);
  const normal = renderFormatting(tree, 20);
  const narrowCells = buildTerminalDisplayList({
    layout: normal.layout,
    context: {
      columns: 40,
      rows: 24,
      cellWidthCssPx: cssPx(4),
      rowHeightCssPx: ROW_HEIGHT,
      unicode: true,
      ambiguousWidth: 1,
      colorDepth: 24,
      cellMeasurer: terminalCellMeasurer()
    }
  });
  assert.equal(principalFragment(normal, elementById(normal, "box")).contentRect.width, cssPx(17));
  assert.equal(narrowCells.layout, normal.layout);
  assert.notDeepEqual(
    rasterizeTerminalDisplayList({ displayList: narrowCells }).cellBuffer,
    normal.terminal.cellBuffer
  );
});

test("logical search IDs survive wrapping and cell-metric changes", () => {
  const tree = formatting(`<p>alpha beta gamma delta</p>`, 40);
  const narrow = renderFormatting(tree, 8).terminal.search("beta gamma");
  const wide = renderFormatting(tree, 40).terminal.search("beta gamma");
  assert.equal(narrow.matches.length, 1);
  assert.equal(wide.matches.length, 1);
  assert.equal(narrow.matches[0].id, wide.matches[0].id);
  assert.ok(new Set(narrow.matches[0].ranges.map((range) => range.row)).size > 1);
  assert.equal(new Set(wide.matches[0].ranges.map((range) => range.row)).size, 1);
});

test("split inline semantics produce one focus and accessibility identity over all visible fragments", () => {
  for (const html of [
    `<a href="/next"><div>block</div></a>`,
    `<a href="/next"><div>block</div>tail</a>`,
    `<a href="/next">lead<div>block</div></a>`,
    `<a href="/next"><div>one</div><div>two</div></a>`,
    `<a href="/next"><span>lead<em>nested<div>block</div>tail</em>end</span></a>`,
    `<a href="/next" role="button">lead<div>block</div>tail</a>`
  ]) {
    const result = render(html, 9);
    const link = result.formatting.document.links[0];
    assert.ok(link);
    const accessibility = result.terminal.accessibilityBounds.filter((entry) => entry.documentNode === link.node);
    assert.equal(accessibility.length, 1);
    const focus = result.terminal.focusMap.targets.filter((entry) => entry.node === link.node);
    assert.equal(focus.length, 1);
    assert.ok(focus[0].rects.length > 0);
    assert.ok(focus[0].layoutFragments.every((fragment) => accessibility[0].layoutFragments.includes(fragment)));
    assert.ok(focus[0].rects.every((rect) =>
      rect.row >= accessibility[0].rect.row
      && rect.row + rect.height <= accessibility[0].rect.row + accessibility[0].rect.height
      && rect.column >= accessibility[0].rect.column
      && rect.column + rect.width <= accessibility[0].rect.column + accessibility[0].rect.width
    ));
    assert.ok(focus[0].rects.every((rect) => result.terminal.hitTestIndex.at(rect.row, rect.column)?.action.node === link.node));
    if (html.includes("role=\"button\"")) assert.equal(accessibility[0].role, "button");
  }
});

test("overflow clipping constrains paint, pointer, and accessibility bounds", () => {
  const result = render(`<style>.clip{width:5ch;height:1em;overflow:hidden}a{white-space:nowrap}</style>
    <div class="clip"><a href="/next">abcdefghij</a><p>second row</p></div>`, 20);
  assert.match(result.terminal.cellBuffer.rows[0].text, /^abcde$/u);
  assert.ok(result.terminal.cellBuffer.rows.slice(1).every((row) => !row.text.includes("second row")));
  assert.equal(result.terminal.hitTestIndex.at(0, 4)?.action.kind, "link");
  assert.equal(result.terminal.hitTestIndex.at(0, 5), null);
});

test("CSS-clipped semantic content stays accessible without synthetic paint or hits", () => {
  const result = render(`<a href="#main" style="position:absolute;width:1px;height:1px;overflow:hidden;
    clip:rect(0,0,0,0)">Skip to main</a><main id="main">Visible</main>`, 30);
  assert.doesNotMatch(renderedText(result), /Skip to main/u);
  assert.equal(result.terminal.search("Skip to main").ranges.length, 0);
  assert.equal(result.terminal.hitTestIndex.regions.some((entry) => entry.action.kind === "link"), false);
  assert.ok(result.terminal.accessibilityBounds.some((entry) => entry.role === "link" && entry.name === "Skip to main"));
});

test("later display-list paint order wins cell collisions", () => {
  const result = render(`<style>.grid{display:grid;width:4ch;grid-template-columns:4ch 4ch}
    .first,.second{grid-column:1}</style><div class="grid"><span class="first">AAAA</span>
    <span class="second">BBBB</span></div>`, 20);
  assert.equal(result.terminal.cellBuffer.rows[0]?.text, "BBBB");
  assert.equal(result.terminal.cellBuffer.rows[0]?.spans.length, 1);
  assert.equal(result.terminal.cellBuffer.rows[0]?.spans[0]?.width, 4);
});

test("layout-budget truncation preserves a connected source-order fragment prefix", () => {
  const tree = formatting(`<div>${"<span>word </span>".repeat(100)}</div>`, 20);
  const small = renderFormatting(tree, 20, 10, { layout: { maxFragments: 14 } });
  const larger = renderFormatting(tree, 20, 10, { layout: { maxFragments: 24 } });
  assert.equal(small.layout.outcome.status, "truncated");
  assert.equal(small.layout.outcome.budget, "maxFragments");
  const reached = reachableFragments(small.layout);
  assert.equal(reached.size, small.layout.outcome.fragments);
  for (const id of reached) {
    if (id !== small.layout.root) assert.ok(small.layout.parent(id));
  }
  assert.match(renderedText(small), /^word/u);
  assert.ok(renderedText(larger).startsWith(renderedText(small).trimEnd()));
  assert.deepEqual(layoutPayload(renderFormatting(tree, 20, 10, { layout: { maxFragments: 14 } }).layout), layoutPayload(small.layout));
});

test("every layout budget finalizes a connected fragment prefix", () => {
  const cases = [
    {
      tree: formatting(`<p>${"word ".repeat(30)}</p>`, 4),
      columns: 4,
      budget: { maxLineBoxes: 2 },
      expected: "maxLineBoxes"
    },
    {
      tree: formatting(`<p>${"word ".repeat(30)}</p>`, 20),
      columns: 20,
      budget: { maxTextFragments: 3 },
      expected: "maxTextFragments"
    },
    {
      tree: formatting(`<div><div><div><div><div>deep</div></div></div></div></div>`, 20),
      columns: 20,
      budget: { maxDepth: 3 },
      expected: "maxDepth"
    }
  ];
  for (const fixture of cases) {
    const result = renderFormatting(fixture.tree, fixture.columns, 10, { layout: fixture.budget });
    assert.equal(result.layout.outcome.status, "truncated");
    assert.equal(result.layout.outcome.budget, fixture.expected);
    const reached = reachableFragments(result.layout);
    assert.equal(reached.size, result.layout.outcome.fragments);
    for (const id of reached) {
      if (id !== result.layout.root) assert.ok(result.layout.parent(id));
    }
  }
});

test("layout, display-list construction, and cell rasterization honor cancellation", () => {
  const tree = formatting(`<p>${"word ".repeat(100)}</p>`, 20);
  const textMeasurer = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);
  const layoutController = new globalThis.AbortController();
  layoutController.abort();
  assert.throws(() => buildLayoutFragmentTree({
    formatting: tree,
    searchIndex: buildTextSearchIndex(tree),
    context: {
      viewport: { width: cssPx(160), height: cssPx(160) },
      rootFontMetrics: textMeasurer.defaultFontMetrics(),
      textMeasurer,
      initialContainingBlock: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), cssPx(160), cssPx(160)),
      signal: layoutController.signal
    }
  }), { name: "AbortError" });
  const complete = renderFormatting(tree, 20);
  const displayController = new globalThis.AbortController();
  displayController.abort();
  assert.throws(() => buildTerminalDisplayList({
    layout: complete.layout,
    context: { ...complete.displayList.context, signal: displayController.signal }
  }), { name: "AbortError" });
  const paintController = new globalThis.AbortController();
  const displayList = buildTerminalDisplayList({
    layout: complete.layout,
    context: { ...complete.displayList.context, signal: paintController.signal }
  });
  paintController.abort();
  assert.throws(() => rasterizeTerminalDisplayList({ displayList }), { name: "AbortError" });
});

test("terminal paint budgets truncate only the cell buffer", () => {
  const result = render(`<p>${"word ".repeat(30)}</p>`, 20, 10, { terminal: { maxPaintCells: 25 } });
  assert.equal(result.layout.outcome.status, "complete");
  assert.equal(result.terminal.cellBuffer.outcome.status, "truncated");
  assert.equal(result.terminal.cellBuffer.outcome.budget, "maxPaintCells");
  assert.match(renderedText(result), /^word word/u);
});

test("display-list budgets retain an ordered paint-command prefix", () => {
  const result = render(`<p>${"word ".repeat(30)}</p>`, 20, 10, { terminal: { maxCommands: 3 } });
  assert.equal(result.layout.outcome.status, "complete");
  assert.equal(result.displayList.outcome.status, "truncated");
  assert.equal(result.displayList.outcome.budget, "maxCommands");
  assert.equal(result.displayList.commands.length, 3);
  assert.ok(result.displayList.commands.every((command, index, commands) =>
    index === 0 || command.paintOrder >= commands[index - 1].paintOrder
  ));
});

test("offline common-page fixtures traverse layout, display-list, and cell-buffer stages", () => {
  const article = readFileSync(new URL("../fixtures/pages/article-form.html", import.meta.url), "utf8");
  const articleResult = render(article, 72);
  assert.match(renderedText(articleResult), /A practical terminal article/u);
  assert.ok(articleResult.terminal.focusMap.targets.some((entry) => entry.action.kind === "form-control"));
  const dashboard = readFileSync(new URL("../fixtures/pages/dashboard-table.html", import.meta.url), "utf8");
  const dashboardResult = render(dashboard, 72);
  assert.match(renderedText(dashboardResult), /Auto refresh/u);
  assert.ok(dashboardResult.displayList.commands.length > 0);
});
