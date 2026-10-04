import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree, isInlineFormattingNode } from "../../dist/presentation/formatting/index.js";
import { formatCounterNumber, formatListMarker } from "../../dist/presentation/formatting/counter-number.js";
import { compareStyleSnapshots, compileStylesheetProgram, embeddedStylesheetSources,
  implementationSupportsCondition, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/inline-item-stream.js";

const environment = { viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen",
  prefersColorScheme: "dark", reducedMotion: true, hover: "hover", pointer: "fine" };

function fixture(html) {
  const document = parseWebDocument(html, { requestUrl: "https://markers.test/", finalUrl: "https://markers.test/" });
  const state = createDocumentState(document);
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  const styles = resolveStyles({ program, state, environment });
  const formatting = buildFormattingTree({ document, state, styles });
  const style = (id) => styles.style(document.elementById(id));
  const item = (id) => formatting.forSource(document.elementById(id)).find((node) => node.kind === "list-item");
  const marker = (id) => formatting.forSource(document.elementById(id)).find((node) => node.kind === "marker");
  return { document, state, program, styles, formatting, style, item, marker };
}

test("list placement is inherited and shorthand resets both supported longhands", () => {
  const result = fixture(`<main style="list-style:inside square">
    <p id=inherited></p><p id=type style="list-style-type:decimal"></p>
    <p id=position style="list-style-position:outside"></p>
    <p id=shorthand style="list-style:circle"></p>
    <p id=position-only style="list-style:outside"></p>
    <p id=initial style="list-style:initial"></p><p id=unset style="list-style:unset"></p>
    <p id=inherit style="list-style:inherit"></p>
    <p id=ordered style="list-style:outside circle;list-style-position:inside;list-style-type:decimal"></p>
    <p id=reset style="list-style-position:inside;list-style-type:decimal;list-style:none"></p>
    <p id=none-image style="list-style:none inside decimal"></p>
    <p id=two-none style="list-style:none outside none"></p>
  </main><p id=default></p>`);
  for (const [id, type, position] of [
    ["inherited", "square", "inside"], ["type", "decimal", "inside"], ["position", "square", "outside"],
    ["shorthand", "circle", "outside"], ["position-only", "disc", "outside"], ["initial", "disc", "outside"],
    ["unset", "square", "inside"], ["inherit", "square", "inside"], ["ordered", "decimal", "inside"],
    ["reset", "none", "outside"], ["none-image", "decimal", "inside"], ["two-none", "none", "outside"],
    ["default", "disc", "outside"],
  ]) {
    assert.equal(result.style(id).listStyleType, type, `${id} type`);
    assert.equal(result.style(id).listStylePosition, position, `${id} position`);
  }
});

test("unsupported list images and tokens reject the entire declaration without erasing fallback", () => {
  const declarations = ["list-style:inside url(icon.svg) decimal", "list-style:square unknown", "list-style:disc circle",
    "list-style:inside outside", "list-style:none none none", "list-style-type:decimal inside",
    "list-style-position:sideways"];
  const result = fixture(declarations.map((declaration, index) =>
    `<p id=t${index} style="list-style:outside circle;${declaration}"></p>`).join(""));
  for (const [index, declaration] of declarations.entries()) {
    assert.equal(result.style(`t${index}`).listStyleType, "circle", declaration);
    assert.equal(result.style(`t${index}`).listStylePosition, "outside", declaration);
    assert.equal(implementationSupportsCondition(`(${declaration})`), false, declaration);
  }
  for (const declaration of ["list-style:inside", "list-style:outside decimal", "list-style:none inside square",
    "list-style-position:inside", "list-style-type:decimal", "list-style:inherit"]) {
    assert.equal(implementationSupportsCondition(`(${declaration})`), true, declaration);
  }
});

test("list shorthand resolves custom properties, importance, and layer rollback per longhand", () => {
  const result = fixture(`<style>
    @layer base, override;
    @layer base { p {list-style:inside square} }
    @layer override { #rollback {list-style:outside decimal;list-style:revert-layer} }
    #important {list-style:inside square!important;list-style-position:outside}
    #variables {--marker:outside decimal;list-style:var(--marker);list-style-position:inside}
    #invalid {list-style:outside circle;list-style:var(--missing)}
  </style><main style="list-style:inside square"><p id=rollback></p><p id=important></p>
    <p id=variables></p><p id=invalid></p></main>`);
  for (const id of ["rollback", "important", "invalid"]) {
    assert.equal(result.style(id).listStyleType, "square", id);
    assert.equal(result.style(id).listStylePosition, "inside", id);
  }
  assert.equal(result.style("variables").listStyleType, "decimal");
  assert.equal(result.style("variables").listStylePosition, "inside");
});

test("marker placement participates in snapshot equality and logical text dependencies", () => {
  const result = fixture(`<style>li:target{list-style-position:inside}</style><ul><li id=t>Text</li></ul>`);
  const next = resolveStyles({ program: result.program, state: { ...result.state, urlTarget: result.document.elementById("t") }, environment });
  assert.equal(next.style(result.document.elementById("t")).listStylePosition, "inside");
  assert.notEqual(next.logicalTextDependency, result.styles.logicalTextDependency);
  assert.deepEqual(compareStyleSnapshots(result.styles, next), { effectiveChanged: true, reportingChanged: false, backgroundOnly: false });
});

test("UA marker styles materialize for computed list items and disappear with their boxes", () => {
  const result = fixture(`<style>#t:target {display:list-item}</style><p id=t>Text</p>`);
  const source = result.document.elementById("t");
  assert.equal(result.styles.pseudo(source, "marker"), null);
  const selected = resolveStyles({ program: result.program, state: { ...result.state, urlTarget: source }, environment });
  assert.equal(selected.pseudo(source, "marker").text.unicodeBidi, "isolate");
  assert.equal(selected.pseudo(source, "marker").text.whiteSpace, "pre");
  const restored = resolveStyles({ program: result.program, state: result.state, environment });
  assert.equal(restored.pseudo(source, "marker"), null);
});

test("inside markers join the leading anonymous inline run before block children", () => {
  const result = fixture(`<style>li{list-style-position:inside}li::before{content:"before"}</style>
    <ul><li id=t>first<div>block</div>last</li></ul>`);
  const item = result.item("t"), marker = result.marker("t");
  assert.equal(marker.markerPlacement, "inside");
  assert.equal(isInlineFormattingNode(marker), true);
  const firstBlock = result.formatting.children(item.id)[0];
  assert.equal(firstBlock.kind, "anonymous-block");
  const firstInline = result.formatting.children(firstBlock.id)[0];
  assert.equal(firstInline.kind, "anonymous-inline");
  assert.equal(result.formatting.children(firstInline.id)[0], marker);
  assert.equal(result.formatting.children(firstInline.id)[1].pseudo, "before");
});

test("outside markers stay direct first children and own independent text streams", () => {
  const result = fixture(`<style>li::before{content:"before"}</style><ul><li id=t>first<div>block</div>last</li></ul>`);
  const item = result.item("t"), marker = result.marker("t");
  assert.equal(marker.markerPlacement, "outside");
  assert.equal(isInlineFormattingNode(marker), false);
  assert.equal(result.formatting.children(item.id)[0], marker);
  assert.equal(result.formatting.children(item.id)[1].kind, "anonymous-block");
  assert.equal(marker.source, result.document.elementById("t"));
  assert.equal(marker.pseudo, "marker");
  const streams = buildInlineItemStreamSet(result.formatting);
  const markerStream = streams.stream(marker.id, [marker.id]);
  assert.equal([...markerStream.items].map((item) => item.text).join(""), "• ");
  assert.equal([...streams.textForFormattingNode(marker.id).units].map((unit) => unit.text).join(""), "• ");
  for (const stream of streams.streams) {
    if (stream !== markerStream) assert.equal([...stream.items].some((item) => item.formattingNode === marker.id), false);
  }
});

test("UA marker isolation and preserved whitespace apply to custom content without a synthetic suffix", () => {
  const result = fixture(`<style>li{list-style-position:inside}li::marker{content:"M  "}</style><ul><li id=t>text</li></ul>`);
  const marker = result.marker("t");
  const style = result.styles.pseudo(result.document.elementById("t"), "marker");
  assert.equal(style.text.unicodeBidi, "isolate");
  assert.equal(style.text.whiteSpace, "pre");
  assert.equal(marker.whiteSpace, "pre");
  assert.equal(marker.text, "M  ");
  const streams = buildInlineItemStreamSet(result.formatting);
  const stream = streams.stream(result.item("t").id, result.item("t").children);
  assert.deepEqual([...stream.items].filter((item) => item.kind === "structural-bidi-control").map((item) => item.bidiClass), ["LRI", "PDI"]);
  assert.equal([...stream.items].map((item) => item.text).join(""), "M  text");
});

test("outside markers nested in inline list items never enter ancestor text streams", () => {
  const result = fixture(`<p id=p>before<span id=t style="display:inline list-item">item</span>after</p>`);
  const marker = result.marker("t");
  const streams = buildInlineItemStreamSet(result.formatting);
  const markerStream = streams.stream(marker.id, [marker.id]);
  assert.equal([...markerStream.items].map((item) => item.text).join(""), "• ");
  for (const stream of streams.streams) {
    if (stream !== markerStream) assert.equal([...stream.items].some((item) => item.formattingNode === marker.id), false);
  }
});

test("an inside marker before only block content remains a leading inline run", () => {
  const result = fixture(`<ul><li id=t style="list-style-position:inside"><div>block</div></li></ul>`);
  const marker = result.marker("t");
  const children = result.formatting.children(result.item("t").id);
  assert.deepEqual(children.map((node) => node.kind), ["anonymous-block", "block-container"]);
  const inline = result.formatting.children(children[0].id)[0];
  assert.equal(result.formatting.children(inline.id)[0], marker);
});

test("counter representations stay suffix-free while built-in list markers own the full suffix", () => {
  for (const [type, representation, marker] of [
    ["decimal", "3", "3. "], ["decimal-leading-zero", "03", "03. "], ["lower-alpha", "c", "c. "],
    ["upper-alpha", "C", "C. "], ["disc", "•", "• "], ["circle", "◦", "◦ "], ["square", "▪", "▪ "], ["none", "", ""],
  ]) {
    assert.equal(formatCounterNumber(3, type), representation);
    assert.equal(formatListMarker(3, type), marker);
  }
});
