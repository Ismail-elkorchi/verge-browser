import assert from "node:assert/strict";
import test from "node:test";
import { PackedRows, withPackedAllocationCheck } from "../../dist/memory/packed.js";
import { estimatedRetainedCost, RetainedCostAccounting } from "../../dist/memory/retained-cost.js";
import { processCssText } from "../../dist/presentation/text/index.js";
import { resolveBidiParagraph, BidiLevels } from "../../dist/unicode/index.js";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { embeddedStylesheetSources } from "../../dist/presentation/style/index.js";
import { cssCoordinate, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer, terminalCssControlMeasurer } from "../../dist/ui/terminal-measure.js";

test("packed capacity admission precedes page growth and independent recount includes spare capacity", () => {
  let capacity = 0;
  const rows = withPackedAllocationCheck((bytes) => { capacity += bytes; }, () => new PackedRows(3, false, 4));
  withPackedAllocationCheck((bytes) => { capacity += bytes; }, () => rows.push(1, 2, 3));
  assert.equal(rows.length, 1);
  assert.equal(capacity, estimatedRetainedCost([rows]));
  assert.throws(() => withPackedAllocationCheck(() => { throw new RangeError("quota"); }, () => {
    rows.push(4, 5, 6); rows.push(7, 8, 9); rows.push(10, 11, 12); rows.push(13, 14, 15);
  }), /quota/u);
  assert.equal(rows.length, 4);
  const accounting = new RetainedCostAccounting();
  assert.equal(accounting.immutable(rows).bytes, estimatedRetainedCost([rows]));
  rows.seal();
  assert.throws(() => rows.push(16, 17, 18), RangeError);
});

test("canonical packed CSS text keeps grapheme and expansion offsets immutable", () => {
  const processed = processCssText("aß é\t😀\nX", "uppercase", "pre");
  assert.equal(processed.outcome.status, "complete");
  assert.deepEqual([...processed.units].map(({ text, contentStartCodeUnit, contentEndCodeUnit }) => [text, contentStartCodeUnit, contentEndCodeUnit]),
    [["A", 0, 1], ["S", 1, 2], ["S", 1, 2], [" ", 2, 3], ["É", 3, 5], ["\t", 5, 6], ["😀", 6, 8], ["", 8, 9], ["X", 9, 10]]);
  processed.units.at(0).text = "mutated view";
  assert.equal(processed.units.at(0).text, "A");
  assert.equal(Array.isArray(processed.units), false);
});

test("packing cannot hide invalid bidi source offsets", () => {
  for (const sourceStartCodeUnit of [-1, Number.NaN, 0.5]) {
    const paragraph = resolveBidiParagraph([{kind: "code-point", text: "a", codePoint: 97,
      bidiClass: "L", sourceStartCodeUnit, sourceEndCodeUnit: 1, identity: null}]);
    assert.deepEqual(paragraph.outcome, {status: "rejected", reason: "invalid-item"});
  }
});

function request(columns) {
  const rect = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(columns * 8), cssPx(320));
  return { documentId: "compact", documentRevision: 1,
    mediaEnvironment: { viewportWidthCssPx: columns * 8, viewportHeightCssPx: 320, mediaType: "screen", prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" },
    layoutContext: { viewport: {width: rect.width, height: rect.height}, initialContainingBlock: rect, scrollport: rect,
      textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer() },
    terminalContext: {columns, rows: 20, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16), unicode: true, ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer()} };
}

test("same-style resize reuses packed intrinsic advances and break classification", () => {
  const document = parseWebDocument('<style>body{margin:0}div{display:flex}p{margin:0}</style><div><p>alpha beta <span>gamma delta epsilon</span></p><p>אבג xyz</p></div>', {requestUrl: "https://compact.test/", finalUrl: "https://compact.test/"});
  const store = new RenderArtifactStore();
  store.attach({documentId: "compact", documentRevision: 1, stateRevision: 1, document, state: createDocumentState(document), resources: embeddedStylesheetSources(document)});
  try {
    const cold = store.analyze(request(80));
    const warm = store.analyze(request(40));
    assert.equal(cold.inlineItemStreams, warm.inlineItemStreams);
    assert.ok(cold.documentLayout.textAnalysisWork.intrinsicAnalyzedUnits > 0);
    assert.ok(warm.documentLayout.textAnalysisWork.intrinsicReuses > 0);
    assert.equal(warm.documentLayout.textAnalysisWork.intrinsicAnalyzedUnits, 0);
    assert.equal(warm.documentLayout.textAnalysisWork.inlineBuilds, 0);
    assert.ok(store.metrics().retainedCost >= store.recountRetainedCost());
    assert.ok(store.metrics().allocatedPackedPages > 0);
  } finally { store.dispose(); }
  assert.equal(store.metrics().retainedCost, 0);
});

