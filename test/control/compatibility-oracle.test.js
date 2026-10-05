import assert from "node:assert/strict";
import test from "node:test";
import { parseWebDocument } from "../../dist/document/index.js";
import { nativeFormObservations, chromiumAccessibleNames } from "../../scripts/compat/form-observations.mjs";

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

test("relative oracle geometry compares owned edges without equating text or ex metrics", () => {
  const { fixture, native, chromium } = observations();
  fixture.oracle.geometry[0].referenceId = "reference";
  native.byId.reference = { rectangle: { width: 68 } };
  chromium.byId.box.rectangle.width = 104;
  chromium.byId.reference = { rectangle: { width: 76 } };
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, []);
  native.byId.box.rectangle.width += 8;
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, [
    { kind: "controlled-geometry", target: "box.width - reference.width", expected: 28, actual: 36 },
  ]);
  // Equivalent expressions can agree within each engine even when the
  // terminal fallback and browser x-height produce different absolute sizes.
  native.byId.box.rectangle.width = native.byId.reference.rectangle.width;
  chromium.byId.box.rectangle.width = chromium.byId.reference.rectangle.width;
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, []);
});

test("relative oracle geometry rejects missing and nonfinite reference measurements", () => {
  const { fixture, native, chromium } = observations();
  fixture.oracle.geometry[0].referenceId = "reference";
  for (const width of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    native.byId.reference = { rectangle: { width } };
    chromium.byId.reference = { rectangle: { width } };
    assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, [
      { kind: "controlled-geometry", target: "box.width - reference.width", expected: null, actual: null },
    ]);
  }
  delete native.byId.reference;
  delete chromium.byId.reference;
  assert.equal(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures[0].kind, "controlled-geometry");
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

test("form oracle preserves hidden controls and stable positions despite duplicate HTML IDs", () => {
  const document = parseWebDocument(`<div id="duplicate"></div><form id="duplicate"><input id="duplicate" type="hidden" name="hidden" value="secret"><input form="duplicate" name="not-owned"></form>`, {
    requestUrl: "https://example.test", finalUrl: "https://example.test",
  });
  const observed = nativeFormObservations(document);
  assert.equal(observed.controls.length, 2);
  assert.equal(observed.controls[0].inputType, "hidden");
  assert.equal(new Set(observed.controls.map((control) => control.key)).size, 2);
  assert.equal(observed.controls[0].form, observed.forms[0].key);
  assert.equal(observed.controls[1].form, null);
  assert.deepEqual(observed.forms[0].entries, { status: "complete", entries: [{ name: "hidden", value: "secret" }] });
});

test("form comparisons reject owner, selectedness and entry-order drift", () => {
  const { fixture, native, chromium } = observations();
  fixture.oracle.formSemantics = true;
  const formSemantics = { controls: [{ key: "element:5", form: "element:3", value: "a", options: [{ key: "element:6", selected: true }] }],
    forms: [{ key: "element:3", entries: { status: "complete", entries: [{ name: "same", value: "a" }, { name: "same", value: "b" }] }, submitters: [] }] };
  chromium.formSemantics = globalThis.structuredClone(formSemantics);
  native.formSemantics = globalThis.structuredClone(formSemantics);
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, []);
  native.formSemantics.controls[0].form = null;
  native.formSemantics.controls[0].options[0].selected = false;
  native.formSemantics.forms[0].entries.entries.reverse();
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures.map((failure) => failure.kind), ["form-control-state", "form-entry-list"]);
});

test("accessible-name comparisons require real CDP observations and detect name mismatches", () => {
  const { fixture, native, chromium } = observations();
  fixture.oracle.accessibleNames = true;
  native.formSemantics = { nameTargets: [{ key: "element:5", name: "Image action" }] };
  chromium.formSemantics = { nameTargets: ["element:5"] };
  chromium.accessibleNames = { status: "unavailable", reason: "CDP unavailable" };
  assert.equal(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures[0].kind, "accessible-name-oracle-unavailable");
  chromium.accessibleNames = { status: "complete", byKey: { "element:5": { name: "Different", ignored: false } } };
  assert.equal(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures[0].kind, "accessible-name");
  chromium.accessibleNames.byKey["element:5"].name = "Image action";
  assert.deepEqual(compareOracleCase(fixture, DEFAULT_VARIANTS[0], native, chromium).failures, []);
});

test("CDP name collection maps backend IDs to document positions without deriving names from DOM text", async () => {
  let detached = false;
  const session = {
    async send(method) {
      if (method === "Accessibility.enable") return {};
      if (method === "DOM.getDocument") return { root: { nodeType: 9, children: [{ nodeType: 1, backendNodeId: 10,
        children: [{ nodeType: 1, backendNodeId: 20, children: [{ nodeType: 3, backendNodeId: 30, nodeValue: "Wrong DOM name" }] }] }] } };
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ backendDOMNodeId: 20, role: { value: "button" }, name: { value: "Native AX name" }, ignored: false }] };
      throw new Error(`Unexpected CDP method ${method}`);
    },
    async detach() { detached = true; },
  };
  const observed = await chromiumAccessibleNames({ async newCDPSession() { return session; } }, {}, ["element:1"]);
  assert.deepEqual(observed, { status: "complete", byKey: { "element:1": { role: "button", name: "Native AX name", ignored: false } } });
  assert.equal(detached, true);
});
