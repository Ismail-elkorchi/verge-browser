import assert from "node:assert/strict";
import test from "node:test";

import { applyDocumentAction, createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles, terminalMediaMayApply } from "../../dist/presentation/style/index.js";
import { parseLegacyColor } from "../../dist/presentation/style/presentational-hints.js";
import { namedColor } from "../../dist/presentation/style/named-colors.js";

const environment = Object.freeze({ viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen",
  prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine" });
const red = { r: 255, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 255, a: 1 };
const green = { r: 0, g: 128, b: 0, a: 1 };
const px = (value) => ({ kind: "length", value, unit: "px" });

function setup(html, options = {}) {
  const document = parseWebDocument(`<!doctype html>${html}`, { requestUrl: "https://style.test/", finalUrl: "https://style.test/" });
  const state = createDocumentState(document);
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document), ...options });
  const resolve = (nextState = state, nextEnvironment = environment, budgets) => resolveStyles({
    program, state: nextState, environment: nextEnvironment, ...(budgets === undefined ? {} : { budgets }),
  });
  const styles = resolve();
  return { document, program, state, resolve, styles, style: (id = "t") => styles.style(document.elementById(id)) };
}

for (const important of ["", "!important"]) {
  test(`static invalid declarations are discarded before cascade (${important || "normal"})`, () => {
    for (const declarations of [`color:red; color:no-such-color ${important}`, `color:red ${important};color:blue !invalid`]) {
      for (const html of [`<style>#t{${declarations}}</style><p id=t>x</p>`, `<p id=t style="${declarations}">x</p>`]) {
        assert.deepEqual(setup(html).style().text.color, red);
      }
    }
    const style = setup(`<style>#t{margin-left:7px; margin:bogus ${important}; padding:4px; padding-left:bogus ${important}}</style><p id=t>x</p>`).style();
    assert.deepEqual(style.box.margin.left, px(7));
    assert.deepEqual(style.box.padding.left, px(4));
  });
}

test("variable invalidation happens after selection and does not reveal an earlier declaration", () => {
  for (const value of ["var(--missing)", "var(--invalid)"]) {
    const style = setup(`<style>body{color:green}#t{--invalid:no-such-color;color:red;color:${value};margin-left:7px;margin:var(--missing)}</style><p id=t>x</p>`).style();
    assert.deepEqual(style.text.color, green);
    assert.deepEqual(style.box.margin.left, { kind: "zero" });
  }
});

test("custom-property component lookup preserves case, inheritance, cycles, fallback and rollback", () => {
  const result = setup(`<style>
    body{--Tone:red;--tone:blue;--shared:green}
    #t{color:var(--Tone);background:var(--tone);--a:var(--b);--b:var(--a);border-color:var(--a,green)}
    #child{--Tone:initial;--tone:inherit;--shared:unset;color:var(--Tone,var(--shared));background:var(--tone)}
    @layer base, theme;
    @layer base{#rollback{--x:red}}
    @layer theme{#rollback{--x:blue;--x:revert-layer}}
    #rollback{color:var(--x);--shared:red;--shared:revert;background:var(--shared)}
  </style><p id=t><span id=child>x</span></p><p id=rollback>x</p>`);
  assert.deepEqual(result.style().text.color, red);
  assert.deepEqual(result.style().text.background, blue);
  assert.deepEqual(result.style().box.borderColors.top, green);
  assert.equal(result.style().customProperties.has("--a"), false);
  assert.deepEqual(result.style("child").text.color, green);
  assert.deepEqual(result.style("child").text.background, blue);
  assert.deepEqual(result.style("rollback").text.color, red);
  assert.deepEqual(result.style("rollback").text.background, green);
});

test("namespace bindings are declared, case-sensitive and confined to each stylesheet", () => {
  const result = setup(`<style>@namespace x url(http://www.w3.org/1999/xhtml);x|p{color:red}</style>
    <style>@namespace x "http://www.w3.org/2000/svg";x|p{color:blue}</style>
    <style>X|p{color:green}html|p{background:red}</style><p id=t>x</p>`);
  assert.deepEqual(result.style().text.color, red);
  assert.equal(result.style().text.background, null);
  const defaults = setup(`<style>@namespace "http://www.w3.org/2000/svg";p{color:red}*|p{background:blue}</style><p id=t>x</p>`);
  assert.equal(defaults.style().text.color, null);
  assert.deepEqual(defaults.style().text.background, blue);
  const rebound = setup(`<style>@namespace x "http://www.w3.org/2000/svg";@namespace x "http://www.w3.org/1999/xhtml";x|p{color:red}</style><p id=t>x</p>`);
  assert.deepEqual(rebound.style().text.color, red);
});

