import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

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
import { renderDocument } from "../../dist/presentation/pipeline.js";
import {
  embeddedStylesheetSources,
  implementationSupportsCondition,
  resolveStyles
} from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);
const ZERO = cssPx(0);

test("table standards adaptations pin WPT and HTML provenance", () => {
  const provenance = JSON.parse(readFileSync(
    new URL("../fixtures/wpt-table-provenance.json", import.meta.url),
    "utf8"
  ));
  assert.match(provenance.wptCommit, /^[0-9a-f]{40}$/u);
  assert.match(provenance.htmlCommit, /^[0-9a-f]{40}$/u);
  assert.match(provenance.license, /BSD/u);
  assert.ok(provenance.adaptations.length >= 25);
  assert.ok(provenance.adaptations.every((entry) =>
    typeof entry.source === "string" && entry.source.length > 0
      && typeof entry.behavior === "string" && entry.behavior.length > 0
      && typeof entry.terminalAdjustment === "string" && entry.terminalAdjustment.length > 0
      && typeof entry.license === "string" && entry.license.length > 0));
});

function environment(columns, rows) {
  return {
    viewportWidthCssPx: columns * 8,
    viewportHeightCssPx: rows * 16,
    mediaType: "screen",
    prefersColorScheme: "light",
    reducedMotion: false,
    hover: "hover",
    pointer: "fine"
  };
}

function render(html, columns = 60, rows = 40, layoutBudgets) {
  const document = parseWebDocument(html, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const state = createDocumentState(document);
  const resources = embeddedStylesheetSources(document);
  const width = cssLengthFromFixed(columns * CELL_WIDTH);
  const height = cssLengthFromFixed(rows * ROW_HEIGHT);
  const pipeline = renderDocument({
    document,
    state,
    resources,
    mediaEnvironment: environment(columns, rows),
    layoutContext: {
      viewport: { width, height },
      textMeasurer: terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT),
      initialContainingBlock: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), width, height),
      scrollport: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), width, height),
      ...(layoutBudgets === undefined ? {} : { budgets: layoutBudgets })
    },
    terminalContext: {
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
  return { document, state, resources, pipeline };
}

