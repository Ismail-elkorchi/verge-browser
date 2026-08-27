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
import { buildTextSearchIndex } from "../../dist/presentation/search/index.js";
import { embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import { buildTerminalDisplayList, rasterizeTerminalDisplayList } from "../../dist/presentation/terminal/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const CELL_WIDTH = cssPx(8);
const ROW_HEIGHT = cssPx(16);

function render(html, columns = 80, rows = 40, layoutBudgets) {
  const document = parseWebDocument(html, {
    requestUrl: "https://grid.example/",
    finalUrl: "https://grid.example/"
  });
  const state = createDocumentState(document);
  const styles = resolveStyles({
    document,
    state,
    resources: embeddedStylesheetSources(document),
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
  const inlineItemStreams = buildInlineItemStreamSet(formatting);
  const textSearchIndex = buildTextSearchIndex(formatting, inlineItemStreams);
  const viewportWidth = cssLengthFromFixed(columns * CELL_WIDTH);
  const viewportHeight = cssLengthFromFixed(rows * ROW_HEIGHT);
  const viewport = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), viewportWidth, viewportHeight);
  const layout = buildLayoutFragmentTree({
    formatting,
    inlineItemStreams,
    context: {
      viewport: { width: viewportWidth, height: viewportHeight },
      initialContainingBlock: viewport,
      scrollport: viewport,
      textMeasurer: terminalCssTextMeasurer(CELL_WIDTH, ROW_HEIGHT),
      ...(layoutBudgets === undefined ? {} : { budgets: layoutBudgets })
    }
  });
  const terminalContext = {
    columns,
    rows,
    cellWidthCssPx: CELL_WIDTH,
    rowHeightCssPx: ROW_HEIGHT,
    unicode: true,
    ambiguousWidth: 1,
    colorDepth: 24,
    cellMeasurer: terminalCellMeasurer()
  };
  const displayList = buildTerminalDisplayList({ layout, context: terminalContext });
  const terminal = rasterizeTerminalDisplayList({ displayList, textSearchIndex });
  return { document, styles, formatting, layout, displayList, terminal };
}

function fragment(result, id) {
  const node = result.document.elementById(id);
  assert.ok(node, `missing #${id}`);
  const value = result.layout.forDocumentNode(node)
    .find((candidate) => candidate.kind !== "text" && candidate.borderRect.width > 0);
  assert.ok(value, `missing principal fragment for #${id}`);
  return value;
}

function rectangle(result, id) {
  const value = fragment(result, id).borderRect;
  return {
    x: cssPixels(value.x),
    y: cssPixels(value.y),
    width: cssPixels(value.width),
    height: cssPixels(value.height)
  };
}

test("explicit and implicit Grid tracks resolve named, negative, and outlying line placements", () => {
  const result = render(`<style>
    #grid{display:grid;width:120px;grid-template-columns:[left] 30px [middle] 1fr [right];
      grid-template-rows:[top] 20px [bottom];grid-auto-columns:10px 15px;grid-auto-rows:12px 18px}
    #named{grid-column:left/middle;grid-row:top/bottom}
    #negative{grid-column:-2/-1;grid-row:1}
    #implicit{grid-column:4/5;grid-row:3/4}
  </style><div id="grid"><div id="named">named</div><div id="negative">negative</div>
    <div id="implicit">implicit</div></div>`);
  assert.deepEqual(rectangle(result, "named"), { x: 0, y: 0, width: 30, height: 20 });
  assert.deepEqual(rectangle(result, "negative"), { x: 30, y: 0, width: 65, height: 20 });
  assert.deepEqual(rectangle(result, "implicit"), { x: 105, y: 32, width: 15, height: 18 });

  const areaLinePrecedence = render(`<style>
    #grid{display:grid;width:60px;grid-template-columns:[foo] 20px [foo-start] 20px [foo-end] 20px}
    #item{grid-column:foo}
  </style><div id="grid"><div id="item">item</div></div>`);
  assert.deepEqual(
    (({ x, width }) => ({ x, width }))(rectangle(areaLinePrecedence, "item")),
    { x: 20, width: 20 }
  );

  const areaSizedByAutomaticTracks = render(`<style>
    #grid{display:grid;width:80px;grid-template-areas:"first second";grid-auto-columns:30px 50px}
    #first{grid-area:first}#second{grid-area:second}
  </style><div id="grid"><div id="first">first</div><div id="second">second</div></div>`);
  assert.deepEqual(
    (({ x, width }) => ({ x, width }))(rectangle(areaSizedByAutomaticTracks, "first")),
    { x: 0, width: 30 }
  );
  assert.deepEqual(
    (({ x, width }) => ({ x, width }))(rectangle(areaSizedByAutomaticTracks, "second")),
    { x: 30, width: 50 }
  );
});

test("row and column auto-placement grow the implicit Grid and dense packing fills earlier holes", () => {
  const sparse = render(`<style>
    #grid{display:grid;width:120px;grid-template-columns:repeat(3,40px);grid-auto-rows:16px}
    #wide{grid-column:span 2}#fixed{grid-column:2}
  </style><div id="grid"><div id="wide">wide</div><div id="fixed">fixed</div><div id="tail">tail</div></div>`);
  assert.deepEqual(rectangle(sparse, "wide"), { x: 0, y: 0, width: 80, height: 16 });
  assert.deepEqual(rectangle(sparse, "fixed"), { x: 40, y: 16, width: 40, height: 16 });
  assert.deepEqual(rectangle(sparse, "tail"), { x: 80, y: 16, width: 40, height: 16 });

  const dense = render(`<style>
    #grid{display:grid;width:120px;grid-template-columns:repeat(3,40px);grid-auto-rows:16px;grid-auto-flow:row dense}
    #wide{grid-column:span 2}#fixed{grid-column:2}
  </style><div id="grid"><div id="wide">wide</div><div id="fixed">fixed</div><div id="tail">tail</div></div>`);
  assert.deepEqual(rectangle(dense, "tail"), { x: 80, y: 0, width: 40, height: 16 });

  const column = render(`<style>
    #grid{display:grid;width:80px;grid-template-columns:repeat(2,40px);grid-template-rows:repeat(2,16px);
      grid-auto-flow:column;grid-auto-columns:20px}
  </style><div id="grid"><div id="one">one</div><div id="two">two</div><div id="three">three</div>
    <div id="four">four</div><div id="five">five</div></div>`);
  assert.deepEqual(rectangle(column, "one"), { x: 0, y: 0, width: 40, height: 16 });
  assert.deepEqual(rectangle(column, "two"), { x: 0, y: 16, width: 40, height: 16 });
  assert.deepEqual(rectangle(column, "five"), { x: 80, y: 0, width: 20, height: 16 });

  const orderModified = render(`<style>
    #grid{display:grid;width:80px;grid-template-columns:40px 40px}
    #first{order:2}#second{order:1}#absolute{position:absolute}
  </style><div id="grid"><div id="first">first</div><div id="absolute">absolute</div><div id="second">second</div></div>`);
  assert.equal(rectangle(orderModified, "second").x, 0);
  assert.equal(rectangle(orderModified, "first").x, 40);
  assert.equal(rectangle(orderModified, "absolute").x, 0);
});

test("intrinsic, fit-content, spanning, and flexible Grid tracks share CSS-pixel contributions", () => {
  const result = render(`<style>
    #grid{display:grid;width:240px;grid-template-columns:min-content max-content fit-content(40px) minmax(20px,1fr) 2fr}
  </style><div id="grid"><div id="min">long word</div><div id="max">aa bb</div>
    <div id="fit">aa bb</div><div id="flex-one"></div><div id="flex-two"></div></div>`);
  const min = rectangle(result, "min");
  const max = rectangle(result, "max");
  const fit = rectangle(result, "fit");
  const firstFlexible = rectangle(result, "flex-one");
  const secondFlexible = rectangle(result, "flex-two");
  assert.ok(min.width >= 32);
  assert.ok(max.width >= 40);
  assert.ok(fit.width <= 40 + (1 / 64), JSON.stringify({ min, max, fit, firstFlexible, secondFlexible }));
  assert.ok(firstFlexible.width > 0);
  assert.ok(secondFlexible.width >= firstFlexible.width * 1.9);

  const spanning = render(`<style>#grid{display:grid;width:180px;grid-template-columns:auto auto auto}
    #span{grid-column:1/4;white-space:nowrap}</style><div id="grid"><div id="span">spanning contribution</div></div>`);
  assert.equal(rectangle(spanning, "span").width, 180);
});

test("auto-fill and auto-fit use definite inline size, gaps, and collapsed empty tracks", () => {
  const positions = [];
  for (const columns of [40, 80, 120]) {
    const result = render(`<style>
      #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
    </style><div id="grid"><div id="one">one</div><div id="two">two</div><div id="three">three</div></div>`, columns);
    positions.push([rectangle(result, "one").y, rectangle(result, "two").y, rectangle(result, "three").y]);
  }
  assert.deepEqual(positions.map((rows) => new Set(rows).size), [3, 2, 1]);

  const fill = render(`<style>#grid{display:grid;width:240px;grid-template-columns:repeat(auto-fill,minmax(80px,1fr))}</style>
    <div id="grid"><div id="item">item</div></div>`);
  const fit = render(`<style>#grid{display:grid;width:240px;grid-template-columns:repeat(auto-fit,minmax(80px,1fr))}</style>
    <div id="grid"><div id="item">item</div></div>`);
  assert.equal(rectangle(fill, "item").width, 80);
  assert.equal(rectangle(fit, "item").width, 240);
});

test("Grid percentage gaps use the corresponding content-box axis", () => {
  const definite = render(`<style>
    #grid{display:grid;width:200px;height:100px;grid-template-rows:40px 40px;row-gap:10%}
  </style><div id="grid"><div id="first"></div><div id="second"></div></div>`);
  assert.equal(rectangle(definite, "second").y, 50);

  const cyclic = render(`<style>
    #grid{display:grid;width:200px;grid-template-rows:20px 20px;row-gap:10%}
  </style><div id="grid"><div id="first"></div><div id="second"></div></div>`);
  assert.equal(rectangle(cyclic, "grid").height, 40);
  assert.equal(rectangle(cyclic, "second").y, 24);
});

test("row track sizing is rerun after column sizing changes inline wrapping", () => {
  const narrow = render(`<style>#grid{display:grid;width:80px;grid-template-columns:1fr;grid-auto-rows:auto}</style>
    <div id="grid"><div id="item">one two three four five six</div></div>`);
  const wide = render(`<style>#grid{display:grid;width:240px;grid-template-columns:1fr;grid-auto-rows:auto}</style>
    <div id="grid"><div id="item">one two three four five six</div></div>`);
  assert.ok(rectangle(narrow, "item").height > rectangle(wide, "item").height);
  assert.equal(rectangle(narrow, "grid").height, rectangle(narrow, "item").height);
  assert.equal(rectangle(wide, "grid").height, rectangle(wide, "item").height);

  const unbreakable = render(`<style>#grid{display:grid;width:40px;grid-template-columns:1fr;grid-auto-rows:auto;align-items:start}</style>
    <div id="grid"><div id="item">abcdefghij</div></div>`);
  assert.equal(rectangle(unbreakable, "grid").height, rectangle(unbreakable, "item").height);
  assert.equal(rectangle(unbreakable, "grid").height, 16);
});

test("Grid item and content alignment apply stretch through relayout and honor automatic margins", () => {
  const aligned = render(`<style>
    #grid{display:grid;width:200px;height:100px;grid-template-columns:40px 40px;grid-template-rows:20px;
      justify-content:space-between;align-content:end}
    #first{justify-self:center;width:20px}#second{align-self:end;height:8px}
  </style><div id="grid"><div id="first">first</div><div id="second">second</div></div>`);
  assert.deepEqual(rectangle(aligned, "first"), { x: 10, y: 80, width: 20, height: 20 });
  assert.deepEqual(rectangle(aligned, "second"), { x: 160, y: 92, width: 40, height: 8 });

  const automaticMargin = render(`<style>#grid{display:grid;width:100px;grid-template-columns:100px}
    #item{width:20px;margin-left:auto}</style><div id="grid"><div id="item">item</div></div>`);
  assert.equal(rectangle(automaticMargin, "item").x, 80);

  const stretched = render(`<style>#grid{display:grid;width:160px;grid-template-columns:1fr}
    #item{display:grid;grid-template-columns:1fr 1fr}#text{white-space:normal}</style>
    <div id="grid"><div id="item"><span id="text">one two three four</span></div></div>`);
  assert.equal(rectangle(stretched, "item").width, 160);
  assert.equal(rectangle(stretched, "text").width, 80);

  const replaced = render(`<div id="grid" style="display:grid;width:100px;height:50px">
    <img id="item" alt="photo" width="20" height="10">
  </div>`);
  assert.deepEqual(rectangle(replaced, "item"), { x: 0, y: 0, width: 20, height: 10 });

  const constrained = render(`<style>
    #grid{display:grid;width:100px;height:100px;grid-template-columns:100px;grid-template-rows:100px}
    #item{max-width:50px;max-height:40px}
  </style><div id="grid"><div id="item">constrained</div></div>`);
  assert.deepEqual(rectangle(constrained, "item"), { x: 0, y: 0, width: 50, height: 40 });

  const overflowingMinimum = render(`<style>
    #grid{display:grid;width:100px;height:100px;grid-template-columns:100px;grid-template-rows:100px}
    #item{min-width:120px;min-height:120px}
  </style><div id="grid"><div id="item">minimum</div></div>`);
  assert.deepEqual(rectangle(overflowingMinimum, "item"), { x: 0, y: 0, width: 120, height: 120 });

  const automaticMinimum = render(`<style>
    #grid{display:grid;width:40px;grid-template-columns:1fr;justify-items:start}
  </style><div id="grid"><div id="item">abcdefghijklmnopqrst</div></div>`);
  assert.ok(rectangle(automaticMinimum, "item").width > 40);

  const nonScrollableOverflow = render(`<style>
    #grid{display:grid;width:40px;grid-template-columns:1fr;justify-items:start}
    #item{overflow:hidden}
  </style><div id="grid"><div id="item">abcdefghijklmnopqrst</div></div>`);
  assert.equal(rectangle(nonScrollableOverflow, "item").width, 40);

  const baseline = render(`<style>
    #grid{display:grid;width:160px;grid-template-columns:1fr 1fr;align-items:baseline}
    #small{font-size:16px}#large{font-size:32px}
  </style><div id="grid"><span id="small">small</span><span id="large">large</span></div>`);
  const smallFragment = fragment(baseline, "small");
  const largeFragment = fragment(baseline, "large");
  assert.notEqual(smallFragment.baseline, null);
  assert.notEqual(largeFragment.baseline, null);
  assert.equal(
    cssPixels(smallFragment.borderRect.y + smallFragment.baseline),
    cssPixels(largeFragment.borderRect.y + largeFragment.baseline)
  );
});

test("overlapping Grid items use order-modified painting and static z-index stacking metadata", () => {
  const ordered = render(`<style>#grid{display:grid;width:32px;grid-template-columns:32px}
    #first,#second{grid-column:1;grid-row:1}#first{order:2}#second{order:1}</style>
    <div id="grid"><a id="first" href="/first">AAAA</a><a id="second" href="/second">BBBB</a></div>`);
  assert.equal(ordered.terminal.cellBuffer.rows[0].text, "AAAA");
  assert.equal(ordered.terminal.hitTestIndex.at(0, 0).action.node, ordered.document.elementById("first"));

  const stacked = render(`<style>#grid{display:grid;width:32px;grid-template-columns:32px}
    #first,#second{grid-column:1;grid-row:1}#first{z-index:2}#second{z-index:1}</style>
    <div id="grid"><a id="first" href="/first">AAAA</a><a id="second" href="/second">BBBB</a></div>`);
  assert.equal(stacked.terminal.cellBuffer.rows[0].text, "AAAA");
  assert.equal(stacked.terminal.hitTestIndex.at(0, 0).action.node, stacked.document.elementById("first"));
  assert.deepEqual(
    stacked.terminal.focusMap.targets.map((target) => target.node),
    [stacked.document.elementById("first"), stacked.document.elementById("second")]
  );
  let first = fragment(stacked, "first");
  while (stacked.layout.stacking(first.id).stackLevel !== 2) {
    const parent = stacked.layout.parent(first.id);
    assert.ok(parent, "the static Grid item's stacking context must retain its principal box");
    first = parent;
  }
  assert.equal(stacked.layout.stacking(first.id).establishesStackingContext, true);
});

test("positioned Grid descendants use resolved grid areas without entering track sizing", () => {
  const result = render(`<style>
    #grid{display:grid;position:relative;width:120px;height:60px;grid-template-columns:40px 80px;grid-template-rows:20px 40px}
    #flow{grid-column:1;grid-row:1}#absolute{position:absolute;grid-column:2/3;grid-row:2/3;inset:0}
    #unresolved{position:absolute;grid-column:missing;grid-row:1/2;inset:0}
  </style><div id="grid"><div id="flow">flow</div><a id="absolute" href="/next">absolute</a>
    <div id="unresolved">fallback</div></div>`);
  assert.deepEqual(rectangle(result, "flow"), { x: 0, y: 0, width: 40, height: 20 });
  assert.deepEqual(rectangle(result, "absolute"), { x: 40, y: 20, width: 80, height: 40 });
  assert.deepEqual(rectangle(result, "unresolved"), { x: 0, y: 0, width: 120, height: 20 });
  const absoluteNode = result.document.elementById("absolute");
  assert.equal(result.terminal.focusMap.targets.filter((target) => target.node === absoluteNode).length, 1);
});

test("horizontal RTL Grid mirrors column geometry while preserving source and search identities", () => {
  const result = render(`<style>#grid{display:grid;direction:rtl;width:120px;grid-template-columns:40px 80px}
    #first{grid-column:1}#second{grid-column:2}</style><div id="grid"><a id="first" href="/a">first</a>
    <a id="second" href="/b">second</a></div>`);
  assert.deepEqual(rectangle(result, "first"), { x: 80, y: 0, width: 40, height: 16 });
  assert.deepEqual(rectangle(result, "second"), { x: 0, y: 0, width: 80, height: 16 });
  assert.equal(result.terminal.search("first").matches.length, 1);
  assert.equal(result.terminal.search("second").matches.length, 1);
});

test("Grid layout budgets reject an uncommittable Grid without clearing finalized page prefixes", () => {
  const result = render(`<p id="before">before</p><div id="grid" style="display:grid;grid-template-columns:repeat(20,1px)">
    <span>grid item</span></div><p>after</p>`, 80, 40, { maxExplicitGridTracks: 4 });
  assert.equal(result.layout.outcome.status, "truncated");
  assert.equal(result.layout.outcome.budget, "maxExplicitGridTracks");
  assert.equal(result.layout.forDocumentNode(result.document.elementById("before")).length > 0, true);
  assert.match(result.terminal.cellBuffer.rows.map((row) => row.text).join("\n"), /before/u);
});
