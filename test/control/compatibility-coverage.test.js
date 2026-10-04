import assert from "node:assert/strict";
import test from "node:test";

import { paintedSourceUnits, phrasePaintCoverage, sourceUnitPainted } from "../../scripts/compat/paint-coverage.mjs";

const range = (start, end) => ({ start, end, provenance: "input" });
const unit = (text, start = 0, formattingNode = "first") => ({
  text, formattingNode, documentNode: formattingNode,
  contentStartCodeUnit: start, contentEndCodeUnit: start + text.length,
  sourceRange: range(100 + start, 100 + start + text.length)
});

function sample(text = "abc", zeroFont = false) {
  const units = [...text].map((value, index) => unit(value, index));
  const command = {
    kind: "text", id: "paint", formattingNode: "first", documentNode: "first", layoutFragment: "fragment",
    clusters: units.map(({ text: value, contentStartCodeUnit, contentEndCodeUnit, sourceRange }) => ({ text: value, contentStartCodeUnit, contentEndCodeUnit, sourceRange }))
  };
  const span = {
    command: "paint", formattingNode: "first", documentNode: "first", layoutFragment: "fragment",
    contentStartCodeUnit: 0, contentEndCodeUnit: text.length, sourceRange: range(100, 100 + text.length),
    startCodeUnit: 0, endCodeUnit: text.length
  };
  const artifacts = {
    boxTree: {
      root: "first", node: () => ({ id: "first", source: "first", styleNode: "first", pseudo: null, kind: "text-sequence", children: [] }),
      styles: { style: () => ({ visibility: "visible", text: { fontSize: { kind: "length", value: zeroFont ? 0 : 14 } } }) },
      document: { textSourceRange: (_node, start, end) => range(100 + start, 100 + end) }
    },
    inlineItemStreams: { textForFormattingNode: () => ({ units: units.map((entry) => ({ ...entry, kind: "text" })) }) },
    textSearchIndex: { search: () => ({ truncated: false, matches: [{ id: "match", slices: [{ formatting: "first", source: "first", contentStart: 0, contentEnd: text.length }] }] }) },
    documentDisplayList: { commands: [command] }
  };
  return { artifacts, command, span, rows: [{ row: 0, text, spans: [span] }] };
}

test("compatibility requires every painted grapheme, not one surviving highlight", () => {
  const { artifacts, span } = sample();
  const coverage = phrasePaintCoverage(artifacts, [{ row: 0, text: "ab", spans: [{ ...span, contentEndCodeUnit: 2, endCodeUnit: 2, sourceRange: range(100, 102) }] }], ["abc"]);
  assert.deepEqual(coverage.paintedPhrases, []);
  assert.deepEqual(coverage.phrases[0].matches[0].missing.map((entry) => entry.text), ["c"]);
});

test("compatibility combines complete source intervals across viewport windows", () => {
  const { artifacts, span } = sample();
  const rows = [
    { row: 0, text: "ab", spans: [{ ...span, contentEndCodeUnit: 2, endCodeUnit: 2, sourceRange: range(100, 102) }] },
    { row: 120, text: "c", spans: [{ ...span, contentStartCodeUnit: 2, startCodeUnit: 0, endCodeUnit: 1, sourceRange: range(102, 103) }] }
  ];
  assert.deepEqual(phrasePaintCoverage(artifacts, rows, ["abc"]).paintedPhrases, ["abc"]);
  assert.deepEqual(phrasePaintCoverage(artifacts, rows.slice(0, 1), ["abc"]).paintedPhrases, []);
});

test("matching glyphs from another source or occurrence cannot fill coverage gaps", () => {
  const expected = unit("界", 2);
  assert.equal(sourceUnitPainted(expected, [{ ...expected, documentNode: "other" }]), false);
  assert.equal(sourceUnitPainted(expected, [{ ...expected, formattingNode: "other" }]), false);
  assert.equal(sourceUnitPainted(expected, [{ ...expected, sourceRange: range(0, 1) }]), false);
  assert.equal(sourceUnitPainted(expected, [{ ...expected, contentStartCodeUnit: 3 }]), false);
  assert.equal(sourceUnitPainted(expected, [{ ...expected }]), true);
});

test("paint coverage checks actual cell text and ownership rather than trusting intervals", () => {
  const { command, rows, span } = sample();
  assert.equal(paintedSourceUnits(rows, [command]).units.length, 3);
  const wrongText = paintedSourceUnits([{ ...rows[0], text: "axc" }], [command]);
  assert.equal(wrongText.units.length, 0);
  assert.equal(wrongText.malformedSpans[0].reason, "span-text-mismatch");
  const wrongOwner = paintedSourceUnits([{ ...rows[0], spans: [{ ...span, documentNode: "other" }] }], [command]);
  assert.equal(wrongOwner.malformedSpans[0].reason, "span-source-ownership-mismatch");
});

test("zero font suppression is measured separately from missing visible text", () => {
  const { artifacts, rows } = sample("abc", true);
  const absent = phrasePaintCoverage(artifacts, [], []);
  assert.equal(absent.zeroFont.expectedSuppressedGraphemes, 3);
  assert.deepEqual(absent.zeroFont.painted, []);
  assert.equal(phrasePaintCoverage(artifacts, rows, []).zeroFont.painted.length, 3);
});

test("source coverage treats combining sequences and wide emoji as complete graphemes", () => {
  for (const value of ["é", "界", "👍🏽", "👩‍💻"]) {
    const expected = unit(value);
    assert.equal(sourceUnitPainted(expected, [{ ...expected }]), true);
    assert.equal(sourceUnitPainted(expected, [{ ...expected, text: [...value][0] }]), [...value].length === 1);
  }
});

test("RTL mirroring accepts only the Unicode counterpart at an odd embedding level", () => {
  const expected = unit("(");
  assert.equal(sourceUnitPainted(expected, [{ ...expected, text: ")", embeddingLevel: 1 }]), true);
  assert.equal(sourceUnitPainted(expected, [{ ...expected, text: ")", embeddingLevel: 0 }]), false);
  assert.equal(sourceUnitPainted(expected, [{ ...expected, text: "]", embeddingLevel: 1 }]), false);
});