function fragmentFor(result, id, formattingKind) {
  const node = result.document.elementById(id);
  assert.ok(node, `Missing #${id}`);
  const fragment = result.pipeline.layout.forDocumentNode(node).find((candidate) =>
    candidate.kind === "box"
      && candidate.borderRect.width > 0
      && result.pipeline.formatting.node(candidate.formattingNode).kind === formattingKind);
  assert.ok(fragment, `Missing ${formattingKind} fragment for #${id}`);
  return fragment;
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

function firstDescendantBaseline(result, id, formattingKind) {
  const root = fragmentFor(result, id, formattingKind);
  const pending = [root.id];
  while (pending.length > 0) {
    const fragment = result.pipeline.layout.fragment(pending.shift());
    if (fragment.kind === "text" && fragment.baseline !== null) {
      return fragment.borderRect.y + fragment.baseline;
    }
    pending.push(...fragment.children);
  }
  return null;
}

test("HTML table metadata bounds spans and resolves source-owned header relationships", () => {
  const document = parseWebDocument(`<table id="ledger"><caption>Quarterly ledger</caption>
    <colgroup id="identity" span="2"></colgroup><colgroup id="amounts"><col span="2"></colgroup>
    <thead><tr><th id="name" scope="col">Name</th><th id="region" scope="col">Region</th>
      <th id="q1" scope="colgroup">Q1</th><th id="q2">Q2</th></tr></thead>
    <tbody><tr><th id="north" scope="row">North</th><td id="place">Coast</td>
      <td id="amount" headers="north q1">12</td><td id="tail" rowspan="0">14</td></tr>
      <tr><td colspan="999999999999999999999">bounded</td><td>15</td></tr></tbody></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const ledger = document.elementById("ledger");
  const amount = document.elementById("amount");
  const tail = document.elementById("tail");
  assert.ok(ledger && amount && tail);
  assert.equal(document.htmlTable(ledger).captions.length, 1);
  assert.equal(document.htmlTableCell(tail).rowSpan, "remaining-row-group");
  assert.deepEqual(document.semantic(amount).tableHeaders, [document.elementById("north"), document.elementById("q1")]);
  const bounded = document.htmlTable(ledger).cells.map((node) => document.htmlTableCell(node).columnSpan);
  assert.ok(Math.max(...bounded) <= 1_000);
  assert.equal(document.semantic(ledger).accessibleName, "Quarterly ledger");
});

test("HTML table slot work admits a deterministic complete-table prefix", () => {
  const html = `<table id="first"><tr><td id="first-cell">kept</td></tr></table>
    <table id="hostile"><tr><td id="hostile-cell" rowspan="65534">bounded</td></tr>
      ${Array.from({ length: 8 }, () => "<tr><td>row</td></tr>").join("")}</table>`;
  const parse = (maxHtmlTableSlotWork) => parseWebDocument(html, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/",
    indexLimits: { maxHtmlTableSlotWork }
  });
  const limited = parse(3);
  assert.deepEqual(limited.indexOutcome, {
    status: "truncated",
    indexedNodes: limited.indexOutcome.indexedNodes,
    exhausted: "maxHtmlTableSlotWork",
    limit: 3
  });
  assert.ok(limited.htmlTable(limited.elementById("first")));
  assert.ok(limited.htmlTableCell(limited.elementById("first-cell")));
  assert.equal(limited.htmlTable(limited.elementById("hostile")), null);
  assert.equal(limited.htmlTableCell(limited.elementById("hostile-cell")), null);

  const repeated = parse(3);
  assert.deepEqual(repeated.indexOutcome, limited.indexOutcome);
  assert.equal(repeated.htmlTable(repeated.elementById("hostile")), null);
  const extended = parse(100);
  assert.ok(extended.htmlTable(extended.elementById("first")));
  assert.ok(extended.htmlTable(extended.elementById("hostile")));
  assert.equal(extended.indexOutcome.status, "complete");
});

test("HTML table header association work is bounded at complete-table admission boundaries", () => {
  const html = `<table id="first"><tr><td>kept</td></tr></table>
    <table id="headers"><tr><th id="left">Left</th><th id="right">Right</th></tr>
      <tr><td id="value" colspan="2">value</td><td>tail</td></tr></table>`;
  const limited = parseWebDocument(html, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/",
    indexLimits: { maxHtmlTableHeaderAssociationWork: 1 }
  });
  assert.deepEqual(limited.indexOutcome, {
    status: "truncated",
    indexedNodes: limited.indexOutcome.indexedNodes,
    exhausted: "maxHtmlTableHeaderAssociationWork",
    limit: 1
  });
  assert.ok(limited.htmlTable(limited.elementById("first")));
  assert.equal(limited.htmlTable(limited.elementById("headers")), null);

  const extended = parseWebDocument(html, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/",
    indexLimits: { maxHtmlTableHeaderAssociationWork: 20 }
  });
  assert.deepEqual(extended.semantic(extended.elementById("value")).tableHeaders, [
    extended.elementById("left"),
    extended.elementById("right")
  ]);
});

test("HTML header associations remain scoped to their owning table", () => {
  const document = parseWebDocument(`<table><tr><th id="first-header">First</th></tr><tr><td id="first-cell">one</td></tr></table>
    <table><tr><th id="second-header">Second</th></tr><tr><td id="second-cell">two</td></tr></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const firstCell = document.elementById("first-cell");
  const secondCell = document.elementById("second-cell");
  assert.deepEqual(document.semantic(firstCell).tableHeaders, [document.elementById("first-header")]);
  assert.deepEqual(document.semantic(secondCell).tableHeaders, [document.elementById("second-header")]);

  const scoped = parseWebDocument(`<table><tbody><tr><th id="group" scope="rowgroup">Group</th><td id="member">Member</td></tr></tbody></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  assert.equal(scoped.semantic(scoped.elementById("group")).role, "rowheader");
  assert.deepEqual(scoped.semantic(scoped.elementById("member")).tableHeaders, [scoped.elementById("group")]);
});

test("table computed values and @supports share one implemented parser contract", () => {
  const document = parseWebDocument(`<style>#table{table-layout:fixed;border-collapse:collapse;border-spacing:3px 5px;
    caption-side:bottom;empty-cells:hide;border-top:2px solid rgb(1 2 3);border-right-style:hidden}</style>
    <table id="table"><tr><td>x</td></tr></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const styles = resolveStyles({
    document,
    state: createDocumentState(document),
    resources: embeddedStylesheetSources(document),
    environment: environment(60, 40)
  });
  const style = styles.style(document.elementById("table"));
  assert.equal(style.box.tableLayout, "fixed");
  assert.equal(style.box.borderCollapse, "collapse");
  assert.deepEqual(style.box.borderSpacing, {
    horizontal: { kind: "length", value: 3, unit: "px" },
    vertical: { kind: "length", value: 5, unit: "px" }
  });
  assert.equal(style.box.captionSide, "bottom");
  assert.equal(style.box.emptyCells, "hide");
  assert.equal(style.box.borderStyles.top, "solid");
  assert.equal(style.box.borderStyles.right, "hidden");
  assert.equal(implementationSupportsCondition("(table-layout:fixed) and (border-collapse:collapse)"), true);
  assert.equal(implementationSupportsCondition("border-style:dashed"), false);
  assert.equal(implementationSupportsCondition("border:1px 2px solid"), false);
  assert.equal(implementationSupportsCondition("border:solid solid red"), false);
  assert.equal(implementationSupportsCondition("border-width:10%"), false);
  assert.equal(implementationSupportsCondition("border-spacing:10%"), false);
  assert.equal(implementationSupportsCondition("border-spacing:calc(1px + 2%)"), false);
  assert.equal(implementationSupportsCondition("caption-side:left"), false);
});

test("the slot grid drives colspan, rowspan, missing cells, and row sizing", () => {
  const result = render(`<style>table{border-spacing:0;width:240px}td{padding:0;border:0}</style>
    <table id="table"><tbody>
      <tr><td id="span" colspan="2" style="height:16px">spanning</td><td id="side" rowspan="2">side</td></tr>
      <tr><td id="left" style="height:32px">left</td><td id="right">right</td></tr>
      <tr><td id="missing">short row</td></tr>
    </tbody></table>`, 50);
  const span = fragmentFor(result, "span", "table-cell");
  const left = fragmentFor(result, "left", "table-cell");
  const right = fragmentFor(result, "right", "table-cell");
  const side = fragmentFor(result, "side", "table-cell");
  assert.equal(span.borderRect.width, left.borderRect.width + right.borderRect.width);
  assert.equal(left.borderRect.y, right.borderRect.y);
  assert.ok(side.borderRect.height >= span.borderRect.height + left.borderRect.height);
  assert.equal(result.pipeline.layout.outcome.status, "complete");

  const spacedSpan = render(`<style>table{border-spacing:10px}td{padding:0;border:0}</style><table id="spaced">
    <tr><td colspan="2" style="width:100px"></td></tr><tr><td></td><td></td></tr></table>`, 50);
  assert.equal(fragmentFor(spacedSpan, "spaced", "table").borderRect.width, cssPx(120));
});

test("fixed layout uses columns and first-row widths while automatic layout uses later intrinsic contributions", () => {
  const fixed = render(`<table id="table" style="table-layout:fixed;width:240px;border-spacing:0">
    <col style="width:40px"><col><tr><td id="fixed-first">a</td><td>b</td></tr>
    <tr><td>an extremely long later-row value that must overflow</td><td>tail</td></tr></table>`, 50);
  assert.equal(cssPixels(fragmentFor(fixed, "fixed-first", "table-cell").borderRect.width), 40);
  const automatic = render(`<table style="table-layout:auto;border-spacing:0"><tr><td id="auto-first">a</td><td>b</td></tr>
    <tr><td>a much longer preferred contribution</td><td>tail</td></tr></table>`, 50);
  assert.ok(fragmentFor(automatic, "auto-first", "table-cell").borderRect.width > cssPx(8));
});

test("definite table and row-group block sizes distribute into rows before cell relayout", () => {
  const tableSized = render(`<table id="sized" style="height:120px;border-spacing:0"><tbody>
    <tr><td id="row-one"><span id="top-content">top</span></td></tr>
    <tr><td id="row-two" style="vertical-align:bottom"><span id="bottom-content">bottom</span></td></tr>
    </tbody></table>`, 50);
  const table = fragmentFor(tableSized, "sized", "table");
  const first = fragmentFor(tableSized, "row-one", "table-cell");
  const second = fragmentFor(tableSized, "row-two", "table-cell");
  const bottom = fragmentFor(tableSized, "bottom-content", "inline-container");
  assert.equal(table.contentRect.height, cssPx(120));
  assert.equal(first.borderRect.height + second.borderRect.height, cssPx(120));
  assert.ok(bottom.borderRect.y > second.contentRect.y);

  const groupSized = render(`<table style="border-spacing:0"><tbody style="height:96px">
    <tr><td id="group-one">one</td></tr><tr><td id="group-two">two</td></tr></tbody></table>`, 50);
  const groupOne = fragmentFor(groupSized, "group-one", "table-cell");
  const groupTwo = fragmentFor(groupSized, "group-two", "table-cell");
  assert.equal(groupOne.borderRect.height + groupTwo.borderRect.height, cssPx(96));
});

test("table intrinsic widths feed parent Flex sizing and mixed baselines reserve row descent", () => {
  const intrinsic = render(`<div style="display:flex;width:320px">
    <table id="outer" style="border-spacing:0"><tr><td><table id="inner" style="border-spacing:0">
      <col style="width:120px"><col style="width:80px"><tr><td>a</td><td>b</td></tr>
    </table></td></tr></table><div style="flex:1">tail</div></div>`, 50);
  const outer = fragmentFor(intrinsic, "outer", "table");
  const inner = fragmentFor(intrinsic, "inner", "table");
  assert.ok(inner.borderRect.width >= cssPx(200));
  assert.ok(outer.borderRect.width >= inner.borderRect.width);

  const baseline = render(`<table style="border-spacing:0"><tr id="baseline-row">
    <td id="large-cell" style="font-size:32px;line-height:32px;vertical-align:baseline"><span id="large">Large</span></td>
    <td id="small-cell" style="vertical-align:baseline"><span id="small" style="font-size:8px;line-height:8px">small</span><div id="descent" style="height:32px"></div></td></tr></table>`, 50);
  const row = fragmentFor(baseline, "baseline-row", "table-row");
  const largeBaseline = firstDescendantBaseline(baseline, "large", "inline-container");
  const smallBaseline = firstDescendantBaseline(baseline, "small", "inline-container");
  assert.ok(largeBaseline !== null && smallBaseline !== null);
  assert.equal(largeBaseline, smallBaseline);
  const descent = fragmentFor(baseline, "descent", "block-container");
  assert.ok(row.borderRect.y + row.borderRect.height >= descent.marginRect.y + descent.marginRect.height);
});

test("captions remain in the wrapper, RTL reverses physical columns, and nested tables retain containment", () => {
  const result = render(`<table id="outer" dir="rtl" style="border-spacing:4px">
    <caption id="top">Top caption</caption><caption id="bottom" style="caption-side:bottom">Bottom caption</caption>
    <tr><td id="first">first</td><td id="second"><table id="nested"><tr><td>nested</td></tr></table></td></tr>
  </table>`, 60);
  const table = fragmentFor(result, "outer", "table");
  const wrapper = fragmentFor(result, "outer", "table-wrapper");
  const top = fragmentFor(result, "top", "table-caption");
  const bottom = fragmentFor(result, "bottom", "table-caption");
  const first = fragmentFor(result, "first", "table-cell");
  const second = fragmentFor(result, "second", "table-cell");
  const nested = fragmentFor(result, "nested", "table");
  assert.ok(top.borderRect.y < table.borderRect.y);
  assert.ok(bottom.borderRect.y >= table.borderRect.y + table.borderRect.height);
  assert.ok(wrapper.overflowRect.height >= table.borderRect.height + top.marginRect.height + bottom.marginRect.height);
  assert.ok(first.borderRect.x > second.borderRect.x);
  assert.ok(nested.borderRect.x >= second.contentRect.x);

  const wideCaption = render(`<table id="caption-table" style="border-spacing:0"><caption style="white-space:nowrap;margin:0 10px">
    a caption with a wide intrinsic contribution</caption><tr><td>x</td></tr></table>`, 60);
  const wideCaptionTable = fragmentFor(wideCaption, "caption-table", "table");
  assert.ok(wideCaptionTable.borderRect.width > cssPx(100));
});

test("separated and collapsed borders retain one layout-owned geometry path", () => {
  const separated = render(`<table style="border-spacing:8px 4px"><tr><td id="one" style="border:2px solid red">one</td>
    <td id="empty" style="empty-cells:hide;background:red;border:2px solid red"></td></tr></table>`, 50);
  const one = fragmentFor(separated, "one", "table-cell");
  const empty = fragmentFor(separated, "empty", "table-cell");
  assert.ok(empty.borderRect.x >= one.borderRect.x + one.borderRect.width + cssPx(8));
  assert.equal(separated.pipeline.displayList.commands.some((command) => command.layoutFragment === empty.id
    && (command.kind === "background-fill" || command.kind === "border-side")), false);

  const margins = render(`<table style="border-spacing:8px"><tr><td id="plain">one</td><td id="authored" style="margin:40px">two</td></tr></table>`, 50);
  const plain = fragmentFor(margins, "plain", "table-cell");
  const authored = fragmentFor(margins, "authored", "table-cell");
  assert.deepEqual(authored.marginRect, authored.borderRect);
  assert.equal(authored.borderRect.x, plain.borderRect.x + plain.borderRect.width + cssPx(8));

  const collapsed = render(`<table id="collapsed" style="border-collapse:collapse"><tr>
    <td id="left" style="border-right:4px solid red">left</td>
    <td id="right" style="border-left:2px solid blue">right</td></tr></table>`, 50);
  const left = fragmentFor(collapsed, "left", "table-cell");
  const right = fragmentFor(collapsed, "right", "table-cell");
  assert.equal(left.borderRect.width - left.paddingRect.width, cssPx(2));
  assert.equal(right.borderRect.width - right.paddingRect.width, cssPx(2));
  const shared = collapsed.pipeline.displayList.commands.filter((command) => command.kind === "border-side"
    && (command.layoutFragment === left.id || command.layoutFragment === right.id)
    && (command.side === "left" || command.side === "right"));
  assert.equal(shared.length, 1);

  const mismatchedSpans = render(`<table style="border-collapse:collapse"><tr>
    <td id="wide" colspan="2" style="border-bottom:4px solid red">wide</td></tr><tr>
    <td id="lower-left" style="border-top:2px solid blue">left</td>
    <td id="lower-right" style="border-top:2px solid blue">right</td></tr></table>`, 50);
  const spanEdgeFragments = ["wide", "lower-left", "lower-right"]
    .map((id) => fragmentFor(mismatchedSpans, id, "table-cell").id);
  const spanEdgeCommands = mismatchedSpans.pipeline.displayList.commands.filter((command) =>
    command.kind === "border-side" && spanEdgeFragments.includes(command.layoutFragment)
      && (command.side === "top" || command.side === "bottom"));
  assert.equal(spanEdgeCommands.length, 2);
  assert.equal(spanEdgeCommands.some((command) => command.layoutFragment === spanEdgeFragments[0]), false);
  assert.equal(new Set(spanEdgeCommands.map((command) => `${String(command.borderRect.x)}:${String(command.borderRect.width)}`)).size, 2);
  assert.ok(spanEdgeCommands.every((command) => command.style.borderColors[command.side]?.r === 255));

  const intersections = render(`<table style="border-collapse:collapse;border:3px solid red"><tr>
    <td id="corner-a" style="border:2px solid blue">A</td><td style="border:2px solid blue">B</td>
    </tr><tr><td style="border:2px solid blue">C</td><td style="border:2px solid blue">D</td></tr></table>`, 50);
  const corner = fragmentFor(intersections, "corner-a", "table-cell");
  assert.ok(corner.tableCollapsedBorderSegments.some((segment) =>
    segment.borderWidths.left > 0 || segment.borderWidths.right > 0
      || segment.borderWidths.top > 0 || segment.borderWidths.bottom > 0));
});

test("collapsed rows and columns remove their track breadth without retaining duplicate spacing", () => {
  const columns = render(`<table style="border-spacing:8px 4px"><col><col style="visibility:collapse"><col>
    <tr><td id="first">A</td><td>hidden</td><td id="third">C</td></tr></table>`, 50);
  const first = fragmentFor(columns, "first", "table-cell");
  const third = fragmentFor(columns, "third", "table-cell");
  assert.equal(third.borderRect.x - first.borderRect.x - first.borderRect.width, cssPx(8));

  const groupedColumns = render(`<table style="border-spacing:8px 4px"><colgroup style="visibility:collapse"><col></colgroup><col>
    <tr><td id="group-hidden">hidden</td><td id="group-visible">visible</td></tr></table>`, 50);
  const hiddenNode = groupedColumns.document.elementById("group-hidden");
  const hiddenCell = groupedColumns.pipeline.layout.forDocumentNode(hiddenNode).find((candidate) =>
    candidate.kind === "box"
      && groupedColumns.pipeline.formatting.node(candidate.formattingNode).kind === "table-cell");
  assert.ok(hiddenCell);
  assert.equal(hiddenCell.borderRect.width, 0);
  assert.ok(fragmentFor(groupedColumns, "group-visible", "table-cell").borderRect.width > 0);

  const rows = render(`<table style="border-spacing:4px 8px"><tr><td id="top">A</td></tr>
    <tr style="visibility:collapse"><td>hidden</td></tr><tr><td id="bottom">C</td></tr></table>`, 50);
  const top = fragmentFor(rows, "top", "table-cell");
  const bottom = fragmentFor(rows, "bottom", "table-cell");
  assert.equal(bottom.borderRect.y - top.borderRect.y - top.borderRect.height, cssPx(8));
});

test("table paint metadata preserves structural background phases and positioned descendants stay out of sizing", () => {
  const painted = render(`<style>
    #paint{width:240px;background:rgb(1 1 1)}#columns{background:rgb(2 2 2)}#column{background:rgb(3 3 3)}
    #body{background:rgb(4 4 4)}#row{background:rgb(5 5 5)}#cell{background:rgb(6 6 6)}
  </style><table id="paint"><colgroup id="columns"><col id="column"></colgroup><tbody id="body">
    <tr id="row"><td id="cell">painted cell</td></tr></tbody></table>`, 50);
  const ordered = [
    ["paint", "table"],
    ["columns", "table-column-group"],
    ["column", "table-column"],
    ["body", "table-body-group"],
    ["row", "table-row"],
    ["cell", "table-cell"]
  ].map(([id, kind]) => {
    const fragment = fragmentFor(painted, id, kind);
    const index = painted.pipeline.displayList.commands.findIndex((command) =>
      command.kind === "background" && command.layoutFragment === fragment.id);
    assert.ok(index >= 0, `Missing background for ${id}`);
    return index;
  });
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));

  const positioned = render(`<div id="css-table" style="display:table;position:relative;width:200px">
    <div style="display:table-row"><div id="flow-cell" style="display:table-cell">short</div></div>
    <a id="badge" href="/badge" style="position:absolute;right:0;top:0">positioned text that does not size a column</a>
  </div>`, 50);
  const table = fragmentFor(positioned, "css-table", "table");
  const cell = fragmentFor(positioned, "flow-cell", "table-cell");
  const badge = fragmentFor(positioned, "badge", "block-container");
  assert.ok(cell.borderRect.width <= table.contentRect.width);
  assert.ok(badge.borderRect.x >= table.paddingRect.x);
  assert.ok(positioned.pipeline.terminal.hitTestIndex.regions.some((region) => region.action.node === positioned.document.elementById("badge")));

  const ownedPositioning = render(`<div style="display:table;position:relative;width:200px">
    <div id="positioned-row" style="display:table-row;position:relative">
      <span style="display:table-cell">cell</span><a id="row-badge" href="/row" style="position:absolute;right:0;top:0">row badge</a>
    </div></div><table style="position:relative"><caption id="floating-caption" style="position:absolute;top:0">floating</caption>
    <tr><td>table cell</td></tr></table>`, 50);
  const positionedRow = fragmentFor(ownedPositioning, "positioned-row", "table-row");
  const rowBadge = fragmentFor(ownedPositioning, "row-badge", "block-container");
  assert.ok(rowBadge.borderRect.x >= positionedRow.paddingRect.x);
  const captionNode = ownedPositioning.document.elementById("floating-caption");
  assert.equal(ownedPositioning.pipeline.layout.forDocumentNode(captionNode).filter((fragment) => fragment.kind === "box").length, 1);
});

