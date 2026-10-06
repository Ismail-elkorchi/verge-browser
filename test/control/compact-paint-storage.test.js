import assert from "node:assert/strict";
import test from "node:test";
import { withPackedAllocationCheck } from "../../dist/memory/packed.js";
import { estimatedRetainedCost, RetainedCostAccounting } from "../../dist/memory/retained-cost.js";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { cssCoordinate, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { buildDocumentDisplayList, buildDisplayListSpatialIndex } from "../../dist/presentation/terminal/index.js";
import { PaintCommandBuilder } from "../../dist/presentation/terminal/paint-commands.js";
import { createLayoutArtworkResolver } from "../../dist/presentation/layout/paint-artwork.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

function request(columns = 80) {
  const viewport = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(columns * 8), cssPx(320));
  return { documentId: "paint", documentRevision: 1,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: 320, mediaType: "screen", prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: { width: viewport.width, height: viewport.height }, initialContainingBlock: viewport, scrollport: viewport,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: { columns, rows: 20, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16), unicode: true, ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() } };
}
function fixture(html, options) {
  const document = parseWebDocument(html, { requestUrl: "https://paint.test/", finalUrl: "https://paint.test/" });
  const store = new RenderArtifactStore(options);
  store.attach({ documentId: "paint", documentRevision: 1, stateRevision: 1, document, state: createDocumentState(document), resources: embeddedStylesheetSources(document) });
  return store;
}

test("packed paint owns only descriptor capacity and shared canonical dependencies", () => {
  const store = fixture('<style>p{background:rgba(255,0,0,.5);border:1px solid blue}</style><p>canonical paint identity</p>');
  try {
    const { documentLayout: layout, documentDisplayList: list } = store.analyze(request());
    const source = [...list.commands].find((command) => command.kind === "text");
    const fragment = layout.fragment(source.layoutFragment);
    const fragments = Object.freeze([fragment.id]);
    let charged = 0;
    const commands = withPackedAllocationCheck((bytes) => { charged += bytes; }, () => {
      const builder = new PaintCommandBuilder();
      for (let index = 0; index < 129; index += 1) assert.equal(builder.append(fragment, 0, fragment.style, 129), true);
      return builder.finish(layout, fragments, 0);
    });
    const canonical = estimatedRetainedCost([layout, fragments]);
    const owned = estimatedRetainedCost([commands]) - canonical;
    assert.equal(charged, owned, "wrapper, reference slots, used rows and spare page capacity are fenced exactly");
    const accounting = new RetainedCostAccounting();
    accounting.immutable(layout); accounting.immutable(fragments);
    assert.equal(accounting.immutable(commands).bytes, owned);
    assert.equal(Array.isArray(commands), false);
    assert.equal(Object.isFrozen(commands), true);
    assert.deepEqual(Object.keys(commands), []);
    assert.notEqual(commands.at(0), commands.at(0), "decoded command records are ephemeral");
    assert.equal(commands.at(0).style, commands.at(128).style);
    assert.equal(commands.at(0).sourceRange, fragment.sourceRange);
    assert.equal(commands.at(0).clusters, fragment.visualClusters);
    assert.equal(commands.rect(0), fragment.inkRect, "paint retains canonical glyph ink geometry rather than the CSS line-height box");
    const expanded = [...commands];
    const expandedCost = estimatedRetainedCost([layout, fragments, expanded]) - canonical;
    assert.ok(owned < expandedCost / 8, `${owned} packed bytes versus ${expandedCost} expanded bytes`);
    const background = [...list.commands].find((command) => command.kind === "background");
    const paintedBox = layout.fragment(background.layoutFragment);
    const boxFragments = Object.freeze([paintedBox.id]);
    let styleCharged = 0;
    const painted = withPackedAllocationCheck((bytes) => { styleCharged += bytes; }, () => {
      const builder = new PaintCommandBuilder();
      assert.equal(builder.append(paintedBox, 0, paintedBox.style, 5), true);
      return builder.finish(layout, boxFragments, 0);
    });
    assert.equal(styleCharged, estimatedRetainedCost([painted]) - estimatedRetainedCost([layout, boxFragments]),
      "foreground-only style sharing includes the allocated style record metadata");
    assert.equal(painted.at(0).style, paintedBox.style);
    assert.equal(painted.at(1).style.background, null);
    assert.equal(painted.at(1).style, painted.at(4).style);
  } finally { store.dispose(); }
});

test("spatial index construction never decodes commands and queries decode only visible hits", () => {
  const store = fixture('<style>body,p{margin:0}p{height:16px}</style>' + '<p>visible words</p>'.repeat(2000));
  try {
    const { documentDisplayList: list } = store.analyze(request());
    let decoded = 0;
    const commands = {
      length: list.commands.length,
      layoutFragment: (index) => list.commands.layoutFragment(index),
      rect: (index) => list.commands.rect(index),
      isText: (index) => list.commands.isText(index),
      at(index) { decoded += 1; return list.commands.at(index); },
      [Symbol.iterator]() { assert.fail("Full-document decoding must not build/query an index"); },
    };
    let constructionChecks = 0;
    assert.throws(() => buildDisplayListSpatialIndex({ ...list, commands }, { throwIfAborted() {
      if (++constructionChecks === 20) throw new Error("cancel spatial construction");
    } }), /cancel spatial construction/u);
    assert.equal(decoded, 0);
    const index = buildDisplayListSpatialIndex({ ...list, commands });
    assert.equal(decoded, 0);
    const visible = index.query(cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(16000)), cssPx(640), cssPx(320)));
    assert.ok(visible.commands.length > 0 && visible.commands.length < 100);
    assert.equal(decoded, visible.commands.length);
    assert.ok(visible.metrics.visitedIntervals < list.commands.length / 10);
    assert.ok(store.metrics().retainedCost >= store.recountRetainedCost());
  } finally { store.dispose(); }
});

