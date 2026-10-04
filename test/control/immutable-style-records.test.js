import assert from "node:assert/strict";
import test from "node:test";
import { parseWebDocument, createDocumentState } from "../../dist/document/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { freezeComputedStyleRecords, StyleRecordSharing, sameComputedBoxStyle, sameComputedTextStyle, sameComputedTextStyleExceptBackground } from "../../dist/presentation/style/immutable-records.js";
import { createPaintStyleSharing, sameLayoutPaintStyle } from "../../dist/presentation/layout/paint-style.js";

function setup(css = "") {
  const document = parseWebDocument(`<style>${css}</style><main><p id=a>One</p><p id=b>Two</p></main>`, {
    requestUrl: "https://example.test/", finalUrl: "https://example.test/",
  });
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  const styles = resolveStyles({ program, state: createDocumentState(document), environment: {
    viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen", prefersColorScheme: "dark",
    reducedMotion: true, hover: "hover", pointer: "fine",
  } });
  const paragraphs = program.elementNodes.filter((ref) => document.node(ref).name === "p");
  return paragraphs.map((ref) => styles.style(ref));
}

test("computed style transactions share equal immutable records while keeping node styles distinct", () => {
  const [a, b] = setup("p {color: #123456; border: 1px solid red; padding: 2px; font-size: 20px}");
  assert.notEqual(a, b);
  assert.equal(a.box, b.box);
  assert.equal(a.text, b.text);
  assert.equal(a.display, b.display);
  assert.ok(Object.isFrozen(a.box));
  assert.ok(Object.isFrozen(a.text));
  assert.ok(Object.isFrozen(a.box.borderColors));
});

test("freezing preserves trusted inherited subrecords", () => {
  const [a] = setup();
  const copy = freezeComputedStyleRecords({ ...a });
  assert.equal(copy.box, a.box);
  assert.equal(copy.text, a.text);
  assert.equal(copy.display, a.display);
  assert.equal(copy.customProperties, a.customProperties);
});

test("style equality observes all declared text and box fields", () => {
  const [base] = setup();
  const changed = (value) => {
    if (typeof value === "number") return value + 1;
    if (typeof value === "boolean") return !value;
    if (typeof value === "string") return `${value}-different`;
    if (value === null) return { different: true };
    if (Array.isArray(value)) return [...value, { different: true }];
    const key = Object.keys(value)[0];
    return { ...value, [key]: changed(value[key]) };
  };
  for (const field of Object.keys(base.text)) {
    const next = { ...base.text, [field]: changed(base.text[field]) };
    assert.equal(sameComputedTextStyle(base.text, next), false, `text.${field}`);
    assert.equal(sameComputedTextStyleExceptBackground(base.text, next), field === "background", `except background: ${field}`);
  }
  for (const field of Object.keys(base.box)) {
    const next = { ...base.box, [field]: changed(base.box[field]) };
    assert.equal(sameComputedBoxStyle(base.box, next), false, `box.${field}`);
  }
});

test("sharing preserves independent grid, clipping, viewport and inherited values", () => {
  for (const css of [
    "#a {width:20vw} #b {width:30vw}",
    "p {display:grid} #a {grid-template-columns: 1fr 2fr} #b {grid-template-columns: 2fr 1fr}",
    "#a {clip-path: inset(2px)} #b {clip-path: inset(3px)}",
    "#a {--x: red; color:var(--x)} #b {--x:blue; color:var(--x)}",
    "#a {border:1px solid red} #b {border:1px solid blue}",
  ]) {
    const [a, b] = setup(css);
    assert.ok(!sameComputedBoxStyle(a.box, b.box) || !sameComputedTextStyle(a.text, b.text), css);
  }
});

test("record lookup is construction-owned and seeds only supplied surviving records", () => {
  const [style] = setup();
  const first = new StyleRecordSharing();
  first.seed(style);
  const candidate = freezeComputedStyleRecords({ ...style, text: { ...style.text }, box: { ...style.box } });
  assert.equal(first.share(candidate).box, style.box);
  const second = new StyleRecordSharing();
  assert.equal(second.share(candidate), candidate);
});

test("paint records share complete values without hiding a changed border or background", () => {
  const paint = Object.freeze({ visible: true, foreground: {r:1,g:2,b:3,a:1}, background: null,
    bold: false, italic: false, underline: false, strikethrough: false,
    borderColors: {top:null,right:null,bottom:null,left:null},
    borderStyles: {top:"none",right:"none",bottom:"none",left:"none"},
  });
  const sharing = createPaintStyleSharing();
  assert.equal(sharing.share(paint), paint);
  assert.equal(sharing.share({...paint, foreground:{...paint.foreground}}), paint);
  assert.equal(sameLayoutPaintStyle(paint, {...paint, background:{r:0,g:0,b:0,a:1}}), false);
  assert.equal(sameLayoutPaintStyle(paint, {...paint, borderStyles:{...paint.borderStyles,left:"solid"}}), false);
});
