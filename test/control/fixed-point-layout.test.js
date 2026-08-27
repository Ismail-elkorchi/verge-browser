import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import {
  CSS_FIXED_SCALE,
  buildLayoutFragmentTree,
  cssAdd,
  cssCoordinate,
  cssCoordinateFromFixed,
  cssDivide,
  cssIntersection,
  cssLengthFromFixed,
  cssMultiply,
  cssPixels,
  cssPx,
  cssRect,
  cssSubtract,
  cssUnion,
  isSafeCssFixedValue,
  resolveFlexLines,
  selectLogicalLines
} from "../../dist/presentation/layout/index.js";
import { buildTextSearchIndex } from "../../dist/presentation/search/index.js";
import { embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
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
  const styles = resolveStyles({
    document,
    state,
    resources: embeddedStylesheetSources(document),
    environment: media(columns, rows)
  });
  return buildFormattingTree({
    document,
    state,
    styles,
    ...(formattingBudgets === undefined ? {} : { budgets: formattingBudgets })
  });
}

function renderFormatting(formattingTree, columns, rows = 24, budgets = {}, capabilities = {}) {
  const textMeasurer = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);
  const inlineItemStreams = buildInlineItemStreamSet(formattingTree);
  const searchIndex = buildTextSearchIndex(formattingTree, inlineItemStreams);
  const layout = buildLayoutFragmentTree({
    formatting: formattingTree,
    inlineItemStreams,
    context: {
      viewport: {
        width: cssLengthFromFixed(columns * CELL_WIDTH),
        height: cssLengthFromFixed(rows * ROW_HEIGHT)
      },
      textMeasurer,
      initialContainingBlock: cssRect(
        cssCoordinate(ZERO),
        cssCoordinate(ZERO),
        cssLengthFromFixed(columns * CELL_WIDTH),
        cssLengthFromFixed(rows * ROW_HEIGHT)
      ),
      scrollport: cssRect(
        cssCoordinate(ZERO),
        cssCoordinate(cssLengthFromFixed((capabilities.scrollRow ?? 0) * ROW_HEIGHT)),
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
  const terminal = rasterizeTerminalDisplayList({ displayList, textSearchIndex: searchIndex });
  return { formatting: formattingTree, inlineItemStreams, searchIndex, layout, displayList, terminal };
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
  const inlineItemStreams = buildInlineItemStreamSet(tree);
  const context = {
    viewport: { width: cssPx(160), height: cssPx(160) },
    textMeasurer,
    initialContainingBlock: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), cssPx(160), cssPx(160)),
    scrollport: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), cssPx(160), cssPx(160))
  };
  const invalidContext = buildLayoutFragmentTree({
    formatting: tree,
    inlineItemStreams,
    context: { ...context, viewport: { width: ZERO, height: cssPx(160) } }
  });
  assert.deepEqual(invalidContext.outcome, { status: "rejected", reason: "invalid-context" });
  const invalidMeasurement = buildLayoutFragmentTree({
    formatting: tree,
    inlineItemStreams,
    context: {
      ...context,
      textMeasurer: { ...textMeasurer, measure() { throw new RangeError("invalid metric"); } }
    }
  });
  assert.deepEqual(invalidMeasurement.outcome, { status: "rejected", reason: "invalid-fixed-point-input" });
  const unsafeMetrics = buildLayoutFragmentTree({
    formatting: tree,
    inlineItemStreams,
    context: {
      ...context,
      textMeasurer: {
        ...textMeasurer,
        fontMetrics(fontSize) {
          return { ...textMeasurer.fontMetrics(fontSize), ascent: Number.MAX_SAFE_INTEGER + 1 };
        }
      }
    }
  });
  assert.deepEqual(unsafeMetrics.outcome, { status: "rejected", reason: "invalid-fixed-point-input" });
  const invalidBudget = buildLayoutFragmentTree({
    formatting: tree,
    inlineItemStreams,
    context: { ...context, budgets: { maxFragments: 0 } }
  });
  assert.deepEqual(invalidBudget.outcome, { status: "rejected", reason: "invalid-budget" });
});

test("standards-derived layout cases pin WPT provenance and license", () => {
  const provenance = JSON.parse(readFileSync(
    new URL("../fixtures/wpt-layout-provenance.json", import.meta.url),
    "utf8"
  ));
  assert.match(provenance.commit, /^[0-9a-f]{40}$/u);
  assert.match(provenance.license, /BSD/u);
  assert.ok(provenance.adaptations.length >= 26);
  assert.ok(provenance.adaptations.every((entry) =>
    entry.source && entry.behavior && entry.terminalAdjustment && /BSD/u.test(entry.license)
  ));
});

test("standards-derived Unicode text cases pin WPT and Unicode provenance", () => {
  const provenance = JSON.parse(readFileSync(
    new URL("../fixtures/wpt-text-provenance.json", import.meta.url),
    "utf8"
  ));
  assert.match(provenance.commit, /^[0-9a-f]{40}$/u);
  assert.equal(provenance.unicodeVersion, "17.0.0");
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
    <div id="max" style="width:12ch;max-width:5ch;height:5em;max-height:2em">max</div>
    <div id="conflict" style="width:2ch;min-width:7ch;max-width:4ch;
      height:1em;min-height:4em;max-height:2em">conflict</div>`, 30);
  assert.equal(cssPixels(principalFragment(result, elementById(result, "min")).contentRect.width), 48);
  const maximum = principalFragment(result, elementById(result, "max"));
  assert.equal(cssPixels(maximum.contentRect.width), 40);
  assert.equal(cssPixels(maximum.contentRect.height), 32);
  const conflict = principalFragment(result, elementById(result, "conflict"));
  assert.equal(cssPixels(conflict.contentRect.width), 56);
  assert.equal(cssPixels(conflict.contentRect.height), 64);
});

test("percentage heights require a definite containing height", () => {
  const indefinite = render(`<div><div id="child" style="height:50%">line</div></div>`, 20);
  const definite = render(`<div style="height:100px"><div id="child" style="height:50%">line</div></div>`, 20);
  assert.equal(cssPixels(principalFragment(indefinite, elementById(indefinite, "child")).contentRect.height), 16);
  assert.equal(cssPixels(principalFragment(definite, elementById(definite, "child")).contentRect.height), 50);
});

