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
import {
  normalizeGridPlacement,
  sizeGridTracks
} from "../../dist/presentation/layout/grid/index.js";
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

function cssLength(value) {
  return cssLengthFromFixed(cssPx(value));
}

function autoTrack() {
  return Object.freeze({ kind: "breadth", breadth: Object.freeze({ kind: "auto" }) });
}

function contribution(formattingNode, start, end, minimum, minContent, maxContent) {
  return Object.freeze({
    formattingNode,
    start,
    end,
    minimumContribution: cssLength(minimum),
    minContent: cssLength(minContent),
    maxContent: cssLength(maxContent)
  });
}

test("staged intrinsic track sizing uses planned increases independent of item order", () => {
  const first = contribution("first", 0, 1, 10, 10, 10);
  const spanning = contribution("spanning", 0, 2, 30, 30, 100);
  const size = (contributions) => sizeGridTracks({
    tracks: [autoTrack(), autoTrack()],
    contributions,
    availableSize: null,
    gap: cssLength(0),
    resolveLength: () => null,
    alignment: { value: "start", overflow: "default" },
    maxWork: 10_000,
    signal: undefined
  });
  for (const permutation of [[first, spanning], [spanning, first]]) {
    const result = size(permutation);
    assert.deepEqual(result.tracks.map((track) => cssPixels(track.baseSize)), [10, 20]);
    assert.deepEqual(result.tracks.map((track) =>
      track.growthLimit.kind === "finite" ? cssPixels(track.growthLimit.value) : "infinite"), [10, 90]);
  }

  const overlaps = [
    contribution("a", 0, 2, 50, 50, 80),
    contribution("b", 1, 3, 70, 70, 120),
    contribution("c", 0, 3, 120, 120, 180)
  ];
  const states = [];
  for (const permutation of [overlaps, [overlaps[2], overlaps[0], overlaps[1]], [...overlaps].reverse()]) {
    const result = sizeGridTracks({
      tracks: [autoTrack(), autoTrack(), autoTrack()],
      contributions: permutation,
      availableSize: null,
      gap: cssLength(0),
      resolveLength: () => null,
      alignment: { value: "start", overflow: "default" },
      maxWork: 20_000,
      signal: undefined
    });
    states.push(result.tracks.map((track) => ({
      base: track.baseSize,
      growth: track.growthLimit.kind === "finite" ? track.growthLimit.value : null
    })));
  }
  assert.deepEqual(states[1], states[0]);
  assert.deepEqual(states[2], states[0]);

  const disjointSpanGroups = sizeGridTracks({
    tracks: [autoTrack(), autoTrack(), autoTrack(), autoTrack(), autoTrack()],
    contributions: [
      contribution("early-span-group", 0, 2, 20, 20, 40),
      contribution("later-span-group", 2, 5, 30, 30, 90)
    ],
    availableSize: null,
    gap: cssLength(0),
    resolveLength: () => null,
    alignment: { value: "start", overflow: "default" },
    maxWork: 30_000,
    signal: undefined
  });
  assert.deepEqual(
    disjointSpanGroups.tracks.map((track) =>
      track.growthLimit.kind === "finite" ? cssPixels(track.growthLimit.value) : "infinite"),
    [20, 20, 30, 30, 30]
  );

  const constrained = sizeGridTracks({
    tracks: [
      { kind: "minmax", minimum: { kind: "auto" }, maximum: { kind: "length", value: { kind: "length", value: 10, unit: "px" } } },
      { kind: "minmax", minimum: { kind: "auto" }, maximum: { kind: "max-content" } }
    ],
    contributions: [contribution("spanning-limit", 0, 2, 30, 30, 60)],
    availableSize: null,
    gap: cssLength(0),
    resolveLength: (value) => value.kind === "length" && value.unit === "px" ? cssLength(value.value) : null,
    alignment: { value: "start", overflow: "default" },
    maxWork: 10_000,
    signal: undefined
  });
  assert.deepEqual(constrained.tracks.map((track) => cssPixels(track.baseSize)), [10, 20]);

  const intrinsicModes = (sizingConstraint) => sizeGridTracks({
    tracks: [autoTrack(), autoTrack()],
    contributions: [first, spanning],
    availableSize: null,
    gap: cssLength(0),
    resolveLength: () => null,
    alignment: { value: "start", overflow: "default" },
    sizingConstraint,
    maxWork: 10_000,
    signal: undefined
  });
  assert.equal(cssPixels(intrinsicModes("min-content").usedSize), 30);
  assert.equal(cssPixels(intrinsicModes("max-content").usedSize), 100);

  const subOneFlexible = sizeGridTracks({
    tracks: [
      { kind: "breadth", breadth: { kind: "flex", factor: 0.25 } },
      { kind: "breadth", breadth: { kind: "flex", factor: 0.25 } }
    ],
    contributions: [contribution("sub-one-flex", 0, 2, 100, 100, 100)],
    availableSize: null,
    gap: cssLength(0),
    resolveLength: () => null,
    alignment: { value: "start", overflow: "default" },
    maxWork: 10_000,
    signal: undefined
  });
  assert.deepEqual(subOneFlexible.tracks.map((track) => cssPixels(track.baseSize)), [50, 50]);
});

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

