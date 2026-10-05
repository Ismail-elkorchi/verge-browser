import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { buildLayoutFragmentTree, cssCoordinate, cssMultiply, cssPixels, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, implementationSupportsCondition, resolveStyles } from "../../dist/presentation/style/index.js";
import { evaluateCssMath, parseCssLength } from "../../dist/presentation/style/css-values.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";

const environment = Object.freeze({ viewportWidthCssPx: 800, viewportHeightCssPx: 600,
  mediaType: "screen", prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine" });
const px = (value) => ({ kind: "length", value, unit: "px" });

function setup(css, body = '<main><div id="target">Text</div></main>') {
  const document = parseWebDocument(`<!doctype html><style>html,body{margin:0}${css}</style>${body}`, {
    requestUrl: "https://ex.example/", finalUrl: "https://ex.example/",
  });
  const state = createDocumentState(document);
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  const styles = resolveStyles({ program, state, environment });
  return { document, state, styles, style: (id = "target") => styles.style(document.elementById(id)) };
}

// Keep the x-height distinct from both 0.5em and the zero glyph's advance so
// used-length tests cannot pass through the computed fallback or ch dispatch.
function fontMetrics(fontSize) {
  return Object.freeze({ fontSize, ascent: cssMultiply(fontSize, 0.75), descent: cssMultiply(fontSize, 0.25),
    baseline: cssMultiply(fontSize, 0.75), lineGap: cssPx(0), xHeight: cssMultiply(fontSize, 0.25),
    chAdvance: cssMultiply(fontSize, 0.75) });
}
const measurer = {
  measure: (text, fontSize) => cssMultiply(fontSize, text.length / 2),
  fontMetrics,
  defaultFontMetrics: () => fontMetrics(cssPx(16)),
};

function render(css, body) {
  const result = setup(css, body);
  const formatting = buildFormattingTree(result);
  const width = cssPx(environment.viewportWidthCssPx);
  const height = cssPx(environment.viewportHeightCssPx);
  const viewport = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), width, height);
  const layout = buildLayoutFragmentTree({ formatting, inlineItemStreams: buildInlineItemStreamSet(formatting),
    context: { viewport: { width, height }, initialContainingBlock: viewport, scrollport: viewport, textMeasurer: measurer } });
  assert.equal(layout.outcome.status, "complete");
  return { ...result, layout, fragment(id = "target") {
    const fragment = layout.forDocumentNode(result.document.elementById(id)).find((entry) => entry.kind !== "text");
    assert.ok(fragment, `missing fragment for #${id}`);
    return fragment;
  } };
}

function computedLength(value) {
  const parsed = parseCssLength(value, { allowAuto: false });
  assert.ok(parsed);
  const expression = parsed.kind === "calculation" ? parsed.calculation.expression
    : { kind: "value", value: parsed.value, unit: parsed.unit };
  return evaluateCssMath(expression, 200, 20, 30, 800, 600);
}

test("ex scalar parsing normalizes units and follows property-specific negative restrictions", () => {
  for (const value of ["2ex", "2EX", String.raw`2e\78`]) {
    assert.deepEqual(parseCssLength(value), { kind: "length", value: 2, unit: "ex" }, value);
  }
  assert.deepEqual(parseCssLength("0ex"), { kind: "length", value: 0, unit: "ex" });
  assert.equal(parseCssLength("-2ex"), null);
  assert.deepEqual(parseCssLength("-2ex", { allowNegative: true }), { kind: "length", value: -2, unit: "ex" });
  for (const property of ["width", "height", "padding", "font-size", "line-height"]) {
    assert.equal(implementationSupportsCondition(`(${property}:2ex)`), true, property);
    assert.equal(implementationSupportsCondition(`(${property}:-2ex)`), false, property);
    assert.equal(implementationSupportsCondition(`(${property}:0ex)`), true, property);
  }
  assert.equal(implementationSupportsCondition("(margin:-2ex)"), true);
  assert.equal(parseCssLength("2rex"), null);
});

test("computed scalar and CSS math ex use the same 0.5em fallback", () => {
  for (const [value, expected] of [
    ["2ex", 20], ["calc(2ex + 3px)", 23], ["min(3ex, 20px)", 20],
    ["max(1ex, 20px)", 20], ["clamp(1ex, 50px, 4ex)", 40],
    ["calc(1ex + 1ch + 1em + 1rem + 1vw + 1vh + 1% + 1px)", 87],
    ["calc(2ex * 3 / 2 - 1ex)", 20],
  ]) assert.equal(computedLength(value), expected, value);
});

