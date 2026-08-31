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
  const extended = parse(70_000);
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
    indexLimits: { maxHtmlTableHeaderAssociationWork: 2 }
  });
  assert.deepEqual(limited.indexOutcome, {
    status: "truncated",
    indexedNodes: limited.indexOutcome.indexedNodes,
    exhausted: "maxHtmlTableHeaderAssociationWork",
    limit: 2
  });
  assert.ok(limited.htmlTable(limited.elementById("first")));
  assert.equal(limited.htmlTable(limited.elementById("headers")), null);

  const extended = parseWebDocument(html, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/",
    indexLimits: { maxHtmlTableHeaderAssociationWork: 100 }
  });
  assert.equal(extended.indexOutcome.status, "complete");
  assert.deepEqual(extended.semantic(extended.elementById("value")).tableHeaders, [
    extended.elementById("left"),
    extended.elementById("right")
  ]);
});

test("header assignment indexes applicable axes and scoped groups without all-cell rescans", () => {
  const document = parseWebDocument(`<table id="large"><colgroup><col span="10"></colgroup><tbody>${Array.from(
    { length: 100 },
    (_, row) => `<tr>${Array.from(
      { length: 10 },
      (_, column) => `<td>${String(row)}:${String(column)}</td>`,
    ).join("")}</tr>`,
  ).join("")}</tbody></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/",
  });
  const table = document.elementById("large");
  assert.notEqual(table, null);
  assert.equal(document.indexOutcome.status, "complete");
  assert.equal(document.htmlTable(table).cells.length, 1_000);
});

test("the HTML table model defers footers and retains implied rows and downward-growing cells", () => {
  const document = parseWebDocument(`<table id="model">
    <tfoot id="foot"><tr id="foot-row"><td>foot</td></tr></tfoot>
    <tbody id="body"><tr id="body-row"><td id="numeric" rowspan="3">numeric</td></tr>
      <tr id="body-row-two"><td id="downward" rowspan="0">downward</td></tr></tbody>
  </table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const model = document.htmlTable(document.elementById("model"));
  assert.ok(model);
  assert.deepEqual(model.rows, [
    document.elementById("body-row"),
    document.elementById("body-row-two"),
    document.elementById("foot-row")
  ]);
  assert.equal(model.logicalRows.length, 4);
  assert.equal(model.logicalRows[2].node, null);
  assert.equal(model.logicalRows[2].rowGroup, document.elementById("body"));
  assert.equal(model.logicalRows[3].node, document.elementById("foot-row"));
  assert.deepEqual(model.downwardGrowingCells, [document.elementById("downward")]);
  assert.equal(document.htmlTableCell(document.elementById("numeric")).rowSpan, 3);
  assert.equal(document.htmlTableCell(document.elementById("downward")).rowSpan, "remaining-row-group");
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

test("HTML header assignment handles th targets, transitive references, cycles, blocks, and opaque headers", () => {
  const document = parseWebDocument(`<table id="relations"><tr>
      <th id="root" abbr="R">Root heading</th>
      <th id="middle" headers="root">Middle</th>
      <th id="leaf" headers="middle">Leaf</th>
      <th id="cycle-a" headers="cycle-b">Cycle A</th>
      <th id="cycle-b" headers="cycle-a">Cycle B</th></tr>
    <tr><td id="explicit" headers="leaf leaf missing">value</td>
      <th id="th-target" headers="root">target header</th></tr></table>
    <table><tr><th id="foreign">Foreign</th></tr></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const refs = (...ids) => ids.map((id) => document.elementById(id));
  assert.deepEqual(document.semantic(document.elementById("explicit")).tableHeaders, refs("leaf", "middle", "root"));
  assert.deepEqual(document.semantic(document.elementById("th-target")).tableHeaders, refs("root"));
  assert.deepEqual(document.semantic(document.elementById("cycle-a")).tableHeaders, refs("cycle-b"));
  assert.deepEqual(document.semantic(document.elementById("cycle-b")).tableHeaders, refs("cycle-a"));
  assert.equal(document.semantic(document.elementById("root")).tableHeaderLabel, "R");
  assert.equal(document.semantic(document.elementById("root")).accessibleName, "Root heading");

  const automatic = parseWebDocument(`<table><tr><th id="far">Far</th></tr>
    <tr><td>opaque data</td></tr><tr><th id="near">Near</th></tr>
    <tr><td id="opaque-target"><a id="inside" href="/inside">value</a></td></tr></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  assert.deepEqual(automatic.semantic(automatic.elementById("opaque-target")).tableHeaders, [
    automatic.elementById("near")
  ]);
  assert.deepEqual(automatic.semantic(automatic.elementById("inside")).tableHeaders, [
    automatic.elementById("near")
  ]);
});

test("HTML header assignment uses first-ID resolution and excludes empty automatic headers", () => {
  const document = parseWebDocument(`<table><tr>
      <td id="duplicate">not a header</td><th id="duplicate">shadow header</th>
      <th id="explicit-header">Explicit</th></tr>
    <tr><td id="explicit" headers="duplicate duplicate explicit-header explicit-header">value</td></tr></table>
    <table><tr><th id="empty">   </th><th id="real">Real</th></tr>
      <tr><td id="under-empty">empty column</td><td id="automatic">automatic</td></tr></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  assert.deepEqual(document.semantic(document.elementById("explicit")).tableHeaders, [
    document.elementById("explicit-header")
  ]);
  assert.deepEqual(document.semantic(document.elementById("under-empty")).tableHeaders, [
  ]);
  assert.deepEqual(document.semantic(document.elementById("automatic")).tableHeaders, [
    document.elementById("real")
  ]);
});

test("HTML header groups, spans, nested tables, and RTL preserve logical semantic order", () => {
  const document = parseWebDocument(`<table id="group-table" dir="rtl"><colgroup span="2"></colgroup><colgroup span="2"></colgroup>
    <tbody><tr><th id="row-group" scope="rowgroup">Group</th><th id="row" scope="row">Row</th>
      <th id="col-a" scope="col">A</th><th id="col-b" scope="col">B</th></tr>
    <tr><td id="wide" colspan="4">wide</td></tr></tbody></table>
    <table><tr><th id="nested-header">Nested</th></tr><tr><td id="nested-cell">nested value</td></tr></table>`, {
    requestUrl: "https://tables.example.test/",
    finalUrl: "https://tables.example.test/"
  });
  const wideHeaders = document.semantic(document.elementById("wide")).tableHeaders;
  assert.deepEqual(wideHeaders, [
    document.elementById("col-a"),
    document.elementById("col-b"),
    document.elementById("row-group")
  ]);
  assert.equal(document.htmlTable(document.elementById("group-table")).errors.some(
    (error) => error.kind === "cell-in-multiple-column-groups"
  ), true);
  assert.deepEqual(document.semantic(document.elementById("nested-cell")).tableHeaders, [
    document.elementById("nested-header")
  ]);
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

test("CSS header and footer groups define one display row sequence used by fixed layout and painting", () => {
  const result = render(`<div id="table" style="display:table;table-layout:fixed;width:240px;border-spacing:0">
    <div id="footer-one" style="display:table-footer-group;background:#111"><div style="display:table-row"><span id="footer-cell" style="display:table-cell">footer</span></div></div>
    <div id="body" style="display:table-row-group;background:#222"><div style="display:table-row"><span id="body-cell" style="display:table-cell">body</span></div></div>
    <div id="header-one" style="display:table-header-group;background:#333"><div style="display:table-row"><span id="header-cell" style="display:table-cell;width:40px">header</span><span style="display:table-cell">other</span></div></div>
    <div id="header-two" style="display:table-header-group;background:#444"><div style="display:table-row"><span id="header-two-cell" style="display:table-cell">second header</span></div></div>
    <div id="footer-two" style="display:table-footer-group;background:#555"><div style="display:table-row"><span id="footer-two-cell" style="display:table-cell">second footer</span></div></div>
  </div>`, 50);
  const header = fragmentFor(result, "header-cell", "table-cell");
  const body = fragmentFor(result, "body-cell", "table-cell");
  const secondHeader = fragmentFor(result, "header-two-cell", "table-cell");
  const secondFooter = fragmentFor(result, "footer-two-cell", "table-cell");
  const footer = fragmentFor(result, "footer-cell", "table-cell");
  assert.ok(header.borderRect.y < body.borderRect.y);
  assert.ok(body.borderRect.y < secondHeader.borderRect.y);
  assert.ok(secondHeader.borderRect.y < secondFooter.borderRect.y);
  assert.ok(secondFooter.borderRect.y < footer.borderRect.y);
  assert.equal(cssPixels(header.borderRect.width), 40);
  const paintOrder = ["header-one", "body", "header-two", "footer-two", "footer-one"].map((id) => {
    const node = result.document.elementById(id);
    const fragment = result.pipeline.layout.forDocumentNode(node).find((candidate) => candidate.kind === "box");
    assert.ok(fragment);
    const index = result.pipeline.displayList.commands.findIndex((command) =>
      command.kind === "background" && command.layoutFragment === fragment.id);
    assert.ok(index >= 0);
    return index;
  });
  assert.deepEqual(paintOrder, [...paintOrder].sort((left, right) => left - right));
});

test("typed column, column-group, cell, and calculated percentage constraints drive table widths", () => {
  const fixed = render(`<table style="table-layout:fixed;width:240px;border-spacing:0">
    <colgroup style="width:120px"><col style="width:40px"><col></colgroup>
    <tr><td id="fixed-a">a</td><td id="fixed-b">b</td></tr></table>`, 50);
  const fixedA = fragmentFor(fixed, "fixed-a", "table-cell");
  const fixedB = fragmentFor(fixed, "fixed-b", "table-cell");
  assert.ok(fixedA.borderRect.width + fixedB.borderRect.width >= cssPx(240));
  assert.ok(fixedA.borderRect.width >= cssPx(40));

  const calculated = render(`<table id="calculated-table" style="width:200px;border-spacing:0"><tr>
    <td id="calculated" style="padding:0;width:calc(50% - 1rem)">a</td><td id="remainder" style="padding:0">b</td>
    </tr></table>`, 50);
  const calculatedWidth = fragmentFor(calculated, "calculated", "table-cell").borderRect.width;
  const remainderWidth = fragmentFor(calculated, "remainder", "table-cell").borderRect.width;
  const tableWidth = fragmentFor(calculated, "calculated-table", "table").borderRect.width;
  assert.ok(calculatedWidth >= cssPx(84), `expected at least 84 CSS px, received ${cssPixels(calculatedWidth)}`);
  assert.equal(cssPixels(calculatedWidth + remainderWidth), cssPixels(tableWidth));

  for (const direction of ["ltr", "rtl"]) {
    const cumulative = render(`<table dir="${direction}" style="width:200px;border-spacing:0"><tr>
      <td id="first-percent" style="padding:0;width:60%">a</td><td id="second-percent" style="padding:0;width:60%">b</td>
      </tr></table>`, 50);
    const first = fragmentFor(cumulative, "first-percent", "table-cell");
    const second = fragmentFor(cumulative, "second-percent", "table-cell");
    assert.equal(first.borderRect.width, cssPx(120));
    assert.equal(second.borderRect.width, cssPx(80));
    assert.equal(direction === "ltr" ? first.borderRect.x < second.borderRect.x : first.borderRect.x > second.borderRect.x, true);
  }

  const spanning = render(`<table style="width:240px;border-spacing:0"><colgroup style="width:50%"><col><col></colgroup>
    <tr><td id="group-a">a</td><td id="group-b">b</td></tr>
    <tr><td id="percent-span" colspan="2" style="width:min(60%, 300px)">span</td></tr></table>`, 50);
  assert.ok(fragmentFor(spanning, "group-a", "table-cell").borderRect.width
    + fragmentFor(spanning, "group-b", "table-cell").borderRect.width >= cssPx(144));
  assert.equal(fragmentFor(spanning, "percent-span", "table-cell").borderRect.width,
    fragmentFor(spanning, "group-a", "table-cell").borderRect.width
      + fragmentFor(spanning, "group-b", "table-cell").borderRect.width);
});

test("automatic colspan planning is independent of row traversal order", () => {
  const fixture = (rows) => render(`<table style="border-spacing:0;width:320px">
    <tr><td id="c1">a</td><td id="c2">b</td><td id="c3">c</td></tr>${rows}</table>`, 50);
  const short = `<tr><td colspan="2">medium spanning value</td><td>x</td></tr>`;
  const long = `<tr><td>x</td><td colspan="2">a considerably longer spanning preferred contribution</td></tr>`;
  const widths = (result) => ["c1", "c2", "c3"].map((id) => fragmentFor(result, id, "table-cell").borderRect.width);
  assert.deepEqual(widths(fixture(short + long)), widths(fixture(long + short)));
});

test("definite table block sizes distribute before cell relayout and row-group heights are ignored", () => {
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
  const groupAuto = render(`<table style="border-spacing:0"><tbody>
    <tr><td id="auto-one">one</td></tr><tr><td id="auto-two">two</td></tr></tbody></table>`, 50);
  assert.equal(
    groupOne.borderRect.height + groupTwo.borderRect.height,
    fragmentFor(groupAuto, "auto-one", "table-cell").borderRect.height
      + fragmentFor(groupAuto, "auto-two", "table-cell").borderRect.height
  );
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

test("rowspan planning is order-independent and mandatory cell minimums survive table constraints", () => {
  const fixture = (cells) => render(`<table style="border-spacing:0;height:160px">
    <tr>${cells}</tr><tr><td id="measure-one">one</td><td>tail</td></tr>
    <tr><td id="measure-two">two</td><td>tail</td></tr>
    <tr><td id="measure-three">three</td><td>tail</td></tr></table>`, 50);
  const firstSpan = `<td rowspan="2" style="height:80px">first span</td>`;
  const secondSpan = `<td rowspan="3" style="height:96px">second span</td>`;
  const heights = (result) => ["measure-one", "measure-two", "measure-three"]
    .map((id) => fragmentFor(result, id, "table-cell").borderRect.height);
  assert.deepEqual(heights(fixture(firstSpan + secondSpan)), heights(fixture(secondSpan + firstSpan)));

  const constrained = render(`<table id="short-table" style="height:20px;max-height:20px;border-spacing:0">
    <tr style="max-height:4px"><td id="tall-cell" style="height:64px;max-height:4px">required</td></tr></table>`, 50);
  const tall = fragmentFor(constrained, "tall-cell", "table-cell");
  assert.ok(tall.borderRect.height >= cssPx(64));
  assert.ok(fragmentFor(constrained, "short-table", "table").overflowRect.height >= tall.borderRect.height);
});

test("final cell relayout resolves wrapping, percentage descendants, and table-cell vertical alignment", () => {
  const result = render(`<table style="width:160px;height:128px;border-spacing:0"><tr>
    <td id="wrapped" style="width:50%;vertical-align:baseline">text that wraps after the final column width is selected</td>
    <td id="middle" style="vertical-align:middle"><div id="half" style="height:50%">middle</div></td>
    <td id="bottom" style="vertical-align:bottom"><span id="bottom-text">bottom</span></td>
    </tr></table>`, 50);
  const wrapped = fragmentFor(result, "wrapped", "table-cell");
  const middle = fragmentFor(result, "middle", "table-cell");
  const half = fragmentFor(result, "half", "block-container");
  const bottom = fragmentFor(result, "bottom", "table-cell");
  const bottomText = fragmentFor(result, "bottom-text", "inline-container");
  assert.ok(result.pipeline.layout.lineBoxes.some((line) => line.rect.width <= wrapped.contentRect.width));
  assert.equal(half.borderRect.height, middle.contentRect.height / 2);
  assert.ok(bottomText.borderRect.y > bottom.contentRect.y);
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

  const narrowCaption = render(`<table id="center-table" style="width:240px;border-spacing:0">
    <caption id="narrow-caption" style="width:80px">narrow</caption><tr><td>cell</td></tr></table>`, 50);
  const centerTable = fragmentFor(narrowCaption, "center-table", "table");
  const caption = fragmentFor(narrowCaption, "narrow-caption", "table-caption");
  assert.equal(
    caption.marginRect.x - centerTable.borderRect.x,
    (centerTable.borderRect.width - caption.marginRect.width) / 2
  );
});

test("nested intrinsic queries reuse one immutable CSS slot grid per table root", () => {
  const depth = 30;
  const result = render(
    `${"<table><tr><td>".repeat(depth)}nested${"</td></tr></table>".repeat(depth)}`,
    80,
    40,
    { maxTableRoots: depth },
  );
  assert.equal(result.pipeline.layout.outcome.status, "complete");
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

test("collapsed tables suppress padding and retain perimeter edges across empty and missing slots", () => {
  const result = render(`<table id="empty-table" style="width:80px;height:48px;padding:24px;border-collapse:collapse;border:4px solid red"></table>
    <table id="missing-table" style="width:160px;border-collapse:collapse;border:3px solid blue">
      <tr><td id="only-cell" style="border:1px solid green">only</td><td></td></tr><tr><td>short</td></tr>
    </table>`, 50);
  const emptyNode = result.document.elementById("empty-table");
  const empty = result.pipeline.layout.forDocumentNode(emptyNode).find((candidate) =>
    candidate.kind === "box" && result.pipeline.formatting.node(candidate.formattingNode).kind === "table");
  assert.ok(empty);
  assert.deepEqual(empty.paddingRect, empty.contentRect);
  const emptySegments = result.pipeline.displayList.commands.filter((command) =>
    command.kind === "border-side" && command.documentNode === emptyNode);
  assert.equal(emptySegments.length, 4);
  assert.ok(emptySegments.every((command) => command.borderRect.width > 0 && command.borderRect.height > 0));

  const missing = fragmentFor(result, "missing-table", "table");
  const perimeter = result.pipeline.displayList.commands.filter((command) =>
    command.kind === "border-side" && command.documentNode === result.document.elementById("missing-table"));
  assert.ok(perimeter.length >= 2);
  assert.ok(missing.borderRect.width >= fragmentFor(result, "only-cell", "table-cell").borderRect.width);
});

test("collapsed-border conflict precedence is deterministic in LTR and RTL and harmonized across spans", () => {
  for (const direction of ["ltr", "rtl"]) {
    const result = render(`<table dir="${direction}" style="border-collapse:collapse"><tr>
      <td id="logical-first" style="border-right:4px solid red">first</td>
      <td id="logical-second" style="border-left:4px solid blue">second</td></tr></table>`, 50);
    const first = fragmentFor(result, "logical-first", "table-cell");
    const second = fragmentFor(result, "logical-second", "table-cell");
    const shared = result.pipeline.displayList.commands.find((command) => command.kind === "border-side"
      && (command.layoutFragment === first.id || command.layoutFragment === second.id)
      && (command.side === "left" || command.side === "right"));
    assert.ok(shared);
    assert.equal(shared.style.borderColors[shared.side]?.[direction === "ltr" ? "r" : "b"], 255);
  }

  const hidden = render(`<table style="border-collapse:collapse"><tr>
    <td id="hidden-left" style="border-right:8px hidden red">left</td>
    <td id="hidden-right" style="border-left:12px solid blue">right</td></tr></table>`, 50);
  const hiddenFragments = ["hidden-left", "hidden-right"].map((id) => fragmentFor(hidden, id, "table-cell").id);
  assert.equal(hidden.pipeline.displayList.commands.some((command) => command.kind === "border-side"
    && hiddenFragments.includes(command.layoutFragment) && (command.side === "left" || command.side === "right")), false);

  const connected = render(`<table style="border-collapse:collapse"><tr>
    <td id="top-span" colspan="2" style="border-bottom:5px solid red">top</td></tr><tr>
    <td id="left-span" rowspan="2" style="border-top:2px solid blue;border-right:3px solid blue">left</td>
    <td style="border-top:2px solid blue">right</td></tr><tr><td style="border-left:3px solid green">bottom</td></tr></table>`, 50);
  const top = fragmentFor(connected, "top-span", "table-cell");
  const harmonized = connected.pipeline.displayList.commands.filter((command) => command.kind === "border-side"
    && command.borderRect.y >= top.borderRect.y + top.borderRect.height - cssPx(3));
  assert.ok(harmonized.length >= 2);
  assert.ok(harmonized.some((command) => command.style.borderColors[command.side]?.r === 255));
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

test("empty-cells hiding follows collapsed white space without removing actions or semantics", () => {
  const result = render(`<style>.generated::before{content:"generated"}</style><table style="border-collapse:separate;border-spacing:4px"><tr>
    <td id="collapsed-space" style="empty-cells:hide;background:red;border:2px solid red">   </td>
    <td id="preserved-space" style="white-space:pre;empty-cells:hide;background:red;border:2px solid red">   </td>
    <td id="generated" class="generated" style="empty-cells:hide;background:red;border:2px solid red"></td>
    <td id="out-of-flow-only" style="empty-cells:hide;background:red;border:2px solid red"><a id="floating-action" href="/x" style="position:absolute">action</a></td>
    </tr></table>`, 50);
  const hasCellPaint = (id) => {
    const fragment = fragmentFor(result, id, "table-cell");
    return result.pipeline.displayList.commands.some((command) => command.layoutFragment === fragment.id
      && (command.kind === "background" || command.kind === "border-side"));
  };
  assert.equal(hasCellPaint("collapsed-space"), false);
  assert.equal(hasCellPaint("preserved-space"), true);
  assert.equal(hasCellPaint("generated"), true);
  assert.equal(hasCellPaint("out-of-flow-only"), false);
  assert.ok(result.pipeline.terminal.focusMap.targets.some((target) =>
    target.action.node === result.document.elementById("floating-action")));
  assert.ok(result.pipeline.terminal.accessibilityBounds.some((entry) =>
    entry.documentNode === result.document.elementById("out-of-flow-only")));
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

test("collapsed-border candidate work is admitted incrementally for large edge graphs", () => {
  const rows = Array.from({ length: 12 }, (_, row) => `<tr>${Array.from({ length: 12 }, (_, column) =>
    `<td style="border:1px solid red">${String(row)}:${String(column)}</td>`).join("")}</tr>`).join("");
  const html = `<p>retained edge prefix</p><table style="border-collapse:collapse">${rows}</table>`;
  const first = render(html, 80, 40, { maxTableCollapsedBorderCandidates: 200 });
  const second = render(html, 80, 40, { maxTableCollapsedBorderCandidates: 200 });
  assert.deepEqual(first.pipeline.layout.outcome, second.pipeline.layout.outcome);
  assert.equal(first.pipeline.layout.outcome.status, "truncated");
  assert.equal(first.pipeline.layout.outcome.budget, "maxTableCollapsedBorderCandidates");
  assert.equal(reachableFragments(first.pipeline.layout).size, first.pipeline.layout.outcome.fragments);
  assert.match(first.pipeline.terminal.cellBuffer.rows.map((row) => row.text).join("\n"), /retained edge prefix/u);
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
