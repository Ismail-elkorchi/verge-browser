import assert from "node:assert/strict";
import test from "node:test";
import { parseSelectorList } from "@ismail-elkorchi/css-parser";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { implementationSupportsCondition } from "../../dist/presentation/style/cascade.js";
import { admitSelectorList } from "../../dist/presentation/style/selector-admission.js";
import { EMPTY_NAMESPACES } from "../../dist/presentation/style/namespaces.js";

const environment = { viewportWidthCssPx: 800, viewportHeightCssPx: 600, mediaType: "screen",
  prefersColorScheme: "dark", reducedMotion: false, hover: "hover", pointer: "fine" };
const red = { r: 255, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 255, a: 1 };
function fixture(css, html = '<p id="t" class="target" data-a="b">Target</p>') {
  const document = parseWebDocument(`<!doctype html><style>${css}</style>${html}`, {
    requestUrl: "https://validity.test/", finalUrl: "https://validity.test/",
  });
  const state = createDocumentState(document);
  const program = compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) });
  const styles = resolveStyles({ program, state, environment });
  return { program, document, state, styles, color: (id = "t") => styles.style(document.elementById(id)).text.color };
}

test("invalid selector suffixes invalidate the whole ordinary rule at every comma position", () => {
  for (const prefix of ["p", "#t", ".target", "[data-a]", "&", "body > p"]) {
    for (const suffix of [":unknown-test", "::unknown-test", "::-moz-unknown-test", "::-webkit-unknown-test()", "[a?=b]", ":nth-child(nope)"]) {
      for (const selector of [`${prefix}${suffix}, #t`, `#t, ${prefix}${suffix}`, `#t, ${prefix}${suffix}, .target`]) {
        const f = fixture(`${selector}{color:red}`);
        assert.equal(f.color(), null, selector);
        assert.ok(f.styles.diagnostics.some((item) => item.code === "selector-parse"), selector);
      }
    }
  }
});

test("contextually unsupported constructs invalidate strict selector lists before matching", () => {
  for (const invalid of ["p:fullscreen", "p:lang(en)", "p:dir(ltr)", "p::selection", "p::first-line",
    "p::before:hover", "p::before::marker", "p::before > p", ":not(:fullscreen)", ":has(> :fullscreen)", ":nth-child(1 of :fullscreen)"]) {
    for (const selector of [`${invalid}, #t`, `#t, ${invalid}`]) {
      const f = fixture(`${selector}{color:red}`);
      assert.equal(f.color(), null, selector);
      assert.equal(f.styles.diagnostics.some((item) => item.code === "selector-unknown"), false, selector);
    }
  }
});

test("forgiving contextual pruning happens before specificity without broadening invalid compounds", () => {
  for (const invalid of ["#t:fullscreen", "#t:unknown-test", "#t[a?=b]", "missing|p#t", "#t:nth-child(nope)", "#t:not(:fullscreen)"]) {
    for (const pseudo of ["is", "where"]) {
      const f = fixture(`:${pseudo}(${invalid}, .target){color:red}.target{color:blue}`);
      assert.deepEqual(f.color(), blue, `${pseudo} ${invalid}`);
    }
    assert.equal(fixture(`:is(${invalid}){color:red}`).color(), null, invalid);
  }
  assert.deepEqual(fixture(":not(:is(:fullscreen)){color:red}").color(), red);
});

test("unknown non-functional WebKit pseudo-elements remain valid and match nothing", () => {
  for (const pseudo of ["::-webkit-unknown-test", "::-WeBkIt-unknown-test"]) {
    assert.equal(fixture(`#t${pseudo}{color:red}`).color(), null);
    assert.deepEqual(fixture(`#t${pseudo}, .target{color:red}`).color(), red);
    assert.deepEqual(fixture(`#t${pseudo}, .target{color:red}.target{color:blue}`).color(), blue);
  }
  const f = fixture('#t::before{content:"before";color:red}#t::-webkit-unknown-test{color:blue}');
  assert.deepEqual(f.styles.pseudo(f.document.elementById("t"), "before").text.color, red);
});

test("supports selector requires exactly one fully supported complex with no forgiving recovery", () => {
  for (const selector of ["p, a", "", ":is()", ":where()", ":has()", ":is(.target,)", ":is(,.target)",
    ":is(.target,:unknown-test)", ":where(:is(.target,:unknown-test))", ":not(:is(:unknown-test))",
    ":is(.target,:fullscreen)", ":where(.target,missing|p)", "::-webkit-unknown-test", "p::before:hover",
    ":has(:where(.target,:unknown-test))", ":has(:is(.target,:has(.target)))"]) {
    assert.equal(implementationSupportsCondition(`selector(${selector})`), false, selector);
    assert.equal(fixture(`@supports selector(${selector}){#t{color:red}}`).color(), null, selector);
  }
  for (const selector of ["p > a:any-link", "&", ":scope", ":is(.target,p)", ":where(.target)",
    ":not(.other)", ":has(> .target)", ":nth-child(2n + 1 of .target)", "p::before", "p::marker"]) {
    assert.equal(implementationSupportsCondition(`selector(${selector})`), true, selector);
  }
});