test("namespace validation rejects ordinary lists and prunes forgiving branches before specificity", () => {
  for (const selector of ["html|p,#t", ":not(html|p),#t", ":has(html|p),#t"]) {
    assert.equal(setup(`<style>${selector}{color:red}</style><p id=t>x</p>`).style().text.color, null);
  }
  const result = setup(`<style>:is(x|p#extra,#t){color:red}#t{color:blue}</style><p id=t>x</p>`);
  assert.deepEqual(result.style().text.color, blue);
  const attributes = setup(`<style>@namespace x "http://www.w3.org/1999/xlink";[x|href]{color:red}[href]{background:blue}</style><svg><a id=t xlink:href="/x">x</a></svg>`);
  assert.deepEqual(attributes.style().text.color, red);
  assert.equal(attributes.style().text.background, null);
});

test("namespace imports do not inherit the parent stylesheet namespace", () => {
  const result = setup(`<style>@namespace x "http://www.w3.org/1999/xhtml";x|p{color:red}</style><style>x|p{background:blue}</style><p id=t>x</p>`);
  const resources = embeddedStylesheetSources(result.document).map((resource, index) => index === 0 ? resource : {
    ...resource, sourceKind: "imported", rootOrder: 0, dependencyOrder: -1, importDepth: 1, importedFrom: "https://style.test/parent.css",
  });
  const program = compileStylesheetProgram({ document: result.document, resources });
  const styles = resolveStyles({ program, state: result.state, environment });
  const style = styles.style(result.document.elementById("t"));
  assert.deepEqual(style.text.color, red);
  assert.equal(style.text.background, null);
});

test("class tokenization uses ASCII whitespace, not Unicode whitespace", () => {
  assert.equal(setup('<style>.a{color:red}</style><p id=t class="a\u00a0b">x</p>').style().text.color, null);
  for (const space of [" ", "\t", "\n", "\r", "\f"]) assert.deepEqual(setup(`<style>.a{color:red}</style><p id=t class="a${space}b">x</p>`).style().text.color, red);
});

test("checked content attributes remain independent of interactive checked state", () => {
  const result = setup('<style>[checked]{color:red}:checked{background:blue}</style><input id=t type=checkbox checked><input id=other type=checkbox>');
  const unchecked = applyDocumentAction(result.document, result.state, { kind: "set-checked", target: result.document.elementById("t"), checked: false });
  const checked = applyDocumentAction(result.document, unchecked, { kind: "set-checked", target: result.document.elementById("other"), checked: true });
  const styles = result.resolve(checked);
  assert.deepEqual(styles.style(result.document.elementById("t")).text.color, red);
  assert.equal(styles.style(result.document.elementById("t")).text.background, null);
  assert.equal(styles.style(result.document.elementById("other")).text.color, null);
  assert.deepEqual(styles.style(result.document.elementById("other")).text.background, blue);
});

const mediaCases = [
  ["(min-width:900px) or (max-width:1000px)", true],
  ["not ((min-width:900px) and (max-width:1000px))", true],
  ["(min-height:500px) and (height <= 600px)", true],
  ["(500px <= height <= 600px)", true],
  ["(800px = width)", true],
  ["(orientation:landscape)", true],
  ["screen and ((width > 900px) or (height = 600px))", true],
  ["print, (width:800px)", true],
  ["screen nonsense, (height:600px)", true],
  ["screen nonsense", false],
  ["not screen nonsense", false],
  ["screen and (width:800px) or (height:600px)", false],
  ["(width:800px) or (height:600px) and (width:800px)", false],
  ["(width:800px) garbage", false],
  ["not (unknown-feature:present)", false],
  ["not ((unknown-feature:present) or (width:800px))", false],
  ["(unknown-feature:present) or (height:600px)", true],
  ["not ((unknown-feature:present) and (width:900px))", true],
  ["(height < = 600px)", false],
  ["(400px < height > 100px)", false],
];
for (const [media, applies] of mediaCases) {
  test(`structured media query: ${media}`, () => {
    const result = setup(`<style>@media ${media}{#t{color:red}}</style><p id=t>x</p>`);
    assert.deepEqual(result.style().text.color, applies ? red : null);
  });
}