test("mixed length-percentage used values require the property percentage basis", () => {
  const definite = render(`<div style="height:100px;position:relative">
    <div id="height" style="height:calc(50% - 1px)"></div>
    <div id="minimum" style="min-height:min(25%,20px)"></div>
    <div id="inset" style="position:absolute;top:calc(50% - 2px);height:1px">x</div>
  </div>`, 40, 20);
  assert.equal(cssPixels(principalFragment(definite, elementById(definite, "height")).contentRect.height), 49);
  assert.equal(cssPixels(principalFragment(definite, elementById(definite, "minimum")).contentRect.height), 20);
  assert.equal(cssPixels(principalFragment(definite, elementById(definite, "inset")).borderRect.y), 48);

  const indefinite = render(`<div>
    <div id="height" style="height:calc(50% - 1px)">text</div>
    <div id="minimum" style="min-height:min(25%,20px)">text</div>
  </div>`, 40, 20);
  assert.equal(cssPixels(principalFragment(indefinite, elementById(indefinite, "height")).contentRect.height), 16);
  assert.equal(cssPixels(principalFragment(indefinite, elementById(indefinite, "minimum")).contentRect.height), 16);

  const flexBasis = render(`<div style="display:flex;width:100px">
    <div id="basis" style="flex:0 0 calc(40% - 1rem);min-width:0">basis</div></div>`, 40, 20);
  assert.equal(cssPixels(principalFragment(flexBasis, elementById(flexBasis, "basis")).contentRect.width), 24);
  const indefiniteBasis = render(`<div style="display:flex;flex-direction:column;width:80px">
    <div id="basis" style="flex:0 0 calc(40% - 1rem)">one<br>two</div></div>`, 40, 20);
  assert.ok(cssPixels(principalFragment(indefiniteBasis, elementById(indefiniteBasis, "basis")).contentRect.height) >= 32);
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
  assert.ok(paragraph.lineBoxes.every((line) => line.usedInlineAdvance > 0));
  assert.ok(paragraph.lineBoxes.every((line) =>
    line.embeddingLevels.length === line.logicalItemEnd - line.logicalItemStart
    && line.sourceRanges.length > 0
  ));
  assert.ok(paragraph.lineBoxes.flatMap((line) => line.textFragments)
    .every((id) => result.layout.fragment(id).sourceRange !== null));
  const identityResult = render(`<p id="p"><a href="/next">linked text</a></p>`, 20);
  const identityLine = principalFragment(identityResult, elementById(identityResult, "p")).lineBoxes[0];
  assert.equal(identityLine?.actions.some((action) => action.kind === "link"), true);
  assert.equal(identityLine?.semantics.some((semantic) => semantic.role === "link"), true);
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
  const inlineOffset = (line) => line.textFragments.reduce(
    (minimum, fragment) => Math.min(
      minimum,
      result.layout.fragment(fragment).contentRect.x - paragraph.contentRect.x
    ),
    Number.MAX_SAFE_INTEGER
  );
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

test("inline item streams scope collapsible white space to their inline formatting context", () => {
  const atomic = render(`<p>A<span id="atomic" style="display:inline-block">x </span> B</p>`, 30);
  assert.equal(renderedText(atomic), "Ax B");
  assert.equal(atomic.searchIndex.text, "Ax B");
  const atomicNode = elementById(atomic, "atomic");
  const atomicFormatting = atomic.formatting.forSource(atomicNode)
    .find((node) => node.outer === "inline" && node.appliesBoxStyle);
  assert.ok(atomicFormatting);
  const outerStream = atomic.inlineItemStreams.streams.find((stream) => stream.items.some(
    (item) => item.kind === "atomic-inline" && item.formattingNode === atomicFormatting.id
  ));
  assert.ok(outerStream);
  const atomicIndex = outerStream.items.findIndex((item) => item.kind === "atomic-inline");
  assert.equal(outerStream.items[atomicIndex + 1]?.kind, "text");
  assert.equal(outerStream.items[atomicIndex + 1]?.text, " ");
  const innerStream = atomic.inlineItemStreams.streams.find(
    (stream) => stream.containingFormattingBox === atomicFormatting.id
  );
  assert.ok(innerStream);
  assert.equal(innerStream.collapsibleSpacePending, true);

  const contents = render(`<p>A<span style="display:contents"> B</span> C<br>D<wbr> E</p>`, 30);
  assert.equal(renderedText(contents), "A B C\nD E");
  assert.equal(contents.searchIndex.text, "A B C D E");
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
  const controlSearch = result.terminal.search("value");
  assert.equal(controlSearch.matches.length, 1);
  assert.ok(controlSearch.matches[0].ranges.length > 0);
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
    ["border-side", "border-side", "border-side", "border-side", "text"]
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

test("flexible lengths use order, freezing, wrapping, and automatic margins", () => {
  const item = (identity, sourceIndex, values = {}) => ({
    identity,
    sourceIndex,
    order: values.order ?? 0,
    flexBaseSize: cssPx(values.base ?? 20),
    hypotheticalMainSize: cssPx(values.hypothetical ?? values.base ?? 20),
    minimumMainSize: cssPx(values.minimum ?? 0),
    maximumMainSize: values.maximum === undefined ? null : cssPx(values.maximum),
    mainBorderPadding: cssPx(values.chrome ?? 0),
    flexGrow: values.grow ?? 0,
    flexShrink: values.shrink ?? 1,
    marginMainStart: cssPx(values.marginStart ?? 0),
    marginMainEnd: cssPx(values.marginEnd ?? 0),
    autoMarginMainStart: values.autoStart ?? false,
    autoMarginMainEnd: values.autoEnd ?? false
  });
  const grown = resolveFlexLines({
    items: [item("later", 0, { order: 2, grow: 1 }), item("first", 1, { order: 1, grow: 3, maximum: 50 })],
    containerMainSize: cssPx(100), gap: cssPx(0), wrap: "nowrap", reverse: false,
    justifyContent: "start"
  });
  assert.deepEqual(grown[0].items.map((entry) => entry.identity), ["first", "later"]);
  assert.deepEqual(grown[0].items.map((entry) => cssPixels(entry.targetMainSize)), [50, 50]);

  const shrunk = resolveFlexLines({
    items: [item("a", 0, { base: 80, minimum: 60 }), item("b", 1, { base: 80, minimum: 10 })],
    containerMainSize: cssPx(100), gap: cssPx(0), wrap: "nowrap", reverse: false,
    justifyContent: "start"
  });
  assert.deepEqual(shrunk[0].items.map((entry) => cssPixels(entry.targetMainSize)), [60, 40]);

  const wrapped = resolveFlexLines({
    items: [item("a", 0, { base: 45 }), item("b", 1, { base: 45 }), item("c", 2, { base: 45 })],
    containerMainSize: cssPx(100), gap: cssPx(10), wrap: "wrap", reverse: false,
    justifyContent: "start"
  });
  assert.deepEqual(wrapped.map((line) => line.items.map((entry) => entry.identity)), [["a", "b"], ["c"]]);

  const automatic = resolveFlexLines({
    items: [item("a", 0, { autoStart: true }), item("b", 1)],
    containerMainSize: cssPx(100), gap: cssPx(0), wrap: "nowrap", reverse: false,
    justifyContent: "space-between"
  });
  assert.equal(cssPixels(automatic[0].items[0].mainOffset), 60);

  const fractionalGrow = resolveFlexLines({
    items: [item("a", 0, { grow: 0.25 }), item("b", 1, { grow: 0.25 })],
    containerMainSize: cssPx(100), gap: cssPx(0), wrap: "nowrap", reverse: false,
    justifyContent: "start"
  });
  assert.deepEqual(fractionalGrow[0].items.map((entry) => cssPixels(entry.targetMainSize)), [35, 35]);

  const fractionalShrink = resolveFlexLines({
    items: [item("a", 0, { base: 80, shrink: 0.25 }), item("b", 1, { base: 80, shrink: 0.25 })],
    containerMainSize: cssPx(100), gap: cssPx(0), wrap: "nowrap", reverse: false,
    justifyContent: "start"
  });
  assert.deepEqual(fractionalShrink[0].items.map((entry) => cssPixels(entry.targetMainSize)), [65, 65]);
});

test("flex formatting applies resolved main sizes, order, directions, and column sizing", () => {
  const grown = render(`<div style="display:flex;width:100px">
    <div id="one" style="flex:1 1 0;min-width:0">one</div>
    <div id="two" style="flex:3 1 0;min-width:0">two</div>
  </div>`, 30);
  const one = principalFragment(grown, elementById(grown, "one"));
  const two = principalFragment(grown, elementById(grown, "two"));
  assert.equal(cssPixels(one.contentRect.width), 25);
  assert.equal(cssPixels(two.contentRect.width), 75);

  const shrunk = render(`<div style="display:flex;width:100px">
    <div id="first" style="width:80px;min-width:60px;flex-shrink:1;order:2">first</div>
    <div id="second" style="width:80px;min-width:10px;flex-shrink:1;order:1">second</div>
  </div>`, 30);
  const first = principalFragment(shrunk, elementById(shrunk, "first"));
  const second = principalFragment(shrunk, elementById(shrunk, "second"));
  assert.equal(cssPixels(first.contentRect.width), 60);
  assert.equal(cssPixels(second.contentRect.width), 40);
  assert.ok(second.borderRect.x < first.borderRect.x);

  const column = render(`<div style="display:flex;flex-direction:column;height:80px;width:80px">
    <div id="top" style="flex:1 1 0;min-height:0">top</div>
    <div id="bottom" style="flex:3 1 0;min-height:0">bottom</div>
  </div>`, 30);
  const top = principalFragment(column, elementById(column, "top"));
  const bottom = principalFragment(column, elementById(column, "bottom"));
  assert.equal(cssPixels(top.contentRect.height), 20);
  assert.equal(cssPixels(bottom.contentRect.height), 60);
  assert.equal(bottom.borderRect.y, top.borderRect.y + top.borderRect.height);

  const automaticMinimum = render(`<div style="display:flex;width:80px">
    <div id="min-one">long long</div><div id="min-two">long long</div></div>`, 30);
  assert.equal(cssPixels(principalFragment(automaticMinimum, elementById(automaticMinimum, "min-one")).contentRect.width), 40);
  assert.equal(cssPixels(principalFragment(automaticMinimum, elementById(automaticMinimum, "min-two")).contentRect.width), 40);

  const rtl = render(`<div style="display:flex;direction:rtl;width:80px">
    <div id="rtl-first" style="flex:0 0 20px">first</div>
    <div id="rtl-second" style="flex:0 0 20px">second</div></div>`, 30);
  assert.ok(principalFragment(rtl, elementById(rtl, "rtl-first")).borderRect.x
    > principalFragment(rtl, elementById(rtl, "rtl-second")).borderRect.x);
});

test("column flex intrinsic main contributions follow descendant formatting contexts", () => {
  const nestedRow = render(`<div id="outer" style="display:flex;flex-direction:column;width:100px">
    <section id="row" style="display:flex">
      <div style="height:16px">short</div><div style="height:32px">tall</div>
    </section><div id="tail" style="height:8px">tail</div></div>`, 30, 20);
  const outer = principalFragment(nestedRow, elementById(nestedRow, "outer"));
  const row = principalFragment(nestedRow, elementById(nestedRow, "row"));
  const tail = principalFragment(nestedRow, elementById(nestedRow, "tail"));
  assert.equal(cssPixels(row.contentRect.height), 32);
  assert.equal(cssPixels(outer.contentRect.height), 40);
  assert.equal(tail.borderRect.y, row.borderRect.y + row.borderRect.height);

  const blockChildren = render(`<div id="outer" style="display:flex;flex-direction:column;width:100px">
    <section id="blocks"><div style="height:16px"></div><div style="height:24px"></div></section>
    <div style="height:8px"></div></div>`, 30, 20);
  assert.equal(cssPixels(principalFragment(blockChildren,
    elementById(blockChildren, "blocks")).contentRect.height), 40);
  assert.equal(cssPixels(principalFragment(blockChildren,
    elementById(blockChildren, "outer")).contentRect.height), 48);

  const structured = render(`<div id="outer" style="display:flex;flex-direction:column;width:120px">
    <div id="grid" style="display:grid;grid-template-columns:1fr 1fr;row-gap:4px">
      <div style="height:12px"></div><div style="height:20px"></div><div style="height:8px"></div>
    </div>
    <table id="table"><tbody><tr><td style="height:16px">cell</td><td style="height:24px">cell</td></tr></tbody></table>
  </div>`, 30, 20);
  assert.equal(cssPixels(principalFragment(structured,
    elementById(structured, "grid")).contentRect.height), 32);
  const structuredGrid = principalFragment(structured, elementById(structured, "grid"));
  const structuredTable = principalFragment(structured, elementById(structured, "table"));
  const structuredOuter = principalFragment(structured, elementById(structured, "outer"));
  assert.ok(cssPixels(structuredTable.contentRect.height) >= 24);
  assert.equal(
    structuredOuter.contentRect.height,
    structuredGrid.marginRect.height + structuredTable.marginRect.height
  );
});

test("flex axes use computed direction and exclude positioned children before sizing", () => {
  const result = render(`<div id="flex" style="display:flex;width:100px;gap:10px;direction:rtl">
    <div id="first" style="flex:1 1 0;min-width:0;margin-right:4px">first</div>
    <a id="absolute" style="position:absolute;width:20px;background:red">absolute</a>
    <div id="second" style="flex:1 1 0;min-width:0;margin-left:6px">second</div>
  </div>`, 40, 20);
  const first = principalFragment(result, elementById(result, "first"));
  const second = principalFragment(result, elementById(result, "second"));
  const absolute = principalFragment(result, elementById(result, "absolute"));
  assert.equal(cssPixels(first.contentRect.width + second.contentRect.width), 80);
  assert.ok(first.borderRect.x > second.borderRect.x);
  assert.equal(cssPixels(absolute.contentRect.width), 20);
  assert.equal(cssPixels(absolute.borderRect.x), 80);
  assert.ok(result.displayList.commands.some((command) => command.documentNode === elementById(result, "absolute")));

  const centered = render(`<div id="flex" style="display:flex;justify-content:center;align-items:end;width:100px;height:60px">
    <span id="absolute" style="position:absolute;width:20px;height:10px">absolute</span>
    <span id="item" style="width:30px">item</span></div>`, 40, 20);
  const centeredFlex = principalFragment(centered, elementById(centered, "flex"));
  const centeredAbsolute = principalFragment(centered, elementById(centered, "absolute"));
  assert.equal(cssPixels(centeredAbsolute.borderRect.x - centeredFlex.contentRect.x), 40);
  assert.equal(cssPixels(centeredAbsolute.borderRect.y - centeredFlex.contentRect.y), 50);

  const columnReverse = render(`<div style="display:flex;flex-direction:column-reverse;height:80px;width:60px">
    <div id="top" style="flex:0 0 20px;margin-bottom:5px">top</div>
    <div id="bottom" style="flex:0 0 20px;margin-top:7px">bottom</div></div>`, 30, 20);
  assert.ok(principalFragment(columnReverse, elementById(columnReverse, "top")).borderRect.y
    > principalFragment(columnReverse, elementById(columnReverse, "bottom")).borderRect.y);

  for (const [direction, flexDirection, firstAfterSecond] of [
    ["ltr", "row", false],
    ["rtl", "row", true],
    ["ltr", "row-reverse", true],
    ["rtl", "row-reverse", false]
  ]) {
    const axes = render(`<div style="display:flex;direction:${direction};flex-direction:${flexDirection};width:80px">
      <span id="axis-first" style="flex:0 0 20px">first</span>
      <span id="axis-second" style="flex:0 0 20px">second</span></div>`, 30, 10);
    const axisFirst = principalFragment(axes, elementById(axes, "axis-first"));
    const axisSecond = principalFragment(axes, elementById(axes, "axis-second"));
    assert.equal(axisFirst.borderRect.x > axisSecond.borderRect.x, firstAfterSecond);
  }

  const automaticMargins = render(`<div style="display:flex;width:100px;height:60px;align-items:start">
    <span id="auto-left" style="flex:0 0 20px;margin-left:auto">left</span></div>
    <div style="display:flex;direction:rtl;width:100px;height:60px;align-items:start">
      <span id="auto-right" style="flex:0 0 20px;margin-right:auto">right</span></div>
    <div style="display:flex;width:100px;height:60px;align-items:start">
      <span id="auto-top" style="flex:0 0 20px;margin-top:auto">top</span>
      <span id="auto-bottom" style="flex:0 0 20px;margin-bottom:auto">bottom</span></div>`, 40, 20);
  const autoLeft = principalFragment(automaticMargins, elementById(automaticMargins, "auto-left"));
  assert.equal(cssPixels(autoLeft.borderRect.x + autoLeft.borderRect.width), 100);
  assert.equal(cssPixels(principalFragment(automaticMargins,
    elementById(automaticMargins, "auto-right")).borderRect.x), 0);
  const autoTop = principalFragment(automaticMargins, elementById(automaticMargins, "auto-top"));
  const autoBottom = principalFragment(automaticMargins, elementById(automaticMargins, "auto-bottom"));
  assert.ok(autoTop.borderRect.y > autoBottom.borderRect.y);
});

test("positioned layout resolves containing blocks, out-of-flow geometry, sticky constraints, and stacking", () => {
  const result = render(`<div id="containing" style="position:relative;width:100px;height:80px">
    <div id="absolute" style="position:absolute;right:10px;top:5px;width:20px;height:10px;background:red">A</div>
    <div id="normal" style="height:16px">N</div>
    <div id="relative" style="position:relative;left:8px;top:4px;height:16px">R</div>
    <div id="sticky" style="position:sticky;top:0;height:16px">S</div>
    <div id="bottom" style="position:absolute;bottom:2px">bottom</div>
  </div>`, 30, 20);
  const containing = principalFragment(result, elementById(result, "containing"));
  const absolute = principalFragment(result, elementById(result, "absolute"));
  const normal = principalFragment(result, elementById(result, "normal"));
  const relative = principalFragment(result, elementById(result, "relative"));
  const sticky = principalFragment(result, elementById(result, "sticky"));
  const bottom = principalFragment(result, elementById(result, "bottom"));
  assert.equal(cssPixels(absolute.borderRect.x - containing.paddingRect.x), 70);
  assert.equal(cssPixels(absolute.borderRect.y - containing.paddingRect.y), 5);
  assert.equal(normal.borderRect.y, containing.contentRect.y);
  assert.equal(cssPixels(relative.borderRect.x - containing.contentRect.x), 8);
  assert.equal(cssPixels(sticky.borderRect.y - containing.contentRect.y), 32);
  assert.ok(sticky.borderRect.y >= result.layout.context.initialContainingBlock.y);
  assert.equal(cssPixels(
    containing.contentRect.y + containing.contentRect.height - bottom.borderRect.y - bottom.borderRect.height
  ), 2);

  const shrinkToFit = render(`<div id="cb" style="position:relative;width:80px;height:40px">
    <div id="fit" style="position:absolute;right:0;max-width:50px">long long long</div></div>`, 30, 10);
  const fit = principalFragment(shrinkToFit, elementById(shrinkToFit, "fit"));
  const fitContainingBlock = principalFragment(shrinkToFit, elementById(shrinkToFit, "cb"));
  assert.equal(cssPixels(fit.contentRect.width), 50);
  assert.equal(fit.borderRect.x + fit.borderRect.width, fitContainingBlock.paddingRect.x + fitContainingBlock.paddingRect.width);

  const stacked = render(`<div style="position:relative;width:40px;height:32px">
    <div id="high" style="position:absolute;inset:0;background:red;z-index:2">high</div>
    <div id="low" style="position:absolute;inset:0;background:blue;z-index:-1">low</div>
    <div id="auto" style="position:absolute;inset:0;background:green">auto</div>
  </div>`, 20, 10);
  const backgroundOrder = stacked.displayList.commands
    .filter((command) => command.kind === "background")
    .map((command) => stacked.layout.fragment(command.layoutFragment).documentNode);
  assert.ok(backgroundOrder.indexOf(elementById(stacked, "low")) < backgroundOrder.indexOf(elementById(stacked, "auto")));
  assert.ok(backgroundOrder.indexOf(elementById(stacked, "auto")) < backgroundOrder.indexOf(elementById(stacked, "high")));

  const nestedStack = render(`<div style="position:relative;width:40px;height:16px">
    <div id="normal-stack" style="position:static;width:40px;height:16px;background:blue">
      <span id="negative-stack" style="position:absolute;inset:0;background:red;z-index:-1">negative</span>
    </div></div>`, 20, 6);
  const normalPaint = nestedStack.displayList.commands.find((command) => command.kind === "background"
    && command.documentNode === elementById(nestedStack, "normal-stack"));
  const negativePaint = nestedStack.displayList.commands.find((command) => command.kind === "background"
    && command.documentNode === elementById(nestedStack, "negative-stack"));
  assert.ok(normalPaint && negativePaint && negativePaint.paintOrder < normalPaint.paintOrder);

  const scrolled = render(`<div style="height:64px">before</div>
    <div id="scrolled-sticky" style="position:sticky;top:0;height:16px">sticky</div>
    <div id="scrolled-fixed" style="position:fixed;top:0;right:0;height:16px">fixed</div>`,
  20, 4, {}, { scrollRow: 5 });
  const scrollportY = cssPx(80);
  const boundedSticky = principalFragment(scrolled, elementById(scrolled, "scrolled-sticky"));
  assert.equal(cssPixels(boundedSticky.borderRect.y), 64);
  assert.ok(boundedSticky.borderRect.y < scrollportY);
  assert.equal(principalFragment(scrolled, elementById(scrolled, "scrolled-fixed")).borderRect.y, scrollportY);

  const directionalInsets = render(`<div id="direction-cb" style="position:relative;width:100px">
    <div id="rtl-absolute" style="position:absolute;direction:rtl;left:10px;right:20px;width:30px">a</div>
    <div id="rtl-relative" style="position:relative;direction:rtl;left:10px;right:20px;width:30px">r</div>
  </div>`, 20, 8);
  const directionalContaining = principalFragment(directionalInsets, elementById(directionalInsets, "direction-cb"));
  const rtlAbsolute = principalFragment(directionalInsets, elementById(directionalInsets, "rtl-absolute"));
  const rtlRelative = principalFragment(directionalInsets, elementById(directionalInsets, "rtl-relative"));
  assert.equal(cssPixels(rtlAbsolute.borderRect.x - directionalContaining.paddingRect.x), 50);
  assert.equal(cssPixels(rtlRelative.borderRect.x - directionalContaining.contentRect.x), -20);
});

test("positioned descendants use final auto-height containing blocks and layout-owned stacking metadata", () => {
  const result = render(`<div id="containing" style="position:relative;width:80px;padding:4px;border:1px solid">
    <p style="height:48px">flow</p>
    <div id="bottom" style="position:absolute;bottom:0;height:8px">bottom</div>
    <span id="relative-inline" style="position:relative;left:8px;background:red">inline wraps across lines</span>
  </div>`, 12, 20);
  const containing = principalFragment(result, elementById(result, "containing"));
  const bottom = principalFragment(result, elementById(result, "bottom"));
  assert.equal(bottom.borderRect.y + bottom.borderRect.height,
    containing.paddingRect.y + containing.paddingRect.height);
  const relativeInline = principalFragment(result, elementById(result, "relative-inline"));
  assert.ok(relativeInline.inlineContinuations.every((continuation) =>
    continuation.borderRect.x >= containing.contentRect.x + cssPx(8)));

  const stacking = render(`<div id="context" style="position:relative">
    <div id="relative-auto" style="position:relative">
      <span id="positive" style="position:absolute;z-index:2;background:red">positive</span>
    </div>
    <div id="sibling" style="background:blue">sibling</div>
  </div>`, 30, 10);
  const relativeAuto = principalFragment(stacking, elementById(stacking, "relative-auto"));
  const positive = principalFragment(stacking, elementById(stacking, "positive"));
  assert.equal(stacking.layout.stacking(relativeAuto.id).establishesStackingContext, false);
  assert.equal(stacking.layout.stacking(positive.id).containingStackingContext, stacking.layout.root);
  const positivePaint = stacking.displayList.commands.find((command) => command.documentNode === elementById(stacking, "positive"));
  const siblingPaint = stacking.displayList.commands.find((command) => command.documentNode === elementById(stacking, "sibling"));
  assert.ok(positivePaint && siblingPaint && positivePaint.paintOrder > siblingPaint.paintOrder);

  const flexStacking = render(`<div style="display:flex;position:relative;width:60px;height:20px">
    <span id="flex-high" style="z-index:2;background:red;width:30px">high</span>
    <span id="flex-low" style="z-index:-1;background:blue;width:30px;margin-left:-30px">low</span>
  </div>`, 20, 8);
  const flexHighPaint = flexStacking.displayList.commands.find((command) => command.kind === "background"
    && command.documentNode === elementById(flexStacking, "flex-high"));
  const flexLowPaint = flexStacking.displayList.commands.find((command) => command.kind === "background"
    && command.documentNode === elementById(flexStacking, "flex-low"));
  assert.ok(flexHighPaint && flexLowPaint && flexHighPaint.paintOrder > flexLowPaint.paintOrder);

  const inlineSource = (left) => `<p style="margin:0;width:40px">
    <span id="offset-inline" style="position:relative;left:${String(left)}px">wrapped inline text</span>
  </p>`;
  const unshifted = render(inlineSource(0), 20, 10);
  const shifted = render(inlineSource(8), 20, 10);
  const unshiftedBox = principalFragment(unshifted, elementById(unshifted, "offset-inline"));
  const shiftedBox = principalFragment(shifted, elementById(shifted, "offset-inline"));
  assert.equal(shiftedBox.borderRect.x - unshiftedBox.borderRect.x, cssPx(8));
  assert.deepEqual(
    shiftedBox.inlineContinuations.map((continuation) => continuation.borderRect.x),
    unshiftedBox.inlineContinuations.map((continuation) => continuation.borderRect.x + cssPx(8))
  );
  const inlineText = (result, box) => result.layout.children(box.id)
    .filter((fragment) => fragment.kind === "text")
    .map((fragment) => fragment.borderRect.x);
  assert.deepEqual(
    inlineText(shifted, shiftedBox),
    inlineText(unshifted, unshiftedBox).map((coordinate) => coordinate + cssPx(8))
  );
});

test("relative positioning moves complete inline visual and interaction geometry", () => {
  const source = (left, width) => `<p style="margin:0;width:${String(width)}px">
    <a id="link" href="/next" dir="rtl" style="position:relative;left:${String(left)}px;
      padding:1px;border:1px solid;background:red"><span id="nested">Latin אבג text</span></a>
  </p>`;
  for (const width of [64, 240]) {
    const unshifted = render(source(0, width), 40, 12);
    const shifted = render(source(8, width), 40, 12);
    const unshiftedLink = elementById(unshifted, "link");
    const shiftedLink = elementById(shifted, "link");
    const unshiftedFragments = unshifted.layout.forDocumentNode(unshiftedLink)
      .filter((fragment) => fragment.kind === "box");
    const shiftedFragments = shifted.layout.forDocumentNode(shiftedLink)
      .filter((fragment) => fragment.kind === "box");
    assert.equal(shiftedFragments.length, unshiftedFragments.length);
    for (const [index, shiftedFragment] of shiftedFragments.entries()) {
      const unshiftedFragment = unshiftedFragments[index];
      assert.ok(unshiftedFragment);
      assert.equal(shiftedFragment.borderRect.x - unshiftedFragment.borderRect.x, cssPx(8));
      assert.deepEqual(
        shiftedFragment.inlineContinuations?.map((continuation) => continuation.borderRect.x),
        unshiftedFragment.inlineContinuations?.map((continuation) => continuation.borderRect.x + cssPx(8))
      );
    }
    const shiftedNested = principalFragment(shifted, elementById(shifted, "nested"));
    const unshiftedNested = principalFragment(unshifted, elementById(unshifted, "nested"));
    assert.equal(shiftedNested.borderRect.x - unshiftedNested.borderRect.x, cssPx(8));
    const unshiftedBackgrounds = unshifted.displayList.commands.filter((command) =>
      command.kind === "background" && command.documentNode === unshiftedLink);
    const shiftedBackgrounds = shifted.displayList.commands.filter((command) =>
      command.kind === "background" && command.documentNode === shiftedLink);
    assert.deepEqual(
      shiftedBackgrounds.map((command) => command.rect.x),
      unshiftedBackgrounds.map((command) => command.rect.x + cssPx(8))
    );
    assert.ok(shifted.terminal.hitTestIndex.regions.some((region) => region.action.node === shiftedLink));
    assert.ok(shifted.terminal.search("Latin אבג").ranges.length > 0);
  }
});

test("floats shorten line boxes, logical floats use computed direction, and clear applies clearance", () => {
  const result = render(`<div id="flow" style="width:120px;direction:rtl">
    <aside id="float" style="float:inline-start;width:24px;height:32px">F</aside>
    text wraps beside the floated box
    <div id="cleared" style="clear:inline-start;height:16px">clear</div>
  </div>`, 30, 20);
  const floated = principalFragment(result, elementById(result, "float"));
  const cleared = principalFragment(result, elementById(result, "cleared"));
  const flow = principalFragment(result, elementById(result, "flow"));
  assert.equal(floated.contentRect.width, cssPx(24));
  assert.ok(floated.borderRect.x > flow.contentRect.x);
  assert.ok(result.layout.lineBoxes.some((line) => line.rect.x + line.rect.width <= floated.marginRect.x));
  assert.ok(result.layout.lineBoxes.some((line) =>
    line.rect.y >= floated.marginRect.y + floated.marginRect.height && line.rect.width === flow.contentRect.width));
  assert.ok(cleared.borderRect.y >= floated.marginRect.y + floated.marginRect.height);
});

test("a block formatting context owns float exclusions while normal block border boxes remain full width", () => {
  const result = render(`<div id="context" style="width:300px;overflow:hidden">
    <aside id="float" style="float:left;width:80px;height:80px">float</aside>
    <p id="paragraph" style="border:1px solid">
      enough text to start beside the float and continue beneath it across several lines;
      repeated words keep wrapping until the float ends and then use the complete inline size
    </p>
  </div>`, 50, 20);
  const context = principalFragment(result, elementById(result, "context"));
  const paragraph = principalFragment(result, elementById(result, "paragraph"));
  const floated = principalFragment(result, elementById(result, "float"));
  assert.equal(paragraph.borderRect.width, context.contentRect.width);
  assert.ok(paragraph.lineBoxes.some((line) => line.rect.x >= floated.marginRect.x + floated.marginRect.width));
  assert.ok(paragraph.lineBoxes.some((line) => line.rect.y >= floated.marginRect.y + floated.marginRect.height
    && line.rect.width === paragraph.contentRect.width));

  const placement = render(`<div id="float-context" style="width:120px;overflow:hidden">
    <span id="first-float" style="float:left;width:70px;height:32px">first</span>
    <span id="second-float" style="float:left;width:60px;height:16px">second</span>
    <span id="right-float" style="float:right;width:20px;height:16px">right</span>
    <div id="negative-float" style="float:left;width:40px;height:16px;margin-right:-10px">negative</div>
    <div id="cleared-both" style="clear:both;height:8px">clear</div>
  </div>`, 30, 20);
  const firstFloat = principalFragment(placement, elementById(placement, "first-float"));
  const secondFloat = principalFragment(placement, elementById(placement, "second-float"));
  const rightFloat = principalFragment(placement, elementById(placement, "right-float"));
  const negativeFloat = principalFragment(placement, elementById(placement, "negative-float"));
  const clearedBoth = principalFragment(placement, elementById(placement, "cleared-both"));
  assert.ok(secondFloat.marginRect.y >= firstFloat.marginRect.y + firstFloat.marginRect.height);
  assert.ok(rightFloat.marginRect.x > secondFloat.marginRect.x);
  assert.equal(cssPixels(negativeFloat.marginRect.width), 30);
  assert.ok(clearedBoth.borderRect.y >= Math.max(
    secondFloat.marginRect.y + secondFloat.marginRect.height,
    rightFloat.marginRect.y + rightFloat.marginRect.height,
    negativeFloat.marginRect.y + negativeFloat.marginRect.height
  ));

  const nested = render(`<div id="outer" style="width:120px;overflow:hidden">
    <aside id="outer-float" style="float:left;width:40px;height:40px">float</aside>
    <section id="nested-bfc" style="display:flow-root">nested formatting context</section>
  </div>`, 30, 12);
  const outerFloat = principalFragment(nested, elementById(nested, "outer-float"));
  const nestedBfc = principalFragment(nested, elementById(nested, "nested-bfc"));
  assert.ok(nestedBfc.borderRect.x >= outerFloat.marginRect.x + outerFloat.marginRect.width
    || nestedBfc.borderRect.y >= outerFloat.marginRect.y + outerFloat.marginRect.height);
  assert.ok(nestedBfc.lineBoxes.every((line) => line.rect.x === nestedBfc.contentRect.x));
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

test("flex line cross sizes apply stretch, align-content, and column wrapping", () => {
  const single = render(`<div style="display:flex;width:100px;height:60px;align-items:stretch">
    <div id="auto">auto</div><div id="definite" style="height:10px">fixed</div></div>`, 30, 20);
  assert.equal(cssPixels(principalFragment(single, elementById(single, "auto")).marginRect.height), 60);
  assert.equal(cssPixels(principalFragment(single, elementById(single, "definite")).contentRect.height), 10);

  const wrapped = render(`<div style="display:flex;flex-wrap:wrap;width:100px;height:100px;align-content:stretch">
    <div id="row-one" style="width:60px">one</div><div id="row-two" style="width:60px">two</div></div>`, 30, 20);
  const rowOne = principalFragment(wrapped, elementById(wrapped, "row-one"));
  const rowTwo = principalFragment(wrapped, elementById(wrapped, "row-two"));
  assert.equal(cssPixels(rowOne.marginRect.height), 50);
  assert.equal(cssPixels(rowTwo.marginRect.height), 50);
  assert.equal(rowTwo.marginRect.y, rowOne.marginRect.y + rowOne.marginRect.height);

  const columns = render(`<div style="display:flex;flex-direction:column;flex-wrap:wrap;width:100px;height:60px;align-content:stretch">
    <div id="column-one" style="height:40px">one</div><div id="column-two" style="height:40px">two</div></div>`, 30, 20);
  const columnOne = principalFragment(columns, elementById(columns, "column-one"));
  const columnTwo = principalFragment(columns, elementById(columns, "column-two"));
  assert.equal(cssPixels(columnOne.marginRect.width), 50);
  assert.equal(cssPixels(columnTwo.marginRect.width), 50);
  assert.equal(columnTwo.marginRect.x, columnOne.marginRect.x + columnOne.marginRect.width);

  const wrapReverse = render(`<div style="display:flex;flex-wrap:wrap-reverse;align-content:flex-start;width:100px;height:100px">
    <div id="reverse-one" style="width:60px">one</div><div id="reverse-two" style="width:60px">two</div></div>`, 30, 20);
  assert.ok(principalFragment(wrapReverse, elementById(wrapReverse, "reverse-one")).marginRect.y
    > principalFragment(wrapReverse, elementById(wrapReverse, "reverse-two")).marginRect.y);

  const rtlColumns = render(`<div style="display:flex;direction:rtl;flex-direction:column;flex-wrap:wrap;
    align-content:flex-start;width:100px;height:60px">
    <div id="rtl-column-one" style="height:40px">one</div><div id="rtl-column-two" style="height:40px">two</div></div>`, 30, 20);
  assert.ok(principalFragment(rtlColumns, elementById(rtlColumns, "rtl-column-one")).marginRect.x
    > principalFragment(rtlColumns, elementById(rtlColumns, "rtl-column-two")).marginRect.x);

  const relaid = render(`<div style="display:flex;flex-direction:column;width:80px;align-items:stretch">
    <section id="item"><p id="paragraph">stretch relayout recalculates all descendant line boxes</p></section>
  </div>`, 30, 20);
  const stretchedItem = principalFragment(relaid, elementById(relaid, "item"));
  const stretchedParagraph = principalFragment(relaid, elementById(relaid, "paragraph"));
  assert.equal(cssPixels(stretchedItem.contentRect.width), 80);
  assert.ok(stretchedParagraph.lineBoxes.length > 1);
  assert.equal(
    cssPixels(stretchedParagraph.contentRect.height),
    stretchedParagraph.lineBoxes.reduce((height, line) => height + cssPixels(line.rect.height), 0)
  );
});

test("flexible-length resolution has deterministic work and cancellation boundaries", () => {
  const items = Array.from({ length: 2_000 }, (_, sourceIndex) => ({
    identity: sourceIndex,
    sourceIndex,
    order: 0,
    flexBaseSize: cssPx(1),
    hypotheticalMainSize: cssPx(1),
    minimumMainSize: cssPx(sourceIndex % 7),
    maximumMainSize: null,
    mainBorderPadding: ZERO,
    flexGrow: 1,
    flexShrink: 1,
    marginMainStart: ZERO,
    marginMainEnd: ZERO,
    autoMarginMainStart: false,
    autoMarginMainEnd: false
  }));
  assert.throws(() => resolveFlexLines({
    items,
    containerMainSize: cssPx(2_000),
    gap: ZERO,
    wrap: "nowrap",
    reverse: false,
    justifyContent: "start",
    maxSizingWork: 100
  }), /Flex sizing work budget/u);
  const controller = new globalThis.AbortController();
  controller.abort(new Error("cancel flex sizing"));
  assert.throws(() => resolveFlexLines({
    items,
    containerMainSize: cssPx(2_000),
    gap: ZERO,
    wrap: "nowrap",
    reverse: false,
    justifyContent: "start",
    signal: controller.signal
  }), /cancel flex sizing/u);

  const html = `<div style="display:flex">${"<span>item</span>".repeat(100)}</div>`;
  const first = render(html, 80, 24, { layout: { maxFlexSizingWork: 16 } });
  const second = render(html, 80, 24, { layout: { maxFlexSizingWork: 16 } });
  assert.equal(first.layout.outcome.status, "truncated");
  assert.equal(first.layout.outcome.budget, "maxFlexSizingWork");
  assert.equal(first.layout.outcome.limit, 16);
  assert.deepEqual(layoutPayload(first.layout), layoutPayload(second.layout));
  assert.equal(reachableFragments(first.layout).size, first.layout.outcome.fragments);

  const stretchTree = formatting(`<div style="display:flex;width:80px;height:64px;align-items:stretch">
    <section>one two three four</section><section>five six seven eight</section>
  </div>`, 20, 12);
  for (let maxFragments = 2; maxFragments <= 32; maxFragments += 1) {
    const stretched = renderFormatting(stretchTree, 20, 12, { layout: { maxFragments } });
    assert.equal(reachableFragments(stretched.layout).size, stretched.layout.outcome.fragments);
  }
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
    rasterizeTerminalDisplayList({
      displayList: narrowCells,
      textSearchIndex: normal.searchIndex
    }).cellBuffer,
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
    },
    {
      tree: formatting(`<p>abcdef</p>`, 20), columns: 20,
      budget: { maxCodePointsPerBidiParagraph: 3 }, expected: "maxCodePointsPerBidiParagraph"
    },
    {
      tree: formatting(`<p>abcdef</p>`, 20), columns: 20,
      budget: { maxBidiItems: 3 }, expected: "maxBidiItems"
    },
    {
      tree: formatting(`<p><span style="direction:rtl;unicode-bidi:embed">abc</span></p>`, 20), columns: 20,
      budget: { maxBidiEmbeddingDepth: 0 }, expected: "maxBidiEmbeddingDepth"
    },
    {
      tree: formatting(`<p>aאb</p>`, 20), columns: 20,
      budget: { maxBidiRuns: 1 }, expected: "maxBidiRuns"
    },
    {
      tree: formatting(`<p>abcdef</p>`, 20), columns: 20,
      budget: { maxGraphemeClusters: 3 }, expected: "maxGraphemeClusters"
    },
    {
      tree: formatting(`<p>abcdef</p>`, 20), columns: 20,
      budget: { maxBreakOpportunities: 3 }, expected: "maxBreakOpportunities"
    },
    {
      tree: formatting(`<p>aאb</p>`, 20), columns: 20,
      budget: { maxVisualRuns: 1 }, expected: "maxVisualRuns"
    },
    {
      tree: formatting(`<p style="width:1ch;overflow-wrap:anywhere">abc</p>`, 20), columns: 20,
      budget: { maxLineFragments: 1 }, expected: "maxLineFragments"
    }
  ];
  for (const fixture of cases) {
    const result = renderFormatting(fixture.tree, fixture.columns, 10, { layout: fixture.budget });
    assert.equal(result.layout.outcome.status, "truncated", fixture.expected);
    assert.equal(result.layout.outcome.budget, fixture.expected);
    const reached = reachableFragments(result.layout);
    assert.equal(reached.size, result.layout.outcome.fragments);
    for (const id of reached) {
      if (id !== result.layout.root) assert.ok(result.layout.parent(id));
    }
  }
});

test("logical line selection retains complete line prefixes and resolves preserved tabs at CSS tab stops", () => {
  const item = (logicalIndex, advance, breakBefore = "prohibited", tabInterval = null) => ({
    logicalIndex,
    advance: cssPx(advance),
    tabInterval: tabInterval === null ? null : cssPx(tabInterval),
    breakBefore,
    forcedBreak: false,
    collapsibleSpace: false,
    wrappingAllowed: true
  });
  const tabs = selectLogicalLines(
    [item(0, 1), item(1, 0, "prohibited", 4), item(2, 1)],
    cssPx(20),
    cssPx(20)
  );
  assert.equal(tabs.outcome.status, "complete");
  assert.equal(tabs.usedAdvances.get(1), cssPx(3));
  const zero = selectLogicalLines([item(0, 1)], cssPx(2), cssPx(2), { maxSelectedLines: 0 });
  assert.deepEqual(zero.outcome, {
    status: "truncated", lines: 0, budget: "maxSelectedLines", limit: 0
  });
  assert.equal(zero.retainedItems, 0);
  const prefix = selectLogicalLines(
    [item(0, 2), item(1, 2, "allowed"), item(2, 2, "allowed")],
    cssPx(2),
    cssPx(2),
    { maxSelectedLines: 2 }
  );
  assert.equal(prefix.outcome.status, "truncated");
  assert.equal(prefix.retainedItems, 2);
});

test("layout, display-list construction, and cell rasterization honor cancellation", () => {
  const tree = formatting(`<p>${"word ".repeat(100)}</p>`, 20);
  const textMeasurer = terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT);
  const layoutController = new globalThis.AbortController();
  layoutController.abort();
  assert.throws(() => buildLayoutFragmentTree({
    formatting: tree,
    inlineItemStreams: buildInlineItemStreamSet(tree),
    context: {
      viewport: { width: cssPx(160), height: cssPx(160) },
      textMeasurer,
      initialContainingBlock: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), cssPx(160), cssPx(160)),
      scrollport: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), cssPx(160), cssPx(160))
    },
    signal: layoutController.signal
  }), { name: "AbortError" });
  const complete = renderFormatting(tree, 20);
  const displayController = new globalThis.AbortController();
  displayController.abort();
  assert.throws(() => buildTerminalDisplayList({
    layout: complete.layout,
    context: complete.displayList.context,
    signal: displayController.signal
  }), { name: "AbortError" });
  const paintController = new globalThis.AbortController();
  const displayList = buildTerminalDisplayList({
    layout: complete.layout,
    context: complete.displayList.context
  });
  paintController.abort();
  assert.throws(() => rasterizeTerminalDisplayList({
    displayList,
    textSearchIndex: complete.searchIndex,
    signal: paintController.signal
  }), { name: "AbortError" });
});