test("namespace support checks validate all original branches before forgiving admission", () => {
  const prefix = '@namespace x "http://www.w3.org/1999/xhtml";';
  assert.deepEqual(fixture(`${prefix}@supports selector(:is(x|p,.target)){#t{color:red}}`).color(), red);
  for (const selector of [":is(X|p,.target)", ":is(missing|p,.target)", ":is([missing|a],.target)"])
    assert.equal(fixture(`${prefix}@supports selector(${selector}){#t{color:red}}`).color(), null, selector);
  assert.deepEqual(fixture(`${prefix}:is(missing|p,.target){color:red}`).color(), red);
});

test("nesting observes original ampersands even when their branches are discarded", () => {
  const html = '<section id="parent"><p id="inside" class="target">Inside</p></section><p id="t" class="target">Outside</p>';
  for (const selector of [":is(:unknown-test(&),.target)", ":is(:unknown-test(nested(&)),.target)",
    ":is(&:fullscreen,.target)", ":is(missing|p&,.target)"]) {
    const f = fixture(`#parent{${selector}{color:red}}`, html);
    assert.deepEqual(f.color("inside"), red, selector);
    assert.deepEqual(f.color(), red, selector);
    const compiled = [...f.program.compiledSelectors.values()].at(-1)[0];
    assert.equal(compiled.selector.selectors[0].source.containsNesting, true);
    assert.deepEqual(compiled.specificity, { a: 0, b: 1, c: 0 });
  }
  const implicit = fixture('#parent{:is(:unknown-test(),.target){color:red}}', html);
  assert.deepEqual(implicit.color("inside"), red);
  assert.equal(implicit.color(), null);
  const relative = fixture('#parent{> :is(:unknown-test(&),.target){color:red}}', html);
  assert.deepEqual(relative.color("inside"), red);
  assert.equal(relative.color(), null);
});

test("invalid parent selectors suppress their whole nested subtree", () => {
  for (const parent of ["#parent:unknown-test", "#parent:fullscreen", "missing|p", "#parent, :unknown-test"])
    assert.equal(fixture(`${parent}{:is(:unknown-test(&),.target){color:red}}`).color(), null, parent);
});

test("admission preserves original immutable source metadata without mutating shared ASTs", () => {
  const parsed = parseSelectorList(":is(:unknown-test(&), #t:fullscreen, .target)");
  assert.equal(parsed.ok, true);
  const original = parsed.value.selectors[0].compounds[0].simples[0].argument.selectors;
  assert.equal(original.length, 2);
  const admitted = admitSelectorList(parsed.value, EMPTY_NAMESPACES, "stylesheet");
  assert.equal(admitted.selectors[0].compounds[0].simples[0].argument.selectors.length, 1);
  assert.equal(original.length, 2);
  assert.equal(admitted.source, parsed.value.source);
  assert.equal(admitted.selectors[0].source, parsed.value.selectors[0].source);
  assert.ok(Object.isFrozen(admitted));
  assert.ok(Object.isFrozen(admitted.selectors[0].compounds));
  assert.equal(admitSelectorList(parsed.value, EMPTY_NAMESPACES, "supports"), null);
});

test("semantic selector reuse ignores recovery spans while retaining original nesting semantics", () => {
  const f = fixture(':is(:unknown-test, .target){color:red}:is(.target){color:blue}');
  const authored = [...f.program.compiledSelectors.values()].slice(-2);
  assert.equal(authored.length, 2);
  assert.equal(authored[0][0].fingerprint, authored[1][0].fingerprint);
  assert.deepEqual(f.color(), blue);
  const warmed = resolveStyles({ program: f.program, state: f.state, environment, budgets: { maxSelectorSteps: 1 } });
  assert.equal(warmed.outcome.status, "complete");
  assert.deepEqual(warmed.style(f.document.elementById("t")).text.color, blue);

  const nested = fixture('#parent{:is(:unknown-test(&),.target){color:red}:is(:unknown-test(),.target){color:blue}}',
    '<section id="parent"><p id="inside" class="target">Inside</p></section><p id="t" class="target">Outside</p>');
  const children = [...nested.program.compiledSelectors.values()].slice(-2);
  assert.notEqual(children[0][0].fingerprint, children[1][0].fingerprint);
  assert.deepEqual(nested.color("inside"), blue);
  assert.deepEqual(nested.color(), red);
});

test("WebKit name compatibility preserves only valid pseudo-element structures and states", () => {
  for (const invalid of ["p::-webkit-test > p", "p::-webkit-test p", "p::-webkit-test + p", "p::-webkit-test ~ p",
    "p::-webkit-test::-webkit-other", "p::-webkit-test::before", "p::before::-webkit-test",
    "p::-webkit-test:first-child", "p::-webkit-test:nth-child(1)", "p::-webkit-test:not(:first-child)",
    "p::-webkit-test:is(:hover) > p"]) {
    assert.equal(fixture(`${invalid}, .target{color:red}`).color(), null, invalid);
    assert.deepEqual(fixture(`:is(${invalid}, .target){color:red}`).color(), red, invalid);
  }
  for (const suffix of ["", ":hover", ":active", ":focus", ":focus-visible", ":focus-within", ":hover:active",
    ":not(:hover)", ":is(:hover,:active)", ":where(:first-child,:hover)", ":is(.invalid-state,:active)"]) {
    assert.deepEqual(fixture(`p::-webkit-test${suffix}, .target{color:red}`).color(), red, suffix);
    assert.equal(fixture(`p::-webkit-test${suffix}{color:red}`).color(), null, suffix);
    assert.equal(implementationSupportsCondition(`selector(p::-webkit-test${suffix})`), false, suffix);
  }
});