test("height and width media conditions reevaluate on viewport changes", () => {
  const result = setup('<style>@media (height > 500px){#t{color:red}}@media (width < 700px){#t{background:blue}}</style><p id=t>x</p>');
  assert.equal(result.program.dependencies.mediaBlockSize, true);
  assert.equal(result.program.dependencies.mediaInlineSize, true);
  const resized = result.resolve(result.state, { ...environment, viewportWidthCssPx: 600, viewportHeightCssPx: 400 });
  assert.equal(resized.style(result.document.elementById("t")).text.color, null);
  assert.deepEqual(resized.style(result.document.elementById("t")).text.background, blue);
  assert.equal(terminalMediaMayApply("print and (width:800px)"), false);
  assert.equal(terminalMediaMayApply("screen and (height:800px)"), true);
});

test("legacy colors cover named, short, long, malformed and astral values", () => {
  for (const [source, expected] of [
    [" RED ", red], ["#f00", red], ["#123456", { r: 18, g: 52, b: 86, a: 1 }],
    ["chucknorris", { r: 192, g: 0, b: 0, a: 1 }], ["abc", { r: 10, g: 11, b: 12, a: 1 }],
    ["\u{1f600}", { r: 0, g: 0, b: 0, a: 1 }], ["", null], ["\ttransparent\r", null],
  ]) assert.deepEqual(parseLegacyColor(source), expected, source);
  assert.equal(namedColor("not-a-color"), undefined);
  assert.deepEqual(namedColor("rebeccapurple"), { r: 102, g: 51, b: 153, a: 1 });
  assert.deepEqual(setup('<p id=t style="color:RebeccaPurple">x</p>').style().text.color, namedColor("rebeccapurple"));
});

test("bgcolor hints apply only to supported HTML elements", () => {
  const result = setup('<body id=body bgcolor=red><table id=table bgcolor=red><thead id=thead bgcolor=red><tr id=tr bgcolor=red><th id=th bgcolor=red>x</th></tr></thead><tbody id=tbody bgcolor=red><tr><td id=td bgcolor=red>x</td></tr></tbody><tfoot id=tfoot bgcolor=red><tr><td>x</td></tr></tfoot></table><div id=t bgcolor=red>x</div><svg id=svg bgcolor=red></svg></body>');
  for (const id of ["body", "table", "thead", "tbody", "tfoot", "tr", "td", "th"]) assert.deepEqual(result.style(id).text.background, red, id);
  assert.equal(result.style().text.background, null);
  assert.equal(result.style("svg").text.background, null);
});

test("bgcolor hints use the author-presentational-hint origin and CSS rollback rules", () => {
  for (const [css, expected] of [["", red], ["background:blue", blue], ["background:blue!important", blue],
    ["background:initial", null], ["background:unset", null], ["background:inherit", null],
    ["background:revert", null], ["background:revert-layer", red]]) {
    const result = setup(`<body style="background:green"><table><tr><td id=t bgcolor=red style="${css}">x</td></tr></table></body>`);
    assert.deepEqual(result.style().text.background, expected, css);
  }
  assert.deepEqual(setup('<table><tr style="background:green"><td id=t bgcolor=red style="background:inherit">x</td></tr></table>').style().text.background, green);
  assert.deepEqual(setup('<style>@layer theme{#t{background:blue}}</style><table><tr><td id=t bgcolor=red>x</td></tr></table>').style().text.background, blue);
  assert.deepEqual(setup('<style>@layer theme{#t{background:revert-layer}}</style><table><tr><td id=t bgcolor=red>x</td></tr></table>').style().text.background, red);
});

test("nested rules support implicit descendants and explicit nesting selectors", () => {
  const result = setup(`<style>.parent { p { color:red; span { background:blue } } &.active { background:green } }
    .other { .theme & { color:blue } }</style><div class="parent active" id=parent><p id=t><span id=leaf>x</span></p></div><div class=theme><p class=other id=other>x</p></div>`);
  assert.deepEqual(result.style().text.color, red);
  assert.deepEqual(result.style("leaf").text.background, blue);
  assert.deepEqual(result.style("parent").text.background, green);
  assert.deepEqual(result.style("other").text.color, blue);
});

