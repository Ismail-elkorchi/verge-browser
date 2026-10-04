import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_VARIANTS, fixtureRequestUrl, mediaEnvironment } from "../../scripts/compat/environment.mjs";
import { compareOracleCase } from "../../scripts/compat/oracle-comparison.mjs";

function observations() {
  const fixture = { id: "controlled", oracle: { styles: [{ id: "box", properties: ["fontSize"] }], geometry: [{ id: "box", properties: ["width"], tolerance: 0.1 }], suppressedText: ["invisible"] } };
  const box = { style: { fontSize: "14px" }, rectangle: { width: 96 } };
  const native = { paintExpectations: ["mixed inline text"], paintedPhrases: ["mixed inline text"], zeroFontPainted: 0, byId: { box: globalThis.structuredClone(box) } };
  const chromium = { meaningfulVisibleText: ["mixed inline text"], byId: { box: globalThis.structuredClone(box) } };
  return { fixture, native, chromium };
}

test("native and Chromium use the same width matrix and HTTP fixture origins", () => {
  assert.deepEqual(DEFAULT_VARIANTS.map((variant) => variant.columns), [40, 80, 120]);
  for (const variant of DEFAULT_VARIANTS) {
    assert.equal(mediaEnvironment(variant).viewportWidthCssPx, variant.columns * 8);
    assert.equal(mediaEnvironment(variant).viewportHeightCssPx, variant.rows * 16);
  }
  assert.equal(fixtureRequestUrl({ id: "sample" }), "https://compat.verge.test/sample/index.html");
  assert.equal(fixtureRequestUrl({ id: "sample", requestUrl: "https://compat.verge.test/custom/index.html" }), "https://compat.verge.test/custom/index.html");
});

test("oracle comparisons pass matching controlled style, geometry, and complete text", () => {
  const { fixture, native, chromium } = observations();
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, []);
});

test("oracle comparisons fail missing native letters even when Chromium has all text", () => {
  const { fixture, native, chromium } = observations();
  native.paintedPhrases = [];
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, [{ kind: "visible-text", target: "mixed inline text", chromium: true, native: false }]);
});

test("oracle comparisons fail computed style and controlled geometry drift", () => {
  const { fixture, native, chromium } = observations();
  native.byId.box.style.fontSize = "16px";
  native.byId.box.rectangle.width = 94;
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures.map((failure) => failure.kind), ["computed-style", "controlled-geometry"]);
});

test("oracle comparisons distinguish intentional zero font suppression", () => {
  const { fixture, native, chromium } = observations();
  native.zeroFontPainted = 1;
  chromium.meaningfulVisibleText.push("invisible");
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures.map((failure) => failure.kind), ["zero-font-visible-in-chromium", "zero-font-visible-in-native"]);
});

test("oracle comparisons reject missing controlled style targets in both engines", () => {
  const { fixture, native, chromium } = observations();
  delete native.byId.box;
  delete chromium.byId.box;
  assert.equal(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures[0].kind, "missing-style-target");
});