test("resolved mask artwork fences its new geometry and packed paint retains only one shared reference", () => {
  const store = fixture('<div id=icon style="width:32px;height:32px;background:red;mask-image:url(/icon.svg);mask-size:contain;mask-repeat:no-repeat"></div>');
  try {
    const { documentLayout: layout } = store.analyze(request());
    const node = layout.formatting.document.elementById("icon");
    const fragment = layout.forDocumentNode(node).find((entry) => entry.kind === "box");
    const fragments = Object.freeze([fragment.id]);
    const images = Object.freeze([Object.freeze({ id: "https://paint.test/icon.svg", requestUrl: "https://paint.test/icon.svg",
      owners: Object.freeze([]), width: 32, height: 16, hasAlpha: true })]);
    const resolveArtwork = createLayoutArtworkResolver(layout, layout.formatting.styles, images);
    let charged = 0, artwork;
    const commands = withPackedAllocationCheck((bytes) => { charged += bytes; }, () => {
      artwork = resolveArtwork(fragment).artwork;
      assert.ok(artwork);
      const builder = new PaintCommandBuilder();
      assert.equal(builder.append(fragment, 0, fragment.style, 1, undefined, false, true, artwork), true);
      return builder.finish(layout, fragments, 0, images);
    });
    const canonical = estimatedRetainedCost([layout, fragments, images]);
    const owned = estimatedRetainedCost([commands]) - canonical;
    assert.equal(charged, owned, "resolved descriptor, new rectangle, reference slot and packed capacity are all fenced exactly");
    assert.equal(commands.rect(0), artwork.rect);
    assert.equal(commands.at(0).maskTint, fragment.style.background);
    assert.equal(Object.isFrozen(artwork), true);
  } finally { store.dispose(); }
});

test("pending mask descriptors fence only new metadata while sharing authored geometry and URL identity", () => {
  const store = fixture('<div id=icon style="width:32px;height:32px;background:red;mask-image:url(/icon.svg);mask-repeat:no-repeat"></div>');
  try {
    const { documentLayout: layout } = store.analyze(request());
    const fragment = layout.forDocumentNode(layout.formatting.document.elementById("icon")).find((entry) => entry.kind === "box");
    const fragments = Object.freeze([fragment.id]);
    const resolveArtwork = createLayoutArtworkResolver(layout, layout.formatting.styles, undefined);
    let charged = 0;
    const commands = withPackedAllocationCheck((bytes) => { charged += bytes; }, () => {
      const resolved = resolveArtwork(fragment);
      assert.equal(resolved.fallback, "mask-intrinsics-pending");
      assert.equal(resolved.artwork.rect, fragment.borderRect);
      const builder = new PaintCommandBuilder();
      assert.equal(builder.append(fragment, 0, fragment.style, 1, undefined, false, true, resolved.artwork), true);
      return builder.finish(layout, fragments, 0);
    });
    assert.equal(charged, estimatedRetainedCost([commands]) - estimatedRetainedCost([layout, fragments]));
    assert.equal(commands.at(0).naturalWidth, null);
    assert.equal(commands.rect(0), fragment.borderRect);
  } finally { store.dispose(); }
});

test("paint command budgets admit complete groups and failed capacity admission leaves prior owners unchanged", () => {
  const store = fixture('<style>body{margin:0}p{background:red;border:1px solid blue}</style><p>first</p><p>second</p>');
  try {
    const artifacts = store.analyze(request());
    const prior = [...artifacts.documentDisplayList.commands];
    const input = { layout: artifacts.documentLayout, styles: artifacts.computedStyles, context: request().terminalContext };
    const full = buildDocumentDisplayList(input);
    const limited = buildDocumentDisplayList({ ...input, context: { ...input.context, budgets: { maxDisplayListCommands: 4 } } });
    assert.equal(limited.outcome.status, "truncated");
    assert.equal(limited.commands.length, 0, "five-operation background/border group is indivisible");
    assert.throws(() => withPackedAllocationCheck((bytes, page) => { if (page && bytes > 1024) throw new RangeError("paint capacity"); },
      () => buildDocumentDisplayList(input)), /paint capacity/u);
    assert.deepEqual([...artifacts.documentDisplayList.commands], prior);
    assert.deepEqual([...buildDocumentDisplayList(input).commands], [...full.commands]);
  } finally { store.dispose(); }
});

test("cancellation inside packed paint construction rolls back phase ownership and can retry", () => {
  let painting = false;
  const html = '<style>body,p{margin:0}</style>' + '<p>cancel packed paint</p>'.repeat(100);
  const store = fixture(html, { instrumentation: { record(stage) { if (stage === "normal-flow-layout") painting = true; } } });
  const fresh = fixture(html);
  try {
    let checks = 0;
    assert.throws(() => store.analyze({ ...request(), signal: { throwIfAborted() {
      if (painting && ++checks === 20) { const error = new Error("cancel packed paint"); error.name = "AbortError"; throw error; }
    } } }), { name: "AbortError" });
    assert.equal(checks, 20);
    assert.equal(store.metrics().retainedAnalyses, 0);
    assert.equal(store.metrics().pinnedResources, 0);
    assert.equal(store.metrics().reservedCost, 0);
    assert.deepEqual([...store.analyze(request()).documentDisplayList.commands], [...fresh.analyze(request()).documentDisplayList.commands]);
    assert.ok(store.metrics().retainedCost >= store.recountRetainedCost());
  } finally { store.dispose(); fresh.dispose(); }
});