test("relative nested selectors retain child, adjacent and general sibling relations", () => {
  const result = setup(`<style>.parent { >p { color:red } +p { color:blue } ~div { background:green } }</style>
    <div class=parent><p id=t>x</p><div><p id=descendant>x</p></div></div><p id=adjacent>x</p><div id=sibling>x</div>`);
  assert.deepEqual(result.style().text.color, red);
  assert.equal(result.style("descendant").text.color, null);
  assert.deepEqual(result.style("adjacent").text.color, blue);
  assert.deepEqual(result.style("sibling").text.background, green);
});

test("nested specificity uses the most specific parent selector even when another parent matches", () => {
  const result = setup(`<style>#unmatched, .parent { span { color:red } } .parent span { color:blue }</style><div class=parent><span id=t>x</span></div>`);
  assert.deepEqual(result.style().text.color, red);
  const repeated = setup(`<style>.parent { & & { color:red } :is(&) { background:blue } }</style><div class=parent><p class=parent id=t>x</p></div>`);
  assert.deepEqual(repeated.style().text.color, red);
  assert.deepEqual(repeated.style().text.background, blue);
});

test("nested conditional blocks preserve parent matching and declaration source order", () => {
  const result = setup(`<style>#t { color:red; & { color:blue } color:green;
    @media (width:800px) { background:red; >span { color:blue } }
    @supports (display:flex) { padding-left:7px }
    @supports (unknown-property:value) { background:green; >span { color:red } }
  }</style><p id=t><span id=child>x</span></p>`);
  assert.deepEqual(result.style().text.color, green);
  assert.deepEqual(result.style().text.background, red);
  assert.deepEqual(result.style().box.padding.left, px(7));
  assert.deepEqual(result.style("child").text.color, blue);
  const resized = result.resolve(result.state, { ...environment, viewportWidthCssPx: 700 });
  assert.equal(resized.style(result.document.elementById("t")).text.background, null);
  assert.deepEqual(resized.style(result.document.elementById("child")).text.color, green);
});

test("nested layers and generated pseudo-elements use the existing cascade", () => {
  const result = setup(`<style>.parent { @layer base { color:red } @layer theme { color:blue; color:revert-layer }
    &::before { content:"prefix"; color:green } }</style><p class=parent id=t>x</p>`);
  assert.deepEqual(result.style().text.color, red);
  assert.deepEqual(result.styles.pseudo(result.document.elementById("t"), "before").text.color, green);
  assert.equal(result.styles.pseudo(result.document.elementById("t"), "before").generatedContent, "prefix");
});

test("dynamic state in parent selectors invalidates nested matches", () => {
  const result = setup('<style>.parent:hover{span{color:red}}</style><div id=parent class=parent><span id=t>x</span></div>');
  const state = Object.freeze({ ...result.state, hover: result.document.elementById("parent") });
  assert.deepEqual(result.resolve(state).style(result.document.elementById("t")).text.color, red);
  assert.equal(result.resolve(result.state).style(result.document.elementById("t")).text.color, null);
});

test("diagnostic truncation reports omitted occurrences across compile and evaluation", () => {
  const result = setup('<style>p>>a{color:red}p{unknown-one:1;unknown-two:2}</style><p id=t>x</p>', {
    budgets: { maxDiagnostics: 1 }, initialDiagnostics: [
      { code: "stylesheet-parse", sourceUrl: "a", detail: "one", occurrences: 3 },
      { code: "stylesheet-parse", sourceUrl: "b", detail: "two", occurrences: 5 },
    ], initialOmittedDiagnosticCount: 7,
  });
  assert.equal(result.program.diagnostics.length, 1);
  assert.equal(result.program.diagnostics[0].occurrences, 3);
  assert.equal(result.program.omittedDiagnosticCount, 13);
  const styles = result.resolve(result.state, environment, { maxDiagnostics: 1 });
  assert.equal(styles.diagnostics.length, 1);
  assert.equal(styles.omittedDiagnosticCount, 15);
});