test("level-vector allocation fence includes immutable wrapper metadata", () => {
  let charged = 0;
  const levels = withPackedAllocationCheck((bytes) => { charged += bytes; }, () => BidiLevels.from([0, 1, 2]));
  assert.equal(charged, estimatedRetainedCost([levels]));
});

test("bidi exceptional source offsets preserve the complete safe-integer range", () => {
  const sourceStartCodeUnit = 0x100000000;
  const paragraph = resolveBidiParagraph([{kind: "code-point", text: "a", codePoint: 97,
    bidiClass: "L", sourceStartCodeUnit, sourceEndCodeUnit: sourceStartCodeUnit + 1, identity: null}]);
  assert.equal(paragraph.outcome.status, "complete");
  assert.equal(paragraph.items.at(0).sourceStartCodeUnit, sourceStartCodeUnit);
  assert.equal(paragraph.items.at(0).sourceEndCodeUnit, sourceStartCodeUnit + 1);
});

test("committed capacity ownership exchanges reservations while cancellation leaves them intact", () => {
  const accounting = new RetainedCostAccounting();
  let reserved = 0;
  withPackedAllocationCheck((bytes) => { reserved += bytes; }, () => {
    const rows = new PackedRows(2); rows.push(1, 2); rows.seal();
    const before = reserved;
    assert.ok(before > 0);
    const aborted = { throwIfAborted() { throw new Error("cancelled owner"); } };
    assert.throws(() => accounting.immutable(rows, new Set(), aborted), /cancelled owner/u);
    assert.equal(reserved, before);
    const owner = accounting.immutable(rows);
    assert.equal(reserved, 0);
    assert.equal(owner.bytes, estimatedRetainedCost([rows]));
    assert.equal(accounting.immutable(rows), owner);
    assert.equal(reserved, 0);
  });
});

test("selected-line L1 resets preserved trailing spaces before fragment coalescing", () => {
  for (const whiteSpace of ["pre-wrap", "break-spaces"]) {
    for (const text of ["אבג   דהו", "<span>אבג</span><span>   </span><span>דהו</span>"]) {
      const document = parseWebDocument(`<style>html,body{margin:0}</style><div dir=ltr style="width:40px;white-space:${whiteSpace}">${text}</div>`,
        {requestUrl: "https://compact.test/", finalUrl: "https://compact.test/"});
      const store = new RenderArtifactStore();
      store.attach({documentId: "compact", documentRevision: 1, stateRevision: 1, document,
        state: createDocumentState(document), resources: embeddedStylesheetSources(document)});
      try {
        const layout = store.analyze(request(80)).documentLayout;
        const first = layout.lineBoxes[0];
        const fragments = first.fragments.map((id) => layout.fragment(id)).filter((fragment) => fragment.kind === "text")
          .sort((left, right) => left.contentRect.x - right.contentRect.x);
        assert.equal(fragments.map((fragment) => fragment.visualText).join(""), "גבא   ", `${whiteSpace}: ${text}`);
        assert.deepEqual(fragments.map((fragment) => fragment.embeddingLevel), [1, 0]);
      } finally { store.dispose(); }
    }
  }
});

test("a changed measurement callable invalidates layout and canonical advances even with identical default metrics", () => {
  const document = parseWebDocument("<p>abc</p>", {requestUrl: "https://compact.test/", finalUrl: "https://compact.test/"});
  const store = new RenderArtifactStore();
  store.attach({documentId: "compact", documentRevision: 1, stateRevision: 1, document,
    state: createDocumentState(document), resources: embeddedStylesheetSources(document)});
  try {
    const first = store.analyze(request(80));
    const next = request(80);
    const original = next.layoutContext.textMeasurer;
    next.layoutContext.textMeasurer = {...original, measure(text, fontSize) { return original.measure(text, fontSize) * 2; }};
    const second = store.analyze(next);
    assert.equal(first.inlineItemStreams, second.inlineItemStreams);
    assert.notEqual(first.documentLayout, second.documentLayout);
    assert.ok(second.documentLayout.textAnalysisWork.inlineBuilds > 0);
    assert.equal(second.documentLayout.lineBoxes[0].usedInlineAdvance, first.documentLayout.lineBoxes[0].usedInlineAdvance * 2);
  } finally { store.dispose(); }
});