test("sparse locked-axis placement retains an independent frontier while dense packing fills holes", () => {
  const markup = (flow) => `<style>
    #grid{display:grid;width:160px;grid-template-columns:repeat(4,40px);grid-auto-columns:40px;
      grid-auto-rows:16px;grid-auto-flow:${flow}}
    #definite{grid-row:1;grid-column:2}#wide{grid-row:1;grid-column:span 2}#tail{grid-row:1}
  </style><div id="grid"><div id="definite">d</div><div id="wide">w</div><div id="tail">t</div></div>`;
  const sparse = render(markup("row"));
  assert.equal(rectangle(sparse, "wide").x, 80);
  assert.equal(rectangle(sparse, "tail").x, 160);
  const dense = render(markup("row dense"));
  assert.equal(rectangle(dense, "wide").x, 80);
  assert.equal(rectangle(dense, "tail").x, 0);

  const definiteDoesNotAdvanceFrontier = render(`<style>
    #grid{display:grid;width:160px;grid-template-columns:repeat(4,40px);grid-auto-rows:16px}
    #definite{grid-row:1;grid-column:4}#first{grid-row:1}#second{grid-row:1}
  </style><div id="grid"><div id="definite">d</div><div id="first">f</div><div id="second">s</div></div>`);
  assert.equal(rectangle(definiteDoesNotAdvanceFrontier, "first").x, 0);
  assert.equal(rectangle(definiteDoesNotAdvanceFrontier, "second").x, 40);

  const transposed = (flow) => `<style>
    #grid{display:grid;width:40px;grid-template-columns:40px;grid-template-rows:repeat(4,16px);
      grid-auto-rows:16px;grid-auto-flow:${flow}}
    #definite{grid-column:1;grid-row:2}#wide{grid-column:1;grid-row:span 2}#tail{grid-column:1}
  </style><div id="grid"><div id="definite">d</div><div id="wide">w</div><div id="tail">t</div></div>`;
  assert.equal(rectangle(render(transposed("column")), "tail").y, 64);
  assert.equal(rectangle(render(transposed("column dense")), "tail").y, 0);
});