test("table actions, semantics, and typed work exhaustion survive through terminal indexes", () => {
  const result = render(`<p>prefix remains</p><table><caption>Actions</caption><tr><th id="header" scope="col">Action</th></tr>
    <tr><td id="cell"><a href="/next">Open</a><button>Apply</button></td></tr></table>`, 50);
  const cell = result.document.elementById("cell");
  assert.deepEqual(result.document.semantic(cell).tableHeaders, [result.document.elementById("header")]);
  assert.ok(result.pipeline.terminal.focusMap.targets.some((target) => target.action.kind === "link"));
  assert.ok(result.pipeline.terminal.focusMap.targets.some((target) => target.action.kind === "form-control"));
  assert.ok(result.pipeline.terminal.accessibilityBounds.some((entry) => entry.role === "table" && entry.name === "Actions"));

  const truncated = render(`<p>prefix remains</p><table><tr><td>one</td><td>two</td></tr></table>`, 50, 40, {
    maxTableCells: 1
  });
  assert.deepEqual(truncated.pipeline.layout.outcome, {
    status: "truncated",
    fragments: truncated.pipeline.layout.outcome.fragments,
    lineBoxes: truncated.pipeline.layout.outcome.lineBoxes,
    budget: "maxTableCells",
    limit: 1
  });
  assert.match(truncated.pipeline.terminal.cellBuffer.rows.map((row) => row.text).join("\n"), /prefix remains/u);
});

