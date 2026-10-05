import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalTextIndex, measureTextCells } from "@ismail-elkorchi/terminal-ui/text";
import { createBrowserTextPresentation } from "../../dist/ui/text-presentation.js";

const widthProfile = { emoji: "wide", ambiguous: "narrow" };

for (const [logical, visual] of [
  ["ordinary ASCII (123)", "ordinary ASCII (123)"],
  ["مرحبا", "ابحرم"],
  ["مرحبا 123", "123 ابحرم"],
  ["مرحبا 👩‍💻", "👩‍💻 ابحرم"],
]) {
  test(`browser text presentation preserves source boundaries for ${JSON.stringify(logical)}`, () => {
    const index = createTerminalTextIndex(logical, { widthProfile, textPresentation: createBrowserTextPresentation() });
    assert.equal(index.visualGraphemes.map((cluster) => cluster.text).join(""), visual);
    assert.equal(index.visualGraphemes.length, index.graphemes.length);
    assert.deepEqual(index.visualGraphemes.map((cluster) => [cluster.startOffset, cluster.endOffsetExclusive]).sort((a, b) => a[0] - b[0]),
      index.graphemes.map((cluster) => [cluster.startOffset, cluster.endOffsetExclusive]));
    assert.equal(index.selectedText({ startOffset: 0, endOffsetExclusive: logical.length }), logical);
    for (const cluster of index.visualGraphemes) {
      const position = index.visualColumnToPosition(cluster.column);
      assert.equal(index.positionToVisualColumn(position), cluster.column);
    }
  });
}

test("wrapped terminal ranges retain full paragraph direction and exact supplied clusters", () => {
  const text = "مرحبا (123)";
  const startOffset = 6;
  const endOffsetExclusive = text.length;
  const graphemes = measureTextCells(text.slice(startOffset), { widthProfile }).graphemes.map((cluster) => ({
    ...cluster, startOffset: cluster.startOffset + startOffset, endOffsetExclusive: cluster.endOffsetExclusive + startOffset,
  }));
  const mapped = createBrowserTextPresentation().map({ text, startOffset, endOffsetExclusive, widthProfile, graphemes });
  assert.equal(mapped.map((cluster) => cluster.text).join(""), "(123)");
  assert.equal(mapped[0].startOffset, 10);
  assert.equal(mapped.at(-1).startOffset, 6);
  assert.equal(mapped[0].direction, "rtl");
});

test("formatting controls keep a source bijection without changing the visible permutation", () => {
  const text = "\u202eabc\u202c";
  const index = createTerminalTextIndex(text, { widthProfile, textPresentation: createBrowserTextPresentation() });
  assert.equal(index.visualGraphemes.map((cluster) => cluster.text).join("").replace(/[\u202a-\u202e]/gu, ""), "cba");
  assert.deepEqual(index.visualGraphemes.map((cluster) => cluster.startOffset).sort((a, b) => a - b),
    index.graphemes.map((cluster) => cluster.startOffset));
});

test("paragraph reuse never leaks a previous source permutation", () => {
  const textPresentation = createBrowserTextPresentation();
  for (let index = 0; index < 40; index++) {
    const text = `مرحبا ${index}`;
    const retained = createTerminalTextIndex(text, { widthProfile, textPresentation });
    assert.equal(retained.visualGraphemes.map((cluster) => cluster.text).join(""), `${index} ابحرم`);
  }
});

test("bidi mirroring preserves every asymmetric glyph allocation under both ambiguous-width profiles", () => {
  const textPresentation = createBrowserTextPresentation();
  const asymmetricPairs = [
    [0x2215, 0x29f5], [0x221f, 0x2bfe], [0x2220, 0x29a3],
    [0x2245, 0x224c], [0x2252, 0x2253],
  ];
  for (const pair of asymmetricPairs) {
    for (const [sourceCodePoint, mirroredCodePoint] of [pair, [...pair].reverse()]) {
      const source = String.fromCodePoint(sourceCodePoint);
      const mirrored = String.fromCodePoint(mirroredCodePoint);
      const logical = `א${source}`;
      for (const ambiguous of ["narrow", "wide", "narrow"]) {
        const profile = { emoji: "wide", ambiguous };
        const index = createTerminalTextIndex(logical, { widthProfile: profile, textPresentation });
        const visual = index.visualGraphemes;
        const expectedGlyph = ambiguous === "wide" ? source : mirrored;
        assert.equal(visual.map((cluster) => cluster.text).join(""), `${expectedGlyph}א`,
          `U+${sourceCodePoint.toString(16)} with ${ambiguous} ambiguous width`);
        assert.deepEqual(visual.map((cluster) => [cluster.startOffset, cluster.endOffsetExclusive]), [[1, 2], [0, 1]]);
        assert.equal(visual[0].direction, "rtl");
        assert.equal(visual[0].cells, measureTextCells(source, { widthProfile: profile }).cells);
        assert.equal(index.selectedText({ startOffset: 0, endOffsetExclusive: logical.length }), logical);
      }
    }
  }
});

test("width-preserving bracket mirrors still substitute their glyphs", () => {
  const textPresentation = createBrowserTextPresentation();
  for (const [source, mirrored] of [["(", ")"], [")", "("], ["[", "]"], ["]", "["], ["{", "}"], ["}", "{"]]) {
    for (const ambiguous of ["narrow", "wide"]) {
      const index = createTerminalTextIndex(`א${source}`, {
        widthProfile: { emoji: "wide", ambiguous }, textPresentation,
      });
      assert.equal(index.visualGraphemes.map((cluster) => cluster.text).join(""), `${mirrored}א`);
      assert.equal(index.visualGraphemes[0].cells, 1);
      assert.equal(index.visualGraphemes[0].direction, "rtl");
    }
  }
});