test("Grid placement conflicts normalize once before line resolution", () => {
  const auto = Object.freeze({ kind: "auto" });
  const line = (index, name = null) => Object.freeze({ kind: "line", span: false, index, name });
  const span = (index, name = null) => Object.freeze({ kind: "line", span: true, index, name });
  const normalized = (columnStart, columnEnd) => normalizeGridPlacement({
    columnStart,
    columnEnd,
    rowStart: auto,
    rowEnd: auto
  });
  assert.deepEqual(normalized(span(null, "foo"), auto), {
    columnStart: { kind: "line", span: true, index: 1, name: null },
    columnEnd: auto,
    rowStart: auto,
    rowEnd: auto
  });
  assert.deepEqual(normalized(span(null, "foo"), span(null, "foo")).columnEnd, auto);
  assert.deepEqual(normalized(span(2, "foo"), span(3, "bar")), {
    columnStart: span(2, "foo"),
    columnEnd: auto,
    rowStart: auto,
    rowEnd: auto
  });

  const result = render(`<style>#grid{display:grid;width:120px;grid-template-columns:repeat(3,40px)}
    #equal{grid-column:2/2}#reversed{grid-column:3/1}#negative{grid-column:-2/-1}</style>
    <div id="grid"><div id="equal">e</div><div id="reversed">r</div><div id="negative">n</div></div>`);
  assert.deepEqual(((rect) => ({ x: rect.x, width: rect.width }))(rectangle(result, "equal")), { x: 40, width: 40 });
  assert.deepEqual(((rect) => ({ x: rect.x, width: rect.width }))(rectangle(result, "reversed")), { x: 0, width: 80 });
  assert.deepEqual(((rect) => ({ x: rect.x, width: rect.width }))(rectangle(result, "negative")), { x: 80, width: 40 });
  assert.deepEqual(line(-1), { kind: "line", span: false, index: -1, name: null });

  const equivalent = render(`<style>#grid{display:grid;position:relative;width:120px;height:40px;
      grid-template-columns:repeat(3,40px);grid-template-rows:40px}
    #shorthand{grid-column:3/1;grid-row:1}#longhand{grid-column-start:3;grid-column-end:1;grid-row:1}
    #absolute{position:absolute;grid-column:3/1;grid-row:1/2;left:0;right:0;height:10px}</style>
    <div id="grid"><div id="shorthand"></div><div id="longhand"></div><div id="absolute"></div></div>`);
  assert.deepEqual(rectangle(equivalent, "shorthand"), rectangle(equivalent, "longhand"));
  assert.deepEqual(
    (({ x, width }) => ({ x, width }))(rectangle(equivalent, "absolute")),
    { x: 0, width: 80 }
  );
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

  const collapsedMiddle = render(`<style>#grid{display:grid;width:140px;
    grid-template-columns:repeat(auto-fit,40px);column-gap:10px;justify-content:space-between}
    #first{grid-column:1}#third{grid-column:3}</style>
    <div id="grid"><div id="first">first</div><div id="third">third</div></div>`);
  assert.equal(rectangle(collapsedMiddle, "first").x, 0);
  assert.equal(rectangle(collapsedMiddle, "third").x, 40);

  const fixedTracks = Array.from({ length: 3 }, () => ({
    kind: "breadth",
    breadth: { kind: "length", value: { kind: "length", value: 40, unit: "px" } }
  }));
  const gutters = (collapsedTracks, alignment = "start") => sizeGridTracks({
    tracks: fixedTracks,
    collapsedTracks,
    contributions: [],
    availableSize: cssLength(140),
    gap: cssLength(10),
    resolveLength: (value) => value.kind === "length" && value.unit === "px" ? cssLength(value.value) : null,
    alignment: { value: alignment, overflow: "default" },
    maxWork: 10_000,
    signal: undefined
  });
  assert.deepEqual(gutters(new Set([1])).activeGutterBoundaries, [false, false]);
  assert.deepEqual(gutters(new Set([0])).activeGutterBoundaries, [false, true]);
  assert.deepEqual(gutters(new Set([2])).activeGutterBoundaries, [true, false]);
  assert.deepEqual(gutters(new Set([0, 1])).activeGutterBoundaries, [false, false]);
  assert.deepEqual(gutters(new Set([0, 1, 2])).activeGutterBoundaries, [false, false]);
  assert.equal(cssPixels(gutters(new Set([1]), "space-between").tracks[2].offset), 40);
  assert.equal(cssPixels(gutters(new Set([1]), "space-around").tracks[2].offset), 55);
  assert.equal(cssPixels(gutters(new Set([1]), "space-evenly").tracks[2].offset), 60);

  const collapsedRow = render(`<style>#grid{display:grid;width:40px;height:140px;
    grid-template-rows:repeat(auto-fit,40px);row-gap:10px;align-content:space-between}
    #first{grid-row:1}#third{grid-row:3}</style>
    <div id="grid"><div id="first">first</div><div id="third">third</div></div>`);
  assert.equal(rectangle(collapsedRow, "third").y, 40);

  const rtlCollapsed = render(`<style>#grid{display:grid;direction:rtl;width:140px;
    grid-template-columns:repeat(auto-fit,40px);column-gap:10px;justify-content:space-between}
    #first{grid-column:1}#third{grid-column:3}</style>
    <div id="grid"><div id="first">first</div><div id="third">third</div></div>`);
  assert.equal(rectangle(rtlCollapsed, "first").x - rectangle(rtlCollapsed, "third").x, 40);
});