test("each evaluation has a fresh work budget and reuses its structural session", () => {
  const result = setup('<style>.hot:hover{color:red}.hot:focus{background:blue}</style><p id=t class=hot>x</p>');
  const target = result.document.elementById("t"), session = result.program.selectorRuntime.authorSession;
  for (let index = 0; index < 120; index += 1) {
    const state = Object.freeze({ ...result.state, hover: index % 2 === 0 ? target : null, focus: index % 3 === 0 ? target : null });
    const styles = result.resolve(state, environment, { maxSelectorSteps: 100 });
    assert.equal(styles.outcome.status, "complete");
    assert.deepEqual(styles.style(target).text.color, state.hover === target ? red : null);
    assert.deepEqual(styles.style(target).text.background, state.focus === target ? blue : null);
    assert.equal(result.program.selectorRuntime.authorSession, session);
    assert.ok(session.usage().steps <= 100);
  }
});

test("genuine evaluation exhaustion drops all author styling, including previously retained styles", () => {
  const result = setup('<style>#t{color:red}.hot:hover{background:blue}</style><p id=t class=hot>x</p><p id=other style="color:red">x</p>');
  const hovered = Object.freeze({ ...result.state, hover: result.document.elementById("t") });
  const failed = result.resolve(hovered, environment, { maxSelectorSteps: 1 });
  assert.equal(failed.outcome.status, "truncated");
  for (const id of ["t", "other"]) assert.equal(failed.style(result.document.elementById(id)).text.color, null);
  const recovered = result.resolve(hovered);
  assert.equal(recovered.outcome.status, "complete");
  assert.deepEqual(recovered.style(result.document.elementById("t")).text.background, blue);
  assert.deepEqual(recovered.style(result.document.elementById("other")).text.color, red);
});

test("supported translations retain typed references, math, sequences and zero transforms", () => {
  const result = setup('<div id=t style="transform:translate(50%, calc(-100% + 2px)) translateX(-4px) translateY(0)"></div>');
  assert.deepEqual(result.style().box.transform[0].x, { kind: "length", value: 50, unit: "%" });
  assert.equal(result.style().box.transform[0].y.kind, "calculation");
  assert.deepEqual(result.style().box.transform[1], { x: px(-4), y: { kind: "zero" } });
  assert.deepEqual(result.style().box.transform[2], { x: { kind: "zero" }, y: { kind: "zero" } });
  assert.equal(Object.isFrozen(result.style().box.transform), true);
  assert.equal(result.styles.valueDependencies.usedViewportBlockSize, true);
  assert.equal(setup('<div id=t style="transform:none"></div>').style().box.transform, null);
  const unsupported = setup('<div id=t style="transform:rotate(45deg)"></div>');
  assert.equal(unsupported.style().box.transform, null);
  assert.ok(unsupported.styles.diagnostics.some((entry) => entry.code === "value-unsupported" && entry.detail.includes("transform")));
});

test("document quirks mode controls ID and class case matching", () => {
  for (const [doctype, expected] of [["", red], ["<!doctype html>", null],
    ['<!doctype html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">', red],
    ['<!doctype html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">', null]]) {
    const document = parseWebDocument(`${doctype}<style>#target.foo{color:red}</style><p id=TARGET class=FOO>x</p>`, { requestUrl: "https://style.test/", finalUrl: "https://style.test/" });
    const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
    const styles = resolveStyles({ program, state: createDocumentState(document), environment });
    assert.deepEqual(styles.style(document.elementById("TARGET")).text.color, expected, doctype);
  }
});

test("deep repeated nesting retains a shared selector graph and bounded evaluation", () => {
  const depth = 30;
  const result = setup(`<style>#t{${"&,&{".repeat(depth)}color:red;${"}".repeat(depth + 1)}</style><p id=t>x</p>`);
  assert.equal(result.styles.outcome.status, "complete");
  assert.deepEqual(result.style().text.color, red);
  assert.ok(result.program.selectorRuntime.authorSession.usage().steps < 10_000);
  const nested = [...result.program.compiledSelectors.values()].at(-1);
  assert.equal(nested[0].selector.selectors[0].compounds[0].simples[0].argument.selectors,
    nested[1].selector.selectors[0].compounds[0].simples[0].argument.selectors);
});

test("nesting support queries and top-level scope consume the implemented selector contract", () => {
  const result = setup('<style>@supports selector(&){#t{color:red}}:scope{background:blue}&{color:green}</style><p id=t>x</p>');
  assert.deepEqual(result.style().text.color, red);
  const root = result.styles.style(result.document.documentElement);
  assert.deepEqual(root.text.background, blue);
  assert.deepEqual(root.text.color, green);
});