test("table fragment exhaustion finalizes only connected reserved structural prefixes", () => {
  const html = `<p>before table</p><table><caption>Ledger</caption><colgroup><col><col></colgroup>
    <thead><tr><th>A</th><th>B</th></tr></thead><tbody>
    <tr><td>one</td><td>two</td></tr><tr><td>three</td><td>four</td></tr>
    <tr><td>five</td><td>six</td></tr></tbody></table><p>after table</p>`;
  for (let maxFragments = 8; maxFragments <= 48; maxFragments += 1) {
    const result = render(html, 50, 40, { maxFragments });
    assert.equal(reachableFragments(result.pipeline.layout).size, result.pipeline.layout.outcome.fragments);
    if (result.pipeline.layout.outcome.status === "truncated") {
      assert.equal(result.pipeline.layout.outcome.budget, "maxFragments");
    }
  }
});

test("every table work budget reports its owning resource and retains a connected page prefix", () => {
  const common = `<p>retained prefix</p><table style="height:160px;border-collapse:collapse"><caption>budget table</caption>
    <colgroup><col><col></colgroup><thead><tr><th id="h" scope="col">Header</th><th>Other</th></tr></thead>
    <tbody><tr><td rowspan="2">span</td><td headers="h">one</td></tr><tr><td colspan="2">two</td></tr>
    <tr><td>short row</td></tr></tbody></table>`;
  const budgets = [
    "maxTableRoots",
    "maxTableRowGroups",
    "maxTableRows",
    "maxTableColumnGroups",
    "maxTableColumns",
    "maxTableCells",
    "maxTableSlotIntervals",
    "maxTableColspanWork",
    "maxTableRowspanWork",
    "maxTableAnonymousMissingCells",
    "maxTableIntrinsicMeasureWork",
    "maxTableColumnDistributionWork",
    "maxTableRowDistributionWork",
    "maxTableCollapsedBorderCandidates",
    "maxTableCollapsedBorderSegments",
    "maxTableHeaderAssociations"
  ];
  for (const budget of budgets) {
    const result = render(common, 50, 40, { [budget]: 0 });
    assert.equal(result.pipeline.layout.outcome.status, "truncated", budget);
    assert.equal(result.pipeline.layout.outcome.budget, budget);
    assert.equal(reachableFragments(result.pipeline.layout).size, result.pipeline.layout.outcome.fragments);
    assert.match(result.pipeline.terminal.cellBuffer.rows.map((row) => row.text).join("\n"), /retained prefix/u);
  }
});