test("Grid overflow alignment distinguishes safe, unsafe, and default actual geometry", () => {
  const item = (alignment, direction = "ltr", overflow = "visible") => render(`<style>
    #grid{display:grid;direction:${direction};width:100px;grid-template-columns:100px;overflow:${overflow}}
    #item{width:120px;justify-self:${alignment}}</style>
    <div id="grid"><div id="item">oversized</div></div>`);
  assert.equal(rectangle(item("safe end"), "item").x, 0);
  assert.equal(rectangle(item("unsafe end"), "item").x, -20);
  assert.equal(rectangle(item("safe center"), "item").x, 0);
  assert.equal(rectangle(item("unsafe center"), "item").x, -10);
  assert.equal(rectangle(item("unsafe end", "rtl"), "item").x, 0);
  assert.equal(rectangle(item("safe end", "ltr", "hidden"), "item").x, 0);

  const content = (alignment) => render(`<style>#grid{display:grid;width:100px;
    grid-template-columns:60px 60px;justify-content:${alignment}}</style>
    <div id="grid"><div id="first">first</div><div>second</div></div>`);
  assert.equal(rectangle(content("safe end"), "first").x, 0);
  assert.equal(rectangle(content("unsafe end"), "first").x, -20);
  assert.equal(rectangle(content("safe center"), "first").x, 0);
  assert.equal(rectangle(content("unsafe center"), "first").x, -10);
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

test("Grid track distribution checks deterministic work and cancellation boundaries", () => {
  const tracks = Array.from({ length: 64 }, autoTrack);
  const contributions = Array.from(
    { length: 256 },
    (_, index) => contribution(`bounded-${String(index)}`, index % 48, index % 48 + 16, 64, 96, 160)
  );
  const input = {
    tracks,
    contributions,
    availableSize: cssLength(1_024),
    gap: cssLength(1),
    resolveLength: () => null,
    alignment: { value: "stretch", overflow: "default" },
    signal: undefined
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => sizeGridTracks({ ...input, maxWork: 1_000 }),
      (error) => error?.name === "GridWorkBudgetExceeded"
        && error.budget === "maxGridTrackSizingWork"
        && error.limit === 1_000
    );
  }

  let cancellationChecks = 0;
  const cancellation = new Error("cancel Grid track sizing");
  assert.throws(
    () => sizeGridTracks({
      ...input,
      maxWork: 1_000_000,
      signal: {
        throwIfAborted() {
          cancellationChecks += 1;
          if (cancellationChecks === 250) throw cancellation;
        }
      }
    }),
    (error) => error === cancellation
  );
  assert.equal(cancellationChecks, 250);
});
