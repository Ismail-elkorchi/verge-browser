import assert from "node:assert/strict";
import test from "node:test";
import { parseComponentValues } from "@ismail-elkorchi/css-parser";
import { applyDocumentAction, createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { formatCounterNumber } from "../../dist/presentation/formatting/counter-number.js";
import { compileStylesheetProgram, embeddedStylesheetSources, implementationSupportsCondition, resolveStyles } from "../../dist/presentation/style/index.js";
import { parseContent, parseCounterOperations } from "../../dist/presentation/style/generated-content.js";
import { buildReaderDocument } from "../../dist/reader/index.js";
import { RenderArtifactStore } from "../../dist/presentation/renderer/index.js";
import { cssCoordinate, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { terminalCellMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

const environment = { viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen",
  prefersColorScheme: "dark", reducedMotion: true, hover: "hover", pointer: "fine" };
function fixture(html, budgets) {
  const document = parseWebDocument(html, { requestUrl: "https://counter.test/", finalUrl: "https://counter.test/" });
  const state = createDocumentState(document);
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  const styles = resolveStyles({ program, state, environment });
  const formatting = buildFormattingTree({ document, state, styles, ...(budgets === undefined ? {} : { budgets }) });
  return { document, state, styles, formatting };
}
function orderedNodes(tree) {
  const result = [], pending = [tree.root];
  while (pending.length) { const node = tree.node(pending.pop()); result.push(node); pending.push(...[...node.children].reverse()); }
  return result;
}
function generated(tree) { return orderedNodes(tree).filter((node) => node.kind === "generated-text").map((node) => node.text); }
function markerTexts(tree) { return orderedNodes(tree).filter((node) => node.kind === "marker").map((node) => node.text); }
const components = (text) => parseComponentValues(text).value;

test("content preserves decoded strings, attr instructions, empty text, none, normal, and semantic alternatives", () => {
  const result = fixture(String.raw`<style>a::before{content:"\5b " attr(data-x) / "Open "}a::after{content:"\5d " / ""}</style><a id=t data-x="★" href=/go>title</a>`);
  assert.deepEqual(generated(result.formatting), ["[★", "]"]);
  assert.equal(result.formatting.semantic(result.document.elementById("t")).accessibleName, "Open title");
  const content = result.styles.pseudo(result.document.elementById("t"), "before").generatedContent;
  assert.deepEqual(content.visual, [{ kind: "text", value: "[" }, { kind: "attr", name: "data-x" }]);
  assert.ok(Object.isFrozen(content) && Object.isFrozen(content.visual) && content.visual.every(Object.isFrozen));
  assert.deepEqual(parseContent(components('""')), { kind: "items", visual: [{ kind: "text", value: "" }], alternative: null });
  assert.deepEqual(parseContent(components("normal")), { kind: "normal" });
  assert.deepEqual(parseContent(components("none")), { kind: "none" });
  for (const unsupported of ['open-quote', 'url(icon.svg)', 'counter(x,custom)', '"x" /', '"x" / "y" / "z"']) {
    assert.equal(parseContent(components(unsupported)), undefined, unsupported);
  }
});

test("generated semantic alternatives preserve ARIA and DOM precedence while CSS-hidden fallback stays absent", () => {
  const { document, formatting } = fixture(`<style>a::before{content:"visual" / "alternative"}a span{display:none}</style>
    <a id=plain href=/p><span>fallback</span></a><a id=aria aria-label="Named" href=/a></a>
    <a id=refs aria-labelledby=label href=/r></a><span id=label>Reference</span>`);
  assert.equal(formatting.semantic(document.elementById("plain")).accessibleName, "alternative");
  assert.equal(formatting.semantic(document.elementById("aria")).accessibleName, "Named");
  assert.equal(formatting.semantic(document.elementById("refs")).accessibleName, "Reference");
  assert.ok(orderedNodes(formatting).filter((node) => "text" in node).every((node) => !node.text.includes("alternative")));
});

test("generated alternatives flow through label associations and ARIA references", () => {
  const { document, formatting } = fixture(`<style>label::before{content:"icon" / "Label "}#name::before{content:"other" / "Reference "}</style>
    <label for=control>text</label><input id=control><span id=name>text</span><a id=link aria-labelledby=name href=/go></a>`);
  assert.equal(formatting.semantic(document.elementById("control")).accessibleName, "Label text");
  assert.equal(formatting.semantic(document.elementById("link")).accessibleName, "Reference text");
});

test("empty and whitespace-only labels preserve associations for generated-only names", () => {
  const { document, formatting } = fixture(`<style>label::before{content:"Name"}</style>
    <label for=explicit></label><input id=explicit><label for=space>  </label><input id=space>
    <label><input id=implicit></label><label> <input id=implicit-space> </label>`);
  for (const id of ["explicit", "space", "implicit", "implicit-space"]) {
    const ref = document.elementById(id);
    assert.ok(document.labels.some((label) => label.target === ref), id);
    assert.equal(formatting.semantic(ref).accessibleName, "Name", id);
  }
});

test("marker visual and alternative content contribute names before before/after content with ARIA precedence", () => {
  const { document, formatting } = fixture(`<style>p{display:list-item}p::marker{content:"★" / "Important "}
    p::before{content:"Before "}p::after{content:" After"}#visual::marker{content:"Text "}</style>
    <p id=alternative role=button>Message</p><p id=visual role=button>Message</p><p id=aria role=button aria-label=Author>Message</p>`);
  assert.equal(formatting.semantic(document.elementById("alternative")).accessibleName, "Important Before Message After");
  assert.equal(formatting.semantic(document.elementById("visual")).accessibleName, "Text Before Message After");
  assert.equal(formatting.semantic(document.elementById("aria")).accessibleName, "Author");
  assert.deepEqual(markerTexts(formatting), ["★", "Text ", "★"]);
});

test("direct ARIA references include visibility-hidden generated labels without naming ordinary hidden pseudos", () => {
  const { document, formatting } = fixture(`<style>#label{visibility:hidden}#label::before{content:"Generated "}
    #ordinary::before{visibility:hidden;content:"Hidden "}</style>
    <span id=label>label</span><a id=reference aria-labelledby=label href=/go></a><a id=ordinary href=/go>Visible</a>`);
  assert.equal(formatting.semantic(document.elementById("reference")).accessibleName, "Generated label");
  assert.equal(formatting.semantic(document.elementById("ordinary")).accessibleName, "Visible");
});

test("nested and sibling resets retain one scoped counter owner in source/pseudo order", () => {
  const { formatting } = fixture(`<style>
    main{counter-reset:x 1}section{counter-reset:x 3}a::before{counter-increment:x;content:counters(x,".")}
    .set{counter-increment:x 2;counter-set:x 8}section::after{counter-increment:x;content:counter(x)}
    </style><main><a></a><section><a></a><a class=set></a></section><a></a><section><a></a></section><a></a></main>`);
  assert.deepEqual(generated(formatting), ["2", "2.4", "2.9", "10", "2.11", "2.4", "5", "2.6"]);
  assert.equal(formatting.outcome.status, "complete");
});

test("absent/none/display-none pseudos and display:contents do not mutate counters; hidden boxes do", () => {
  const { formatting } = fixture(`<style>main{counter-reset:n}i{counter-increment:n}
    .gone{display:none}.contents{display:contents}.hidden{visibility:hidden}
    b::before{counter-increment:n}em::before{content:none;counter-increment:n}
    strong::before{content:"";display:none;counter-increment:n}
    a::before{content:counter(n)}
    </style><main><i class=gone></i><i class=contents><b></b></i><em></em><strong></strong><a></a><i class=hidden></i><a></a></main>`);
  assert.deepEqual(generated(formatting), ["0", "1"]);
});

test("HTML start, reversed, and value feed CSS counters and reader markers without ordinal caches", () => {
  const html = `<ol start=4><li>A<li value=-2>B<li>C<ol reversed><li>D<li>E<li>F</ol><li>G</ol>
    <ol reversed start=9><li>H<li value=3>I<li>J</ol>`;
  const { document, formatting } = fixture(html);
  assert.deepEqual(markerTexts(formatting), ["4.", "-2.", "-1.", "3.", "2.", "1.", "0.", "9.", "3.", "2."]);
  assert.deepEqual(buildReaderDocument(document).blocks.filter((block) => block.kind === "list-item").map((block) => block.marker), markerTexts(formatting));
  const overridden = fixture(`<style>ol{counter-reset:list-item 20}li{counter-increment:list-item 2;counter-set:list-item 7}li::marker{content:counter(list-item)}</style><ol start=4><li value=99>A<li>B</ol>`);
  assert.deepEqual(markerTexts(overridden.formatting), ["7", "7"]);
  const wrappers = fixture(`<style>.contents{display:contents}.hidden{display:none}</style>
    <ol reversed><div class=contents><li>A</li></div><div class=hidden><li>Hidden</li></div><li>B<ol><li>Nested</li></ol></li></ol>`);
  assert.deepEqual(markerTexts(wrappers.formatting), ["2.", "1.", "1."]);
});

test("HTML list defaults yield to CSS none/unset, and hidden items do not consume counters", () => {
  const result = fixture(`<style>.hidden{display:none}.keep{counter-increment:list-item 0}
    .unset{counter-reset:none}.invalid{counter-reset:var(--missing)}</style>
    <ol start=8><li>A<li class=hidden>Hidden<li class=keep>B<li>C</ol>
    <ol reversed><li>D<li hidden>Hidden<li>E</ol>
    <ol start=90 class=unset><li>F</ol><ol start=90 class=invalid><li>G</ol>`);
  assert.deepEqual(markerTexts(result.formatting), ["8.", "8.", "9.", "2.", "1.", "0.", "-1."]);
});

test("empty generated pseudos still execute counters, and marker instructions share the same list-item state", () => {
  const { formatting } = fixture(`<style>ol{counter-reset:n}li::marker{content:counter(list-item) ":" counter(n)}
    li::before{content:"";counter-increment:n}li::after{content:counter(n)}</style><ol><li>A<li>B</ol>`);
  assert.deepEqual(markerTexts(formatting), ["1:0", "2:1"]);
  assert.deepEqual(generated(formatting), ["", "1", "", "2"]);
});

test("counter resets use the last duplicate, increments accumulate, and alpha output crosses z", () => {
  const duplicates = fixture(`<style>main{counter-reset:n 1 n 5}a{counter-increment:n 2 n 3;counter-set:n 9 n 4}
    a::before{counter-increment:n;content:counter(n)}b::before{content:counter(n)}</style><main><a></a><b></b></main>`);
  assert.deepEqual(generated(duplicates.formatting), ["5", "5"]);
  const alphabet = fixture(`<style>main{counter-reset:n}a::before{counter-increment:n;content:counter(n,lower-alpha)}</style><main>${"<a></a>".repeat(28)}</main>`);
  assert.deepEqual(generated(alphabet.formatting), [..."abcdefghijklmnopqrstuvwxyz", "aa", "ab"]);
});

test("number formatting is suffix-free, falls back to decimal outside alpha range, and pads signs correctly", () => {
  assert.deepEqual([-2, -1, 0, 1, 26, 27, 52, 53].map((n) => formatCounterNumber(n, "lower-alpha")), ["-2", "-1", "0", "a", "z", "aa", "az", "ba"]);
  assert.deepEqual([-12, -1, 0, 1, 10].map((n) => formatCounterNumber(n, "decimal-leading-zero")), ["-12", "-1", "00", "01", "10"]);
  assert.equal(formatCounterNumber(27, "upper-alpha"), "AA");
});

test("counter properties and content use parsed value support including vars, layers, and invalid substitution", () => {
  assert.ok(implementationSupportsCondition('(content:counter(x,lower-alpha) / "letter")'));
  assert.ok(implementationSupportsCondition("(counter-set:x -2)"));
  assert.equal(implementationSupportsCondition("(content:open-quote)"), false);
  assert.equal(implementationSupportsCondition("(counter-reset:reversed(x))"), false);
  assert.equal(parseCounterOperations(components("none"), "counter-reset").length, 0);
  const { formatting } = fixture(`<style>@layer base,top;@layer base{main{counter-reset:n 5}a::before{content:counter(n)}}
    @layer top{main{counter-reset:n 9;counter-reset:revert-layer}a::before{--content:counter(n,lower-alpha);content:var(--content)}}
    b::before{content:"old";--bad:open-quote;content:var(--bad)}
    </style><main><a></a><b></b></main>`);
  assert.deepEqual(generated(formatting), ["e"]);
});

test("counter state, work, output, and cancellation terminate bounded formatting construction", () => {
  for (const [budget, limits, html] of [
    ["maxCounterStates", { maxCounterStates: 1 }, '<style>main{counter-reset:a b}</style><main></main>'],
    ["maxCounterOperations", { maxCounterOperations: 2 }, '<style>a::before{counter-increment:x;content:counter(x)}</style><a></a><a></a>'],
    ["maxTextCodeUnits", { maxTextCodeUnits: 5 }, '<style>a::before{content:"123456"}</style><a></a>'],
  ]) {
    const { formatting } = fixture(html, limits);
    assert.equal(formatting.outcome.status, "truncated");
    assert.equal(formatting.outcome.budget, budget);
    assert.ok(orderedNodes(formatting).length === formatting.outcome.nodes);
  }
  const result = fixture('<style>a::before{content:counter(x)}</style><a></a>');
  const controller = new globalThis.AbortController(); controller.abort();
  assert.throws(() => buildFormattingTree({ ...result, signal: controller.signal }), { name: "AbortError" });
  let checks = 0;
  assert.throws(() => buildFormattingTree({ ...result, signal: { throwIfAborted() {
    if (++checks === 8) throw new globalThis.DOMException("Counter construction cancelled", "AbortError");
  } } }), { name: "AbortError" });
  assert.equal(checks, 8);
});

function contexts(columns) {
  const width = cssPx(columns * 8), height = cssPx(640);
  const rect = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), width, height);
  return { documentId: "page", documentRevision: 1,
    mediaEnvironment: { ...environment, viewportWidthCssPx: columns * 8, viewportHeightCssPx: 640 },
    layoutContext: { viewport: { width, height }, initialContainingBlock: rect, scrollport: rect, textMeasurer: terminalCssTextMeasurer() },
    terminalContext: { columns, rows: 40, cellWidthCssPx: cssPx(8), rowHeightCssPx: cssPx(16), unicode: true,
      ambiguousWidth: 1, colorDepth: 24, cellMeasurer: terminalCellMeasurer() } };
}

test("all 21 captured Wikipedia return-link labels retain destinations and text/paint/hit/focus provenance at every target width", () => {
  const groups = [
    ["Cascading_18", ["mwCOg", "mwCOo"]], ["W3C-positioning_22", ["mwCRk", "mwCRs", "mwCR0"]],
    ["chss-proposal_24", ["mwCTM", "mwCTU"]], ["chapter20_25", ["mwCT8", "mwCUE", "mwCUM", "mwCUU", "mwCUc", "mwCUk"]],
    ["WWW3_27", ["mwCWI", "mwCWQ", "mwCWY"]], ["css-phd_28", ["mwCXA", "mwCXI", "mwCXQ"]], ["IEEE_29", ["mwCX4", "mwCYA"]],
  ];
  const expected = groups.flatMap(([name, ids]) => ids.map((id, index) => [id, "abcdef"[index],
    `https://en.wikipedia.org/wiki/Cascading_Style_Sheets#cite_ref-${name}-${index}`]));
  assert.equal(expected.length, 21);
  const html = `<style>.refs{counter-reset:backlink}a::before{counter-increment:backlink;content:counter(backlink,lower-alpha)}a span{display:none}</style>${
    groups.map(([, ids]) => `<p class=refs>${ids.map((id) => {
      const [, label, destination] = expected.find(([candidate]) => candidate === id);
      return `<a id=${id} href="${destination}"><span>${label}</span></a>`;
    }).join(" ")}</p>`).join("")}`;
  const { document, state } = fixture(html);
  for (const columns of [80, 120, 160]) {
    const store = new RenderArtifactStore();
    store.attach({ documentId: "page", documentRevision: 1, stateRevision: 1, document, state, resources: embeddedStylesheetSources(document) });
    const request = contexts(columns), artifacts = store.analyze(request);
    const viewport = store.renderViewport({ ...request, viewportRevision: 1, window: { scrollRow: 0, viewportRows: 40, overscanBefore: 0, overscanAfter: 0 } });
    for (const [id, label, destination] of expected) {
      const ref = document.elementById(id);
      const paint = artifacts.documentDisplayList.commands.filter((command) => command.kind === "text" && command.action?.node === ref);
      assert.equal(paint.map((command) => command.text).join(""), label);
      assert.ok(paint.every((command) => command.action.destination === destination));
      const focus = artifacts.documentGeometry.focusForNode(ref);
      assert.equal(focus.label, label);
      assert.ok(focus.rects.some((rect) => rect.width > 0 && rect.height > 0));
      assert.ok(viewport.terminal.hitTestIndex.regions.some((region) => region.action?.node === ref));
      const generatedNode = artifacts.boxTree.forSource(ref).find((node) => node.kind === "generated-text");
      assert.equal(generatedNode.source, ref); assert.equal(generatedNode.pseudo, "before");
    }
    store.dispose();
  }
});

test("counter state changes invalidate logical text and retained search", () => {
  const { document, state } = fixture(`<style>main{counter-reset:n 1}main:target{counter-reset:n 9}a::before{content:counter(n)}</style><main id=target><a href=/go></a></main>`);
  const store = new RenderArtifactStore();
  store.attach({ documentId: "page", documentRevision: 1, stateRevision: 1, document, state, resources: embeddedStylesheetSources(document) });
  const request = contexts(80), first = store.analyze(request);
  const changed = applyDocumentAction(document, state, { kind: "set-url-target", target: document.elementById("target") });
  store.updateState({ documentId: "page", documentRevision: 1, stateRevision: 2, state: changed, changed: new Set(["target"]) });
  const second = store.analyze(request);
  assert.notEqual(first.boxTree, second.boxTree);
  assert.notEqual(first.computedStyles.logicalTextDependency, second.computedStyles.logicalTextDependency);
  assert.deepEqual(generated(second.boxTree), ["9"]);
  assert.equal(first.textSearchIndex.search("1", 10).matches.length, 1);
  assert.equal(second.textSearchIndex.search("1", 10).matches.length, 0);
  assert.equal(second.textSearchIndex.search("9", 10).matches.length, 1);
  store.dispose();
});
