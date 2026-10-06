import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, implementationSupportsCondition, resolveStyles } from "../../dist/presentation/style/index.js";

function stylesFor(html) {
  const document = parseWebDocument(html, { requestUrl: "https://example.test/", finalUrl: "https://example.test/" });
  const styles = resolveStyles({ program: compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) }),
    state: createDocumentState(document), environment: { viewportWidthCssPx: 800, viewportHeightCssPx: 600,
      mediaType: "screen", prefersColorScheme: "light", reducedMotion: false, hover: "hover", pointer: "fine" } });
  return { styles, get: (id) => styles.style(document.elementById(id)) };
}

test("endpoint opacity is non-inherited while explicit inheritance and clamping are retained", () => {
  const { get } = stylesFor(`<div id="parent" style="opacity:0"><span id="child">text</span>
    <span id="inherit" style="opacity:inherit">inherited</span><span id="unset" style="opacity:unset">reset</span></div>
    <span id="low" style="opacity:-1"></span><span id="high" style="opacity:200%"></span>`);
  assert.equal(get("parent").opacity, 0);
  assert.equal(get("child").opacity, 1);
  assert.equal(get("inherit").opacity, 0);
  assert.equal(get("unset").opacity, 1);
  assert.equal(get("low").opacity, 0);
  assert.equal(get("high").opacity, 1);
});

test("partial group opacity remains explicit unsupported native-text presentation", () => {
  const { styles, get } = stylesFor('<p id="partial" style="opacity:.5">text</p>');
  assert.equal(get("partial").opacity, 1);
  assert.ok(styles.diagnostics.some((entry) => entry.code === "value-unsupported" && entry.detail.includes("opacity")));
  assert.equal(implementationSupportsCondition("(opacity: 0)"), true);
  assert.equal(implementationSupportsCondition("(opacity: 100%)"), true);
  assert.equal(implementationSupportsCondition("(opacity: .5)"), false);
});

test("superscript and subscript defaults use the normal cascade", () => {
  const { get } = stylesFor('<p><sup id="sup">1</sup><sub id="sub">2</sub><sup id="author" style="vertical-align:baseline;font-size:16px">3</sup></p>');
  assert.deepEqual(get("sup").text.verticalAlign, { kind: "keyword", value: "super" });
  assert.deepEqual(get("sub").text.verticalAlign, { kind: "keyword", value: "sub" });
  assert.deepEqual(get("author").text.verticalAlign, { kind: "keyword", value: "baseline" });
  assert.ok(get("sup").text.fontSize.value < get("author").text.fontSize.value);
});
