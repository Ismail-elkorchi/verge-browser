import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import {
  buildDisplayListSpatialIndex, buildDocumentDisplayList, buildViewportDisplayList, rasterizeViewportDisplayList
} from "../../dist/presentation/terminal/index.js";
import { PaintCommandBuilder } from "../../dist/presentation/terminal/paint-commands.js";
import { terminalCellMeasurer, terminalCssControlMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

function fixture(t, html) {
  const document = parseWebDocument(html, { requestUrl: "https://borders.test/", finalUrl: "https://borders.test/" });
  const viewport = cssRect(cssPx(0), cssPx(0), cssPx(320), cssPx(160));
  const request = {
    documentId: "borders", documentRevision: 1,
    mediaEnvironment: { viewportWidthCssPx: 320, viewportHeightCssPx: 160, mediaType: "screen",
      prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: { width: viewport.width, height: viewport.height },
      initialContainingBlock: viewport, scrollport: viewport,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: { columns: 40, rows: 10, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16),
      unicode: true, ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() }
  };
  const store = new RenderArtifactStore();
  t.after(() => store.dispose());
  store.attach({ documentId: request.documentId, documentRevision: 1, stateRevision: 1,
    document, state: createDocumentState(document), resources: embeddedStylesheetSources(document) });
  const artifacts = store.analyze(request);
  return { document, request, ...artifacts };
}

function box(result, id, kind) {
  const node = result.document.elementById(id);
  const fragment = result.documentLayout.forDocumentNode(node).find((candidate) => candidate.kind === "box"
    && (kind === undefined || result.boxTree.node(candidate.formattingNode).kind === kind));
  assert.ok(fragment, `Missing #${id} ${kind ?? "box"}`);
  return fragment;
}

function geometry(fragment) {
  return { contentRect: fragment.contentRect, paddingRect: fragment.paddingRect, borderRect: fragment.borderRect,
    marginRect: fragment.marginRect, overflowRect: fragment.overflowRect, inlineContinuations: fragment.inlineContinuations };
}

function viewport(list, context = list.context) {
  return buildViewportDisplayList({ documentDisplayList: list, spatialIndex: buildDisplayListSpatialIndex(list), context,
    window: { scrollRow: 0, viewportRows: 10, overscanBefore: 0, overscanAfter: 0 } });
}

const base = "html,body{margin:0}";

test("transparent overlays preserve underlying glyphs, styles and source identity at every terminal capability", (t) => {
  for (const background of ["none", "white", "#111", "rgba(20,40,80,.5)"]) {
    const result = fixture(t, `<!doctype html><style>${base}body{background:${background}}
      #under{color:#c86432;font-weight:bold;font-style:italic;text-decoration:underline}
      #over{position:absolute;left:0;top:0;width:160px;height:48px;border:1px solid transparent}
      </style><a id="under" href="/source">UNDERLYING TEXT SHOULD REMAIN</a><div id="over"></div>`);
    const over = result.document.elementById("over");
    for (const colorDepth of [0, 4, 8, 24]) {
      for (const unicode of [false, true]) {
        const context = { ...result.request.terminalContext, colorDepth, unicode };
        const list = buildDocumentDisplayList({ layout: result.documentLayout, styles: result.computedStyles, context });
        const displayList = viewport(list, context);
        const actual = rasterizeViewportDisplayList({ displayList });
        const expected = rasterizeViewportDisplayList({ displayList: {
          ...displayList, commands: displayList.commands.filter((command) => command.documentNode !== over)
        } });
        assert.equal(list.commands.some((command) => command.documentNode === over), false);
        assert.deepEqual(actual, expected, `${background}, depth ${colorDepth}, unicode ${unicode}`);
        const row = actual.cellBuffer.rows[0];
        assert.ok(row.text.startsWith("UNDERLYING TEXT SHOULD REMAIN"));
        const first = row.cells[0];
        assert.equal(first.text, "U");
        assert.equal(first.style.bold, true);
        assert.equal(first.style.italic, true);
        assert.equal(first.style.underline, true);
        assert.ok(row.spans[0].sourceRange);
        assert.equal(row.spans[0].contentStartCodeUnit, 0);
        const text = [...list.commands].find((command) => command.id === first.command);
        assert.equal(first.layoutFragment, text.layoutFragment);
        assert.equal(first.formattingNode, text.formattingNode);
        assert.equal(first.documentNode, text.documentNode);
        assert.equal(first.paintOrder, text.paintOrder);
      }
    }
  }
});

test("transparent solid borders keep the same layout geometry as opaque borders", (t) => {
  const render = (color) => fixture(t, `<style>${base}#box{width:80px;height:32px;padding:4px;margin:3px;border:2px solid ${color}}</style>
    <div id="box">text</div><div id="after">after</div>`);
  const transparent = render("rgba(255,0,0,0)");
  const opaque = render("blue");
  assert.deepEqual(geometry(box(transparent, "box")), geometry(box(opaque, "box")));
  assert.deepEqual(geometry(box(transparent, "after")), geometry(box(opaque, "after")));
  const target = box(transparent, "box");
  assert.equal(target.paddingRect.x - target.borderRect.x, cssPx(2));
  assert.equal(target.paddingRect.y - target.borderRect.y, cssPx(2));
  assert.equal([...transparent.documentDisplayList.commands].filter((command) => command.kind === "border-side").length, 0);
  assert.equal([...opaque.documentDisplayList.commands].filter((command) => command.kind === "border-side").length, 4);
});

test("mixed sides retain partial alpha, default null and resolved currentColor", (t) => {
  const result = fixture(t, `<style>${base}#mixed{width:80px;height:32px;border:2px solid;
      border-top-color:transparent;border-right-color:rgba(0,128,255,.5);border-left-color:red}
      #current{color:purple;margin-top:16px;border:2px solid currentColor;width:80px;height:32px}</style>
    <div id="mixed"></div><div id="current"></div>`);
  const mixed = box(result, "mixed");
  assert.equal(mixed.style.borderColors.bottom, null, "null is the terminal/default currentColor sentinel");
  const borders = [...result.documentDisplayList.commands].filter((command) => command.kind === "border-side"
    && command.layoutFragment === mixed.id);
  assert.deepEqual(borders.map((command) => command.side), ["right", "bottom", "left"]);
  assert.equal(borders[0].style.borderColors.right.a, .5);
  assert.equal(borders[1].style.borderColors.bottom, null);
  assert.deepEqual(borders[2].style.borderColors.left, { r: 255, g: 0, b: 0, a: 1 });
  const current = box(result, "current");
  const resolved = [...result.documentDisplayList.commands].filter((command) => command.kind === "border-side"
    && command.layoutFragment === current.id);
  assert.equal(resolved.length, 4);
  assert.ok(resolved.every((command) => command.style.borderColors[command.side] === current.style.foreground));
  for (const colorDepth of [0, 4, 8, 24]) {
    for (const unicode of [false, true]) {
      const cells = rasterizeViewportDisplayList({ displayList: viewport(result.documentDisplayList,
        { ...result.request.terminalContext, colorDepth, unicode }) }).cellBuffer.rows.flatMap((row) => row.cells);
      for (const command of borders) assert.ok(cells.some((cell) => cell.command === command.id), `${command.side} still paints`);
    }
  }
});

test("wrapped inline continuations suppress transparent sides without changing continuation geometry", (t) => {
  const render = (color) => fixture(t, `<style>${base}div{width:96px}span{border:2px solid ${color};padding:1px}</style>
    <div><span id="inline">one two three four five six seven eight</span></div>`);
  const transparent = render("transparent");
  const opaque = render("red");
  const target = box(transparent, "inline");
  const visible = box(opaque, "inline");
  assert.ok(target.inlineContinuations.length > 1);
  assert.deepEqual(geometry(target), geometry(visible));
  assert.equal(transparent.documentDisplayList.commands.some((command) => command.kind === "border-side"
    && command.layoutFragment === target.id), false);
  const borders = [...opaque.documentDisplayList.commands].filter((command) => command.kind === "border-side"
    && command.layoutFragment === visible.id);
  assert.ok(borders.length > 4);
  assert.equal(borders.filter((command) => command.side === "top").length, target.inlineContinuations.length);
  assert.equal(borders.filter((command) => command.side === "bottom").length, target.inlineContinuations.length);
  const builder = new PaintCommandBuilder();
  assert.equal(builder.append(target, 0, target.style, 0), true);
  assert.equal(builder.length, 0, "transparent continuation sides do not consume the admission budget");
});

test("command admission counts only eligible ink and still admits complete background groups", (t) => {
  for (const background of ["none", "blue"]) {
    const result = fixture(t, `<style>${base}#box{width:80px;height:32px;background:${background};border:2px solid transparent}</style>
      <div id="box"></div>`);
    const target = box(result, "box");
    const limit = background === "none" ? 0 : 1;
    const builder = new PaintCommandBuilder();
    assert.equal(builder.append(target, 0, target.style, limit), true);
    assert.equal(builder.length, limit);
    const commands = builder.finish(result.documentLayout, [target.id], 0);
    assert.equal(commands.length, limit);
    if (limit > 0) assert.equal(commands.at(0).kind, "background");
    const list = buildDocumentDisplayList({ layout: result.documentLayout, styles: result.computedStyles,
      context: { ...result.request.terminalContext, budgets: { maxDisplayListCommands: limit } } });
    assert.equal(list.outcome.status, "complete");
    assert.equal(list.commands.length, limit);
    const raster = rasterizeViewportDisplayList({ displayList: viewport(list,
      { ...list.context, budgets: { ...list.context.budgets, maxGeneratedPaintUnits: limit === 0 ? 0 : 200 } }) });
    assert.equal(raster.cellBuffer.outcome.status, "complete");
    assert.equal(raster.truncations.length, 0);
  }

  const mixed = fixture(t, `<style>${base}#box{width:80px;height:32px;background:blue;border:2px solid red;border-top-color:transparent}</style>
    <div id="box"></div>`);
  const target = box(mixed, "box");
  const builder = new PaintCommandBuilder();
  assert.equal(builder.append(target, 0, target.style, 3), false);
  assert.equal(builder.length, 0, "a rejected group cannot retain a partial background or border");
  assert.equal(builder.append(target, 0, target.style, 4), true);
  assert.equal(builder.length, 4);
});

test("transparent collapsed winners keep shared-edge geometry and never reveal a losing visible border", (t) => {
  for (const direction of ["ltr", "rtl"]) {
    const render = (color) => fixture(t, `<style>${base}table{border-collapse:collapse;direction:${direction}}
      #winner{border-right:4px solid ${color}}#loser{border-left:2px solid blue}</style>
      <table><tr><td id="winner">left</td><td id="loser">right</td></tr></table>`);
    const transparent = render("transparent");
    const opaque = render("red");
    const winner = box(transparent, "winner", "table-cell");
    const loser = box(transparent, "loser", "table-cell");
    for (const id of ["winner", "loser"]) assert.deepEqual(geometry(box(transparent, id, "table-cell")),
      geometry(box(opaque, id, "table-cell")));
    assert.equal(winner.borderRect.width - winner.paddingRect.width, cssPx(2));
    assert.equal(loser.borderRect.width - loser.paddingRect.width, cssPx(2));
    const segments = [winner, loser].flatMap((fragment) => fragment.tableCollapsedBorderSegments ?? []);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].style.borderColors[segments[0].side].a, 0);
    assert.equal(segments[0].documentNode, winner.documentNode);
    assert.equal(transparent.documentDisplayList.commands.some((command) => command.kind === "border-side"), false);
    assert.equal([...opaque.documentDisplayList.commands].filter((command) => command.kind === "border-side").length, 1);
    for (const fragment of [winner, loser]) {
      const builder = new PaintCommandBuilder();
      assert.equal(builder.append(fragment, 0, fragment.style, 0), true);
      assert.equal(builder.length, 0, "transparent resolved segments do not consume the admission budget");
    }
  }
});