test("font size and line-height resolve ex for longhands, shorthand and inherited computed values", () => {
  for (const [value, expected] of [
    ["2ex", 20], ["calc(2ex + 4px)", 24], ["min(3ex, 25px)", 25],
    ["max(1ex, 25px)", 25], ["clamp(1ex, 50px, 4ex)", 40],
  ]) {
    const result = setup(`main{font-size:20px}#target{font-size:${value};line-height:3ex}`);
    assert.deepEqual(result.style().text.fontSize, px(expected), value);
    assert.deepEqual(result.style().text.lineHeight, { kind: "length", value: px(expected * 1.5) }, value);
  }
  assert.deepEqual(setup("main{font-size:20px}#target{font:2ex/3ex serif}").style().text.lineHeight,
    { kind: "length", value: px(30) });
  for (const [value, expected] of [["calc(2ex + 4px)", 24], ["min(3ex, 25px)", 25],
    ["max(1ex, 25px)", 25], ["clamp(1ex, 50px, 4ex)", 40]]) {
    assert.deepEqual(setup(`#target{font-size:20px;line-height:${value}}`).style().text.lineHeight,
      { kind: "length", value: px(expected) }, value);
  }
  const inherited = setup("html{font-size:2ex}main{font-size:20px;line-height:3ex}#child{font-size:1ex}",
    '<main><div id="target"><span id="child">Text</span></div></main>');
  assert.deepEqual(inherited.styles.style(inherited.document.documentElement).text.fontSize, px(16));
  assert.deepEqual(inherited.style().text.fontSize, px(20));
  assert.deepEqual(inherited.style("child").text.fontSize, px(10));
  assert.deepEqual(inherited.style("child").text.lineHeight, { kind: "length", value: px(30) });
  for (const value of ["inherit", "unset"]) {
    assert.deepEqual(setup(`main{font-size:24px}#target{font-size:${value}}`).style().text.fontSize, px(24));
  }
});

test("font and line-height math clamp negative results while negative ex literals are discarded", () => {
  // https://www.w3.org/TR/css-values-4/#calc-range
  for (const value of ["0ex", "calc(1ex - 2ex)", "min(-1ex, 1px)", "max(-2ex, -1px)", "clamp(-3ex, -2ex, -1ex)"]) {
    const result = setup(`#target{font-size:${value};line-height:4ex}`);
    assert.deepEqual(result.style().text.fontSize, px(0), value);
    assert.deepEqual(result.style().text.lineHeight, { kind: "length", value: px(0) }, value);
    assert.deepEqual(setup(`#target{line-height:${value}}`).style().text.lineHeight,
      { kind: "length", value: px(0) }, value);
  }
  const literal = setup("#target{font-size:22px;font-size:-1ex;line-height:30px;line-height:-1ex;padding:4px;padding:-1ex}");
  assert.deepEqual(literal.style().text.fontSize, px(22));
  assert.deepEqual(literal.style().text.lineHeight, { kind: "length", value: px(30) });
  assert.deepEqual(literal.style().box.padding.left, px(4));
});

test("used scalar and CSS math ex resolve actual x-height independently of ch advance", () => {
  for (const [value, expected] of [
    ["2ex", 10], ["calc(2ex + 1ch)", 25], ["min(4ex, 2ch)", 20],
    ["max(2ex, 1ch)", 15], ["clamp(1ex, 4ch, 5ex)", 25],
  ]) {
    const result = render(`#target{font-size:20px;width:${value};height:2ex}`);
    const fragment = result.fragment();
    assert.equal(cssPixels(fragment.contentRect.width), expected, value);
    assert.equal(cssPixels(fragment.contentRect.height), 10, value);
  }
});

test("media queries resolve ex with initial-font fallback independently of authored fonts", () => {
  const result = setup("html{font-size:40px}@media (min-width:100ex){#target{padding:2px}}@media (min-width:calc(100ex + 1px)){#target{padding:4px}}");
  assert.deepEqual(result.style().box.padding.left, px(2));
});

test("ex padding and signed margins share used metrics and preserve scalar/math range handling", () => {
  for (const padding of ["1ex 2ex", "min(1ex, 1ch) calc(1ex + 1ex)"]) {
    const result = render(`#target{font-size:20px;width:40px;height:20px;padding:${padding};margin:0 1ex 0 -1ex}`);
    const fragment = result.fragment();
    assert.equal(cssPixels(fragment.borderRect.width), 60, padding);
    assert.equal(cssPixels(fragment.borderRect.height), 30, padding);
    assert.equal(cssPixels(fragment.borderRect.x), -5, padding);
    assert.equal(cssPixels(fragment.contentRect.x), 5, padding);
    assert.equal(cssPixels(fragment.contentRect.y), 5, padding);
  }
  const negative = render("#target{font-size:20px;width:40px;height:20px;padding:calc(1ex - 2ex);margin-left:calc(-2ex + 1ex)}");
  assert.equal(cssPixels(negative.fragment().borderRect.width), 40);
  assert.equal(cssPixels(negative.fragment().contentRect.x), -5);
});

test("inherited font sizes select ex metrics at each used size, including zero", () => {
  const result = render("main{font-size:20px}#target,#child,#zero{width:2ex;height:2ex;padding:1ex}#child{font-size:40px}#zero{font-size:0ex}",
    '<main><div id="target"></div><div id="child"></div><div id="zero"></div></main>');
  for (const [id, expected] of [["target", 10], ["child", 20], ["zero", 0]]) {
    assert.equal(cssPixels(result.fragment(id).contentRect.width), expected, id);
    assert.equal(cssPixels(result.fragment(id).borderRect.width), expected * 2, id);
  }
  const computed = render("#target{font-size:2ex;line-height:3ex;width:2ex}");
  assert.deepEqual(computed.style().text.fontSize, px(16));
  assert.deepEqual(computed.style().text.lineHeight, { kind: "length", value: px(24) });
  assert.equal(cssPixels(computed.fragment().contentRect.width), 8);
  assert.equal(cssPixels(computed.fragment().contentRect.height), 24);
});