test("terminal paint budgets truncate only the cell buffer", () => {
  const result = render(`<p>${"word ".repeat(30)}</p>`, 20, 10, { terminal: { maxRetainedPaintCells: 25 } });
  assert.equal(result.layout.outcome.status, "complete");
  assert.equal(result.terminal.cellBuffer.outcome.status, "truncated");
  assert.ok(result.terminal.cellBuffer.outcome.truncations.some((entry) => entry.budget === "maxRetainedPaintCells"));
  assert.match(renderedText(result), /^word word/u);
});

test("display-list budgets retain an ordered paint-command prefix", () => {
  const result = render(`<p>${"word ".repeat(30)}</p>`, 20, 10, { terminal: { maxDisplayListCommands: 3 } });
  assert.equal(result.layout.outcome.status, "complete");
  assert.equal(result.displayList.outcome.status, "truncated");
  assert.equal(result.displayList.outcome.budget, "maxDisplayListCommands");
  assert.equal(result.displayList.commands.length, 3);
  assert.ok(result.displayList.commands.every((command, index, commands) =>
    index === 0 || command.paintOrder >= commands[index - 1].paintOrder
  ));
  const grouped = render(`<div style="border:solid 8px;background:#123456">x</div>`, 20, 10, {
    terminal: { maxDisplayListCommands: 2 }
  });
  assert.equal(grouped.displayList.outcome.status, "truncated");
  assert.equal(grouped.displayList.commands.some((command) => command.kind === "border-side"), false);
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

test("fixed-point arithmetic saturates before unsafe intermediates and unions are iterative", () => {
  const maximum = cssLengthFromFixed(Number.MAX_SAFE_INTEGER);
  const minimum = cssLengthFromFixed(Number.MIN_SAFE_INTEGER);
  assert.equal(cssAdd(maximum, cssLengthFromFixed(1)), Number.MAX_SAFE_INTEGER);
  assert.equal(cssSubtract(minimum, cssLengthFromFixed(1)), Number.MIN_SAFE_INTEGER);
  assert.equal(cssDivide(maximum, Number.MIN_VALUE), Number.MAX_SAFE_INTEGER);
  assert.equal(cssDivide(maximum, -Number.MIN_VALUE), Number.MIN_SAFE_INTEGER);
  assert.equal(cssMultiply(maximum, 200), Number.MAX_SAFE_INTEGER);
  assert.equal(cssMultiply(minimum, 200), Number.MIN_SAFE_INTEGER);
  assert.equal(cssMultiply(cssPx(1_000_000_000), 1_000_000), Number.MAX_SAFE_INTEGER);
  const positive = cssRect(
    cssCoordinateFromFixed(Number.MAX_SAFE_INTEGER - 128),
    cssCoordinateFromFixed(Number.MAX_SAFE_INTEGER - 128),
    cssLengthFromFixed(256),
    cssLengthFromFixed(256)
  );
  const overlap = cssRect(
    cssCoordinateFromFixed(Number.MAX_SAFE_INTEGER - 64),
    cssCoordinateFromFixed(Number.MAX_SAFE_INTEGER - 64),
    cssLengthFromFixed(64),
    cssLengthFromFixed(64)
  );
  assert.deepEqual(cssIntersection(positive, overlap), overlap);
  const rectangles = Array.from({ length: 150_000 }, (_, index) => cssRect(
    cssCoordinateFromFixed(index - 75_000),
    cssCoordinateFromFixed(index - 75_000),
    cssLengthFromFixed(1),
    cssLengthFromFixed(1)
  ));
  rectangles.push(positive);
  rectangles.push(cssRect(
    cssCoordinateFromFixed(Number.MIN_SAFE_INTEGER),
    cssCoordinateFromFixed(Number.MIN_SAFE_INTEGER),
    cssLengthFromFixed(1),
    cssLengthFromFixed(1)
  ));
  const united = cssUnion(rectangles, overlap);
  assert.equal(united.x, Number.MIN_SAFE_INTEGER);
  assert.equal(united.y, Number.MIN_SAFE_INTEGER);
  for (const value of [united.x, united.y, united.width, united.height]) {
    assert.equal(isSafeCssFixedValue(value), true);
    assert.equal(Number.isNaN(value), false);
  }
  assert.deepEqual(cssUnion(rectangles, overlap), united);
  const viewportUnits = render(`<div id="extreme" style="width:9999999999999999vw;
    height:9999999999999999vh;padding:9999999999999999%"></div>`, 20, 5, {
    terminal: { maxRetainedCellBufferRows: 3 }
  });
  const extreme = principalFragment(viewportUnits, elementById(viewportUnits, "extreme"));
  for (const value of Object.values(extreme.borderRect)) {
    assert.equal(isSafeCssFixedValue(value), true);
    assert.equal(Number.isNaN(value), false);
  }
});

test("terminal budgets bound huge geometry even when the page paints no cells", () => {
  const budgets = {
    maxRetainedCellBufferRows: 3,
    maxRetainedCellBufferColumns: 12,
    maxGeneratedPaintUnits: 8,
    maxRetainedPaintCells: 8
  };
  const empty = render(`<div style="height:1000000000px"></div>`, 20, 5, { terminal: budgets });
  assert.equal(empty.terminal.cellBuffer.rows.length, 3);
  assert.equal(empty.terminal.cellBuffer.outcome.status, "truncated");
  assert.ok(empty.terminal.truncations.some((entry) => entry.budget === "maxRetainedCellBufferRows"));
  assert.equal(empty.layout.outcome.status, "complete");
  const bordered = render(`<div style="height:1000000000px;border:solid 8px"></div>`, 20, 5, {
    terminal: { ...budgets, maxGeneratedPaintUnits: 2 }
  });
  assert.ok(bordered.terminal.truncations.some((entry) => entry.budget === "maxGeneratedPaintUnits"));
  assert.ok(bordered.terminal.cellBuffer.rows.length <= 3);
  assert.ok(bordered.terminal.cellBuffer.outcome.cells <= 8);
  const clippedSides = render(`<div id="bordered" style="height:1000000000px;
    border-style:solid;border-width:8px 1000000000px 1000000000px 8px"></div>`, 20, 5, {
    terminal: { maxRetainedCellBufferRows: 4, maxGeneratedPaintUnits: 1_000 }
  });
  const borderedFragment = principalFragment(clippedSides, elementById(clippedSides, "bordered"));
  const retainedCommands = clippedSides.terminal.cellBuffer.rows
    .flatMap((row) => row.cells)
    .filter((cell) => cell.layoutFragment === borderedFragment.id)
    .map((cell) => cell.command);
  assert.ok(retainedCommands.some((command) => command.includes("border-top")));
  assert.ok(retainedCommands.some((command) => command.includes("border-left")));
  assert.equal(retainedCommands.some((command) => command.includes("border-bottom")), false);
  assert.equal(retainedCommands.some((command) => command.includes("border-right")), false);
  const negative = render(`<div style="height:2em;margin-top:-1000000000px;background:#f00"></div>`, 20, 5, {
    terminal: budgets
  });
  assert.ok(negative.terminal.cellBuffer.rows.length <= 3);
});

test("text and border paint-unit generation remain cancellable and prefix deterministic", () => {
  const text = render(`<p>${"a".repeat(2_000)}</p>`, 2_100, 5, {
    terminal: { maxGeneratedPaintUnits: 50, maxRetainedPaintCells: 100 }
  });
  assert.ok(text.terminal.truncations.some((entry) => entry.budget === "maxGeneratedPaintUnits"));
  const repeated = render(`<p>${"a".repeat(2_000)}</p>`, 2_100, 5, {
    terminal: { maxGeneratedPaintUnits: 50, maxRetainedPaintCells: 100 }
  });
  assert.deepEqual(text.terminal.cellBuffer.rows, repeated.terminal.cellBuffer.rows);
  const bordered = render(`<div style="width:2000px;height:2000px;border:solid 8px"></div>`, 300, 200);
  let checks = 0;
  const signal = {
    throwIfAborted() {
      checks += 1;
      if (checks === 20) throw new globalThis.DOMException("cancelled", "AbortError");
    }
  };
  assert.throws(
    () => rasterizeTerminalDisplayList({
      displayList: bordered.displayList,
      textSearchIndex: bordered.searchIndex,
      signal
    }),
    { name: "AbortError" }
  );
});

test("terminal budget validation keeps zero as no-work and rejects malformed limits", () => {
  const zero = render(`<p>visible</p>`, 20, 5, {
    terminal: { maxGeneratedPaintUnits: 0, maxRetainedPaintCells: 0 }
  });
  assert.equal(zero.terminal.cellBuffer.outcome.status, "truncated");
  assert.equal(zero.terminal.cellBuffer.outcome.cells, 0);
  assert.ok(zero.terminal.truncations.some((entry) => entry.budget === "maxGeneratedPaintUnits"));
  const invalid = render(`<p>visible</p>`, 20, 5, {
    terminal: { maxGeneratedPaintUnits: -1 }
  });
  assert.deepEqual(invalid.displayList.outcome, { status: "rejected", reason: "invalid-budget" });
  assert.deepEqual(invalid.terminal.cellBuffer.outcome, { status: "rejected", reason: "invalid-budget" });
  const malformedList = buildTerminalDisplayList({
    layout: zero.layout,
    context: {
      ...zero.displayList.context,
      budgets: undefined,
      cellMeasurer: {
        width() { return Number.NaN; }
      }
    }
  });
  const malformed = rasterizeTerminalDisplayList({
    displayList: malformedList,
    textSearchIndex: zero.searchIndex
  });
  assert.deepEqual(malformed.cellBuffer.outcome, {
    status: "rejected",
    reason: "invalid-cell-measurement"
  });
});

test("terminal actual values preserve every grapheme at all supported CSS font sizes", () => {
  const sizes = [0, 1, 4, 8, 12, 16, 24, 32];
  for (const size of sizes) {
    const result = render(`<span style="font-size:${String(size)}px">abcdef</span>`, 80, 10);
    const text = result.terminal.cellBuffer.rows.flatMap((row) => row.cells)
      .filter((cell) => result.displayList.commands.find((command) => command.id === cell.command)?.kind === "text")
      .map((cell) => cell.text)
      .join("");
    assert.equal(text, "abcdef", `font-size ${String(size)}px`);
  }
  for (const [sample, actual] of [
    ["العربية", "ةيبرعلا"],
    ["עברית", "תירבע"],
    ["e\u0301", "e\u0301"],
    ["👍🏽", "👍🏽"],
    ["👩‍👩‍👧‍👦", "👩‍👩‍👧‍👦"],
    ["🇲🇦", "🇲🇦"],
    ["界", "界"],
    ["a界👍🏽b", "a界👍🏽b"]
  ]) {
    const result = render(`<span>${sample}</span>`, 80, 10);
    const text = result.terminal.cellBuffer.rows.flatMap((row) => row.cells)
      .filter((cell) => result.displayList.commands.find((command) => command.id === cell.command)?.kind === "text")
      .map((cell) => cell.text)
      .join("");
    assert.equal(text, actual);
  }
  const highlighted = render(`<span>a👍🏽b</span>`, 20, 10);
  const highlight = highlighted.terminal.search("👍🏽").ranges[0];
  assert.ok(highlight);
  const highlightedRow = highlighted.terminal.cellBuffer.rows[highlight.row];
  assert.equal(highlightedRow?.text.slice(highlight.startCodeUnit, highlight.endCodeUnit), "👍🏽");
  const clippedWide = render(`<div style="width:1ch;overflow:hidden;white-space:nowrap">界</div>`, 20, 10);
  assert.doesNotMatch(renderedText(clippedWide), /界/u);
  assert.equal(clippedWide.terminal.cellBuffer.rows.flatMap((row) => row.cells)
    .some((cell) => cell.text === "界"), false);
});

test("bidi paragraphs span inline boxes while tree paint order retains fragment identities", () => {
  const result = render(`<p id="mixed">abc <span>אבג</span> 123</p>`, 20);
  const paragraph = principalFragment(result, elementById(result, "mixed"));
  assert.equal(paragraph.lineBoxes.length, 1);
  assert.deepEqual(
    paragraph.lineBoxes[0].visualRuns.map(({ direction, embeddingLevel }) => [direction, embeddingLevel]),
    [["ltr", 0], ["ltr", 2], ["rtl", 1]]
  );
  assert.equal(renderedText(result), "abc 123 גבא");
  assert.equal(
    result.displayList.commands.filter((command) => command.kind === "text").map((command) => command.text).join(""),
    "abc גבא 123"
  );
  const narrow = render(`<p>abc <span>אבג</span> 123</p>`, 8).terminal.search("אבג");
  const wide = result.terminal.search("אבג");
  assert.equal(narrow.matches[0]?.id, wide.matches[0]?.id);
  const oppositeDirection = render(`<p dir="rtl">abc <span>אבג</span> 123</p>`, 20).terminal.search("אבג");
  assert.equal(oppositeDirection.matches[0]?.id, wide.matches[0]?.id);
  const acrossRuns = result.terminal.search("c אב");
  assert.equal(acrossRuns.matches.length, 1);
  assert.ok(acrossRuns.ranges.length >= 3);
  assert.equal(wide.ranges.length, 3);
  assert.equal(
    [...wide.ranges].sort((left, right) => left.startCodeUnit - right.startCodeUnit)
      .map((range) => result.terminal.cellBuffer.rows.find((row) => row.row === range.row)?.text
      .slice(range.startCodeUnit, range.endCodeUnit)).join(""),
    "גבא"
  );
  assert.deepEqual(
    wide.ranges.map((range) => range.sourceRange && result.formatting.document.sourceText
      .slice(range.sourceRange.start, range.sourceRange.end)),
    ["א", "ב", "ג"]
  );
});

test("atomic inline visual geometry does not replace CSS tree paint order", () => {
  const result = render(`<p dir="rtl" style="margin:0"><a id="a" href="/a"
    style="display:inline-block;padding:8px;border:solid 8px;background:#224466">A</a><a id="b" href="/b"
    style="display:inline-block;padding:8px;border:solid 8px;background:#662244">B</a></p>`, 20, 10);
  const first = principalFragment(result, elementById(result, "a"));
  const second = principalFragment(result, elementById(result, "b"));
  const paintSequence = result.displayList.commands.flatMap((command) => {
    if (command.kind === "background" && command.layoutFragment === first.id) return ["background:A"];
    if (command.kind === "background" && command.layoutFragment === second.id) return ["background:B"];
    if (command.kind === "text" && (command.text === "A" || command.text === "B")) return [`text:${command.text}`];
    return [];
  });
  assert.deepEqual(paintSequence, ["background:A", "text:A", "background:B", "text:B"]);
  assert.ok(first.borderRect.x > second.borderRect.x);
  assert.ok(result.terminal.hitTestIndex.regions.some((region) => region.action.node === elementById(result, "a")));
  assert.ok(result.terminal.hitTestIndex.regions.some((region) => region.action.node === elementById(result, "b")));
});

test("bidi inline backgrounds keep their own fragments and CSS paint phases", () => {
  const result = render(`<p dir="rtl"><span id="red" style="background:red;padding:8px;border:solid 8px">A</span>
    <span id="blue" style="background:blue;padding:8px;border:solid 8px">B</span></p>`, 30, 10);
  const redNode = elementById(result, "red");
  const blueNode = elementById(result, "blue");
  const red = result.layout.forDocumentNode(redNode).find((fragment) => fragment.kind === "box");
  const blue = result.layout.forDocumentNode(blueNode).find((fragment) => fragment.kind === "box");
  assert.ok(red);
  assert.ok(blue);
  const descendsFrom = (fragment, ancestor) => {
    let current = result.layout.fragment(fragment);
    while (current.id !== ancestor) {
      const parent = result.layout.parent(current.id);
      if (parent === null) return false;
      current = parent;
    }
    return true;
  };
  assert.ok(red.borderRect.width > 0);
  assert.ok(blue.borderRect.width > 0);
  assert.notEqual(red.borderRect.x, blue.borderRect.x);
  const redCommands = result.displayList.commands.filter((command) => command.documentNode === redNode);
  const blueCommands = result.displayList.commands.filter((command) => command.documentNode === blueNode);
  assert.ok(redCommands.length > 0);
  assert.ok(blueCommands.length > 0);
  assert.ok(redCommands.every((command) => command.layoutFragment === red.id
    || result.layout.parent(command.layoutFragment)?.id === red.id));
  assert.ok(blueCommands.every((command) => command.layoutFragment === blue.id
    || result.layout.parent(command.layoutFragment)?.id === blue.id));
  const redBackground = result.displayList.commands.findIndex(
    (command) => command.kind === "background" && command.layoutFragment === red.id
  );
  const redText = result.displayList.commands.findIndex(
    (command) => command.kind === "text" && descendsFrom(command.layoutFragment, red.id)
  );
  const blueBackground = result.displayList.commands.findIndex(
    (command) => command.kind === "background" && command.layoutFragment === blue.id
  );
  const blueText = result.displayList.commands.findIndex(
    (command) => command.kind === "text" && descendsFrom(command.layoutFragment, blue.id)
  );
  assert.ok(redBackground >= 0 && redBackground < redText);
  assert.ok(blueBackground > redText && blueBackground < blueText);
});

test("paragraph direction, overrides, logical alignment, and per-line bidi reordering are used during layout", () => {
  const rtl = render(`<p dir="rtl">אבג (123) abc</p>`, 20);
  assert.equal(renderedText(rtl).trimStart(), "abc (123) גבא");
  const overridden = render(`<p><bdo dir="rtl">abc</bdo></p>`, 20);
  assert.equal(renderedText(overridden), "cba");
  const wrapped = render(`<p style="width:5ch;overflow-wrap:anywhere">abcאבג123</p>`, 20);
  assert.deepEqual(wrapped.terminal.cellBuffer.rows.map((row) => row.text), ["abcבא", "123ג"]);
  assert.deepEqual(
    wrapped.layout.lineBoxes.map((line) => line.breakCause),
    ["wrap", "end-of-paragraph"]
  );
});

test("wbr and manual soft hyphens create source-linked break opportunities without changing logical search text", () => {
  const wordBreak = render(`<p style="width:2ch">ab<wbr>cd</p>`, 20);
  assert.deepEqual(wordBreak.terminal.cellBuffer.rows.map((row) => row.text), ["ab", "cd"]);
  assert.equal(wordBreak.searchIndex.text.includes("\u200b"), false);
  assert.equal(wordBreak.terminal.search("abcd").matches.length, 1);

  const brokenHyphen = render(`<p style="width:3ch">ab\u00adcd</p>`, 20);
  assert.deepEqual(brokenHyphen.terminal.cellBuffer.rows.map((row) => row.text), ["ab-", "cd"]);
  assert.equal(brokenHyphen.terminal.search("abcd").matches.length, 1);
  const unbrokenHyphen = render(`<p style="width:10ch">ab\u00adcd</p>`, 20);
  assert.equal(renderedText(unbrokenHyphen), "abcd");
  const disabled = render(`<p style="width:3ch;hyphens:none">ab\u00adcd</p>`, 20);
  assert.equal(renderedText(disabled), "abcd");
  assert.equal(disabled.layout.lineBoxes.length, 1);
});

test("preserved tabs use inherited CSS tab-size and plaintext chooses each paragraph base direction", () => {
  const tabs = render(`<pre style="margin:0;tab-size:4">a\tb</pre>`, 20);
  assert.equal(renderedText(tabs), "a   b");
  assert.equal(tabs.terminal.search("a b").matches.length, 1);
  const plaintext = render(`<pre dir="auto" style="margin:0">abc\nאבג</pre>`, 20);
  assert.deepEqual(plaintext.terminal.cellBuffer.rows.map((row) => row.text.trimStart()), ["abc", "גבא"]);
  assert.deepEqual(
    plaintext.terminal.cellBuffer.rows.map((row) => row.cells.find((cell) => cell.text.length > 0)?.column),
    [0, 17]
  );

  const rtlIndent = render(`<p dir="rtl" style="margin:0;width:10ch;text-indent:2ch">אבג</p>`, 20);
  assert.equal(rtlIndent.terminal.cellBuffer.rows[0]?.cells.find((cell) => cell.text.length > 0)?.column, 5);
});

test("inline formatting contexts remain atomic line participants", () => {
  const cases = [
    ["inline-block", `<span style="display:inline-block;padding:8px;border:solid 8px">B</span>`],
    ["inline-table", `<span style="display:inline-table"><span style="display:table-row"><span style="display:table-cell">T</span></span></span>`],
    ["inline-flex", `<span style="display:inline-flex"><span>F</span></span>`],
    ["inline-grid", `<span style="display:inline-grid;grid-template-columns:2ch"><span>G</span></span>`]
  ];
  for (const [name, atomic] of cases) {
    const result = render(`lead${atomic}tail`, 40, 10);
    const painted = result.terminal.cellBuffer.rows.flatMap((row) => row.cells).map((cell) => cell.text).join("");
    assert.match(painted, /lead/u, name);
    assert.match(painted, /tail/u, name);
    assert.equal(result.layout.lineBoxes.some((line) => line.fragments.some((id) => {
      const node = result.formatting.node(result.layout.fragment(id).formattingNode);
      return node.outer === "inline" && ["inline-container", "table-wrapper", "flex-container", "grid-container"].includes(node.kind);
    })), true, name);
  }
  const overwide = render(`lead<span id="wide" style="display:inline-block;width:100ch">wide</span>tail`, 20, 10);
  assert.ok(principalFragment(overwide, elementById(overwide, "wide")).borderRect.width > cssPx(160));
});

test("atomic inline boxes retain baselines, nested formatting contexts, actions, and wrapping", () => {
  const baseline = render(`lead<a id="atomic" href="/next" style="display:inline-block;width:6ch;padding:8px;
    border:solid 1px;background:#246"><span id="nested" style="display:inline-flex"><span>N</span></span></a>tail`, 12, 20);
  const atomicNode = elementById(baseline, "atomic");
  const atomic = principalFragment(baseline, atomicNode);
  const nested = principalFragment(baseline, elementById(baseline, "nested"));
  assert.ok(atomic.baseline !== null && atomic.usedFontMetrics !== null);
  assert.ok(atomic.children.includes(nested.id) || baseline.layout.parent(nested.id) !== null);
  assert.ok(baseline.layout.lineBoxes.some((line) => line.fragments.includes(atomic.id)));
  assert.ok(baseline.layout.lineBoxes.length >= 2);
  assert.ok(baseline.displayList.commands.some((command) => command.layoutFragment === atomic.id
    && command.kind === "background"));
  assert.ok(baseline.displayList.commands.some((command) => command.layoutFragment === atomic.id
    && command.kind === "border-side"));
  assert.ok(baseline.terminal.focusMap.forNode(atomicNode)?.rects.length > 0);
  assert.ok(baseline.terminal.hitTestIndex.regions.some((region) => region.action.node === atomicNode));
  assert.match(renderedText(baseline), /lead/u);
  assert.match(renderedText(baseline), /N/u);
  assert.match(renderedText(baseline), /tail/u);

  const normal = render(`x<span id="atom" style="display:inline-block">A</span>`, 20);
  const raised = render(`x<span id="atom" style="display:inline-block;vertical-align:super">A</span>`, 20);
  const normalAtom = principalFragment(normal, elementById(normal, "atom"));
  const raisedAtom = principalFragment(raised, elementById(raised, "atom"));
  const normalLine = normal.layout.lineBoxes.find((line) => line.fragments.includes(normalAtom.id));
  const raisedLine = raised.layout.lineBoxes.find((line) => line.fragments.includes(raisedAtom.id));
  assert.ok(normalLine && raisedLine);
  assert.equal(raisedAtom.borderRect.height, normalAtom.borderRect.height);
  assert.ok(raisedLine.ascent > normalLine.ascent);
  assert.ok(raisedLine.baseline > normalLine.baseline);
  assert.ok(raisedLine.rect.height > normalLine.rect.height);
});

test("splittable inline boxes retain per-line decoration geometry without empty continuations", () => {
  const result = render(`<span id="decorated" style="padding:0 8px;border:solid 1px;background:#336699">
    one two three four five</span>`, 8, 20);
  const node = elementById(result, "decorated");
  const fragment = result.layout.forDocumentNode(node).find((candidate) =>
    candidate.kind === "box" && candidate.inlineContinuations?.length > 1
  );
  assert.ok(fragment);
  assert.ok(fragment.inlineContinuations.every((entry) => entry.borderRect.width > 0 && entry.borderRect.height > 0));
  assert.equal(new Set(fragment.inlineContinuations.map((entry) => entry.borderRect.y)).size, fragment.inlineContinuations.length);
  assert.equal(
    result.displayList.commands.filter((command) => command.layoutFragment === fragment.id && command.kind === "background").length,
    fragment.inlineContinuations.length
  );
  for (const continuation of fragment.inlineContinuations) {
    const row = Math.max(0, Math.floor(continuation.borderRect.y / ROW_HEIGHT));
    const column = Math.max(0, Math.floor(continuation.borderRect.x / CELL_WIDTH));
    assert.equal(result.terminal.hitTestIndex.at(row, column), null);
  }
});

test("computed root font metrics own rem used values", () => {
  const pxRoot = render(`<style>html{font-size:20px}#x{width:2rem;height:2rem;margin:1rem;padding:1rem;
    border:solid .25rem;line-height:2rem}#raised{vertical-align:1rem}</style>
    <div id="x"><span id="raised">x</span></div>`, 80);
  assert.equal(pxRoot.layout.rootFontMetrics.fontSize, cssPx(20));
  const rootSized = principalFragment(pxRoot, elementById(pxRoot, "x"));
  assert.equal(rootSized.contentRect.width, cssPx(40));
  assert.equal(rootSized.contentRect.height, cssPx(40));
  assert.equal(rootSized.paddingRect.width - rootSized.contentRect.width, cssPx(40));
  assert.equal(rootSized.borderRect.width - rootSized.paddingRect.width, cssPx(10));
  assert.ok(rootSized.marginRect.width - rootSized.borderRect.width >= cssPx(40));
  assert.ok(pxRoot.layout.lineBoxes.some((line) => line.rect.height >= cssPx(40)));
  const inheritedText = [...reachableFragments(pxRoot.layout)]
    .map((id) => pxRoot.layout.fragment(id))
    .find((fragment) => fragment.kind === "text" && fragment.text === "x");
  assert.equal(inheritedText?.usedFontMetrics.fontSize, cssPx(20));
  const resizedRoot = renderFormatting(pxRoot.formatting, 40, 10);
  assert.equal(resizedRoot.layout.rootFontMetrics.fontSize, cssPx(20));
  const emRoot = render(`<style>html{font-size:2em}#x{width:1rem}</style><div id="x">x</div>`, 80);
  assert.equal(emRoot.layout.rootFontMetrics.fontSize, cssPx(32));
  assert.equal(principalFragment(emRoot, elementById(emRoot, "x")).contentRect.width, cssPx(32));
  const remRoot = render(`<style>html{font-size:2rem}#x{width:1rem}</style><div id="x">x</div>`, 80);
  assert.equal(remRoot.layout.rootFontMetrics.fontSize, cssPx(32));
  const changed = render(`<style>html{font-size:12px}#x{width:1rem}</style><div id="x">x</div>`, 40);
  assert.equal(changed.layout.rootFontMetrics.fontSize, cssPx(12));
  assert.equal(principalFragment(changed, elementById(changed, "x")).contentRect.width, cssPx(12));
});

test("paint commands cover empty backgrounds, side borders, phases, and alpha compositing", () => {
  const result = render(`<div id="parent" style="height:2em;padding:8px;background:rgba(255,0,0,.5);
    border-style:solid;border-width:8px 0 0 8px"><span id="child" style="background:rgba(0,0,255,.5)">x</span></div>`, 20);
  const parent = principalFragment(result, elementById(result, "parent"));
  const parentCommands = result.displayList.commands.filter((command) => command.layoutFragment === parent.id);
  assert.deepEqual(parentCommands.map((command) => command.kind), ["background", "border-side", "border-side"]);
  assert.ok(parentCommands.every((command, index) => index === 0 || command.paintOrder > parentCommands[index - 1].paintOrder));
  assert.ok(result.terminal.cellBuffer.rows.flatMap((row) => row.cells).some((cell) => cell.text === " " && cell.style.background !== null));
  const textCell = result.terminal.cellBuffer.rows.flatMap((row) => row.cells).find((cell) => cell.text === "x");
  assert.ok(textCell?.style.background);
  assert.ok(textCell.style.background.a > 0.5 && textCell.style.background.a < 1);
  const monochrome = render(`<div style="background:rgba(255,0,0,.5);height:1em"></div>`, 10, 5, {}, { colorDepth: 0 });
  assert.ok(monochrome.terminal.cellBuffer.rows.flatMap((row) => row.cells).every((cell) => cell.style.background === null));
});

test("paint order covers empty and overlapping boxes plus the supported table background stack", () => {
  const overlap = render(`<div id="first" style="height:16px;background:#f00"></div>
    <div id="second" style="height:16px;margin-top:-16px;background:#00f"></div>`, 20, 10);
  const first = principalFragment(overlap, elementById(overlap, "first"));
  const second = principalFragment(overlap, elementById(overlap, "second"));
  const firstPaint = overlap.displayList.commands.find((command) => command.layoutFragment === first.id
    && command.kind === "background");
  const secondPaint = overlap.displayList.commands.find((command) => command.layoutFragment === second.id
    && command.kind === "background");
  assert.ok(firstPaint && secondPaint && firstPaint.paintOrder < secondPaint.paintOrder);
  assert.ok(overlap.terminal.cellBuffer.rows.flatMap((row) => row.cells)
    .some((cell) => cell.command === secondPaint.id && cell.text === " "));

  const table = render(`<style>
    table{background:#100}tbody{background:#200}tr{background:#300}td{background:#400}
    </style><table id="table"><tbody id="group"><tr id="row"><td id="cell">cell</td></tr></tbody></table>`, 20, 10);
  const tableNodes = ["table", "group", "row", "cell"].map((id) => elementById(table, id));
  const backgroundOrders = tableNodes.map((node) => table.displayList.commands.find((command) =>
    command.documentNode === node && command.kind === "background"
  )?.paintOrder);
  assert.ok(backgroundOrders.every((order) => order !== undefined));
  assert.deepEqual(backgroundOrders, [...backgroundOrders].sort((left, right) => left - right));
  const cellText = table.displayList.commands.find((command) => command.kind === "text" && command.text === "cell");
  assert.ok(cellText && cellText.paintOrder > (backgroundOrders.at(-1) ?? -1));
});

test("pointer, focus, accessibility, scroll, and search geometry have separate contracts", () => {
  const result = render(`<a id="link" href="/next" style="display:inline-block;padding:8px">text</a>
    <a id="clipped" href="/hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">hidden</a>`, 30);
  const link = elementById(result, "link");
  const linkBox = principalFragment(result, link);
  const paddingRegion = result.terminal.hitTestIndex.regions.find((entry) => entry.layoutFragment === linkBox.id);
  assert.ok(paddingRegion);
  assert.equal(
    result.terminal.hitTestIndex.at(paddingRegion.rect.row, paddingRegion.rect.column)?.action.node,
    link,
    JSON.stringify(result.terminal.hitTestIndex.regions)
  );
  const clipped = elementById(result, "clipped");
  assert.equal(result.terminal.focusMap.forNode(clipped)?.rects.length, 0);
  assert.ok(result.terminal.accessibilityBounds.some((entry) => entry.documentNode === clipped
    && entry.rect.width === 0 && entry.rect.height === 0));
  assert.ok(result.terminal.scrollAnchors.some((entry) => entry.documentNode === clipped));
  assert.equal(result.terminal.search("hidden").ranges.length, 0);
});

test("zero-area CSS clipping remains empty after cell snapping", () => {
  const result = render(`<a href="/next" style="position:absolute;width:8px;height:16px;clip-path:inset(50%)">x</a>`, 20);
  assert.equal(result.terminal.hitTestIndex.regions.length, 0);
  assert.equal(result.terminal.cellBuffer.rows.flatMap((row) => row.cells).some((cell) => cell.text === "x"), false);
  assert.equal(result.terminal.search("x").ranges.length, 0);
});

test("terminal index budgets preserve deterministic box-derived prefixes", () => {
  const html = Array.from({ length: 50 }, (_, index) => `<a href="/${String(index)}">link${String(index)}</a>`).join(" ");
  const terminal = {
    maxRetainedHitTestRegions: 3,
    maxRetainedFocusRectangles: 4,
    maxRetainedAccessibilityRectangles: 5,
    maxRetainedDocumentRectangles: 6,
    maxRetainedScrollAnchors: 7,
    maxRetainedSearchCellSpans: 8
  };
  const first = render(html, 80, 20, { terminal });
  const second = render(html, 80, 20, { terminal });
  assert.deepEqual(first.terminal.hitTestIndex.regions, second.terminal.hitTestIndex.regions);
  assert.deepEqual(first.terminal.focusMap.targets, second.terminal.focusMap.targets);
  assert.ok(first.terminal.hitTestIndex.regions.length <= 3);
  assert.ok(first.terminal.focusMap.targets.flatMap((target) => target.rects).length <= 4);
  const linkNodes = first.formatting.document.links.map((link) => link.node);
  const retainedAccessibleLinks = first.terminal.accessibilityBounds
    .map((entry) => entry.documentNode)
    .filter((node) => linkNodes.includes(node));
  assert.deepEqual(retainedAccessibleLinks, linkNodes.slice(0, retainedAccessibleLinks.length));
  const retainedScrollLinks = first.terminal.scrollAnchors
    .map((entry) => entry.documentNode)
    .filter((node) => linkNodes.includes(node));
  assert.deepEqual(retainedScrollLinks, linkNodes.slice(0, retainedScrollLinks.length));
  for (const budget of [
    "maxRetainedHitTestRegions",
    "maxRetainedFocusRectangles",
    "maxRetainedAccessibilityRectangles",
    "maxRetainedDocumentRectangles",
    "maxRetainedScrollAnchors"
  ]) assert.ok(first.terminal.truncations.some((entry) => entry.budget === budget), budget);
});