test("transparent overlay consumes no command or generated-unit budget ahead of retained text", (t) => {
  const result = fixture(t, `<style>${base}#over{position:absolute;left:0;top:0;width:160px;height:48px;border:1px solid transparent}</style>
    <div>KEEP</div><div id="over"></div>`);
  const context = { ...result.request.terminalContext, budgets: { maxDisplayListCommands: 1, maxGeneratedPaintUnits: 4 } };
  const list = buildDocumentDisplayList({ layout: result.documentLayout, styles: result.computedStyles, context });
  assert.equal(list.outcome.status, "complete");
  assert.equal(list.commands.length, 1);
  assert.equal(list.commands.at(0).kind, "text");
  const raster = rasterizeViewportDisplayList({ displayList: viewport(list) });
  assert.equal(raster.cellBuffer.outcome.status, "complete");
  assert.equal(raster.cellBuffer.rows[0].text, "KEEP");
  assert.equal(raster.cellBuffer.rows[0].cells.length, 4);
  assert.deepEqual(raster.truncations, []);
});

test("collapsed mixed colors retain canonical segment IDs and partially transparent/default-color commands", (t) => {
  const result = fixture(t, `<style>${base}table{border-collapse:collapse;width:80px;height:48px;border:4px solid;
    border-top-color:transparent;border-right-color:rgba(0,128,255,.5);border-left-color:red}</style><table id="table"></table>`);
  const target = box(result, "table", "table");
  const segments = target.tableCollapsedBorderSegments;
  assert.equal(segments.length, 4, "layout still retains the transparent winning segment");
  const expected = segments.filter((segment) => segment.style.borderColors[segment.side]?.a !== 0);
  assert.equal(expected.length, 3);
  const builder = new PaintCommandBuilder();
  assert.equal(builder.append(target, 0, target.style, 3), true);
  const commands = builder.finish(result.documentLayout, [target.id], 0);
  assert.equal(commands.length, 3);
  for (const [index, command] of [...commands].entries()) {
    const segment = expected[index];
    assert.equal(command.id, segment.id);
    assert.equal(command.style, segment.style);
    assert.equal(command.rect, segment.borderRect);
    assert.equal(command.borderWidths, segment.borderWidths);
    assert.equal(command.sourceRange, segment.sourceRange);
    assert.equal(command.documentNode, segment.documentNode);
    assert.equal(command.formattingNode, segment.formattingNode);
    assert.equal(command.paintOrder, index);
  }
  assert.deepEqual([...commands].map((command) => command.side).sort(), ["bottom", "left", "right"]);
  assert.equal([...commands].find((command) => command.side === "bottom").style.borderColors.bottom, null);
  assert.equal([...commands].find((command) => command.side === "right").style.borderColors.right.a, .5);
});