test("table slot construction, intrinsic sizing, distribution, and collapsed edges honor cancellation", () => {
  const rows = Array.from({ length: 30 }, (_, row) => `<tr>${Array.from({ length: 10 }, (_, column) =>
    `<td colspan="${String(1 + (row + column) % 3)}" rowspan="${String(1 + (row * column) % 2)}" style="border:${String(1 + column % 4)}px solid red">${String(row)}:${String(column)} content</td>`).join("")}</tr>`).join("");
  const document = parseWebDocument(`<table style="border-collapse:collapse">${rows}</table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const state = createDocumentState(document);
  const resources = embeddedStylesheetSources(document);
  const styles = resolveStyles({ document, state, resources, environment: environment(80, 40) });
  const formatting = buildFormattingTree({ document, state, styles });
  let checks = 0;
  const signal = {
    throwIfAborted() {
      checks += 1;
      if (checks > 100) {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      }
    }
  };
  const width = cssLengthFromFixed(80 * CELL_WIDTH);
  const height = cssLengthFromFixed(40 * ROW_HEIGHT);
  assert.throws(() => buildLayoutFragmentTree({
    formatting,
    inlineItemStreams: buildInlineItemStreamSet(formatting),
    context: {
      viewport: { width, height },
      textMeasurer: terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT),
      initialContainingBlock: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), width, height),
      scrollport: cssRect(cssCoordinate(ZERO), cssCoordinate(ZERO), width, height)
    },
    signal
  }), { name: "AbortError" });
  assert.ok(checks > 100);
});

test("CSS table fixup keeps HTML spans source-owned and CSS-created cells at span one", () => {
  const result = render(`<div id="css-table" style="display:table"><span style="display:table-row">
    <span id="css-cell" colspan="5" style="display:table-cell">css cell</span></span></div>
    <table><tr><td id="html-cell" colspan="2">html cell</td></tr></table>`);
  const cssCell = result.document.elementById("css-cell");
  const htmlCell = result.document.elementById("html-cell");
  assert.equal(result.document.htmlTableCell(cssCell), null);
  assert.equal(result.document.htmlTableCell(htmlCell).columnSpan, 2);
  assert.equal(result.pipeline.layout.outcome.status, "complete");
  const formatting = buildFormattingTree({
    document: result.document,
    state: result.state,
    styles: result.pipeline.styles
  });
  const cssFormattingCell = formatting.forSource(cssCell).find((node) => node.kind === "table-cell");
  assert.ok(cssFormattingCell);
});
