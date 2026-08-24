import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { resolveStyles } from "../../dist/presentation/style/index.js";

const environment = {
  viewportWidthPx: 800,
  viewportHeightPx: 600,
  mediaType: "screen",
  prefersColorScheme: "dark",
  reducedMotion: true
};

function setup(html, updateState = (state) => state, budgets) {
  const document = parseWebDocument(html, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const state = updateState(createDocumentState(document), document);
  const styles = resolveStyles({ document, state, resources: [], environment, ...(budgets ? { budgets } : {}) });
  return { document, state, styles };
}

function named(document, name) {
  const pending = [document.root];
  while (pending.length > 0) {
    const ref = pending.shift();
    const node = document.node(ref);
    if (node.kind === "element" && node.name === name) return node.ref;
    pending.push(...node.children);
  }
  throw new Error(`Missing ${name}`);
}

test("cascade orders user-agent, author, specificity, source order, inline declarations, and inheritance", () => {
  const { document, styles } = setup(`<style>
    p { color: red; display: inline; --accent: #123456 }
    main p.note { color: blue }
    main p.note { color: var(--accent) }
  </style><main style="font-style: italic"><p class="note" style="font-weight: 700">Text</p></main>`);
  const paragraph = styles.style(named(document, "p"));
  assert.deepEqual(paragraph.display, {
    box: "principal", outer: "inline", inner: "flow", listItem: false, internal: null, replaced: false
  });
  assert.deepEqual(paragraph.text.color, { r: 18, g: 52, b: 86, a: 1 });
  assert.equal(paragraph.text.fontWeight, 700);
  assert.equal(paragraph.text.fontStyle, "italic");
  assert.equal(paragraph.customProperties.get("--accent"), "#123456");
});

test("text decoration propagates at paint time without becoming an inherited computed value", () => {
  const { document, styles } = setup(`<p style="text-decoration:underline"><span>child</span></p>`);
  assert.equal(styles.style(named(document, "p")).text.underline, true);
  assert.equal(styles.style(named(document, "span")).text.underline, false);
});

test("text alignment and indentation remain typed inherited CSS values", () => {
  const { document, styles } = setup(`<div style="text-align:right;text-indent:2ch"><span>child</span></div>`);
  const child = styles.style(named(document, "span"));
  assert.equal(child.text.textAlign, "right");
  assert.deepEqual(child.text.textIndent, { kind: "length", value: 2, unit: "ch" });
});

test("display computation separates outer and inner values and covers suppression and internal roles", () => {
  const { document, styles } = setup(`<style>
    span.block { display: block flow-root }
    div.inline { display: inline }
    section.contents { display: contents }
    aside.none { display: none }
    x-list { display: list-item }
    x-cell { display: table-cell }
    x-flex { display: flex }
    x-grid { display: inline-grid }
  </style><span class="block"></span><div class="inline"></div><section class="contents"></section>
  <aside class="none"></aside><x-list></x-list><x-cell></x-cell><x-flex></x-flex><x-grid></x-grid>`);
  const style = (name) => styles.style(named(document, name)).display;
  assert.deepEqual(style("span"), { box: "principal", outer: "block", inner: "flow-root", listItem: false, internal: null, replaced: false });
  assert.equal(style("div").outer, "inline");
  assert.equal(style("section").box, "contents");
  assert.equal(style("aside").box, "none");
  assert.equal(style("x-list").listItem, true);
  assert.equal(style("x-cell").internal, "table-cell");
  assert.equal(style("x-flex").inner, "flex");
  assert.deepEqual(style("x-grid"), { box: "principal", outer: "inline", inner: "grid", listItem: false, internal: null, replaced: false });
});

test("CSS-wide display values inherit deliberately and revert to the user-agent origin", () => {
  const inherited = setup(`<style>main{display:grid}span{display:inherit}</style><main><span>child</span></main>`);
  assert.equal(inherited.styles.style(named(inherited.document, "span")).display.inner, "grid");
  const reverted = setup(`<style>p{display:revert}</style><p>paragraph</p>`);
  assert.equal(reverted.styles.style(named(reverted.document, "p")).display.outer, "block");
});

test("CSS-wide keywords resolve inherited and initial typed box and text values", () => {
  const { document, styles } = setup(`<style>
    #parent { color:red; background-color:blue; text-decoration:underline; margin-left:3ch;
      padding-left:4ch; gap:2ch; overflow:hidden; border:1px solid red }
    #child { color:inherit; background-color:inherit; text-decoration:inherit; margin-left:inherit;
      padding-left:unset; gap:inherit; overflow:inherit; border:inherit; width:initial; max-width:unset }
  </style><div id="parent"><span id="child">Child</span></div>`);
  const child = styles.style(document.elementById("child"));
  assert.deepEqual(child.text.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(child.text.background, { r: 0, g: 0, b: 255, a: 1 });
  assert.equal(child.text.underline, true);
  assert.deepEqual(child.box.margin.left, { kind: "length", value: 3, unit: "ch" });
  assert.deepEqual(child.box.padding.left, { kind: "zero" });
  assert.deepEqual(child.box.columnGap, { kind: "length", value: 2, unit: "ch" });
  assert.equal(child.box.overflowX, "hidden");
  assert.equal(child.box.borderStyle, "solid");
  assert.deepEqual(child.box.width, { kind: "auto" });
  assert.deepEqual(child.box.maxWidth, { kind: "none" });
});

test("grid tracks and fixed repeat/minmax values are typed without overclaiming automatic tracks", () => {
  const supported = setup("<style>x-grid{display:grid;grid-template-columns:2fr 10ch auto}</style><x-grid></x-grid>");
  assert.deepEqual(supported.styles.style(named(supported.document, "x-grid")).box.gridTemplateColumns, [
    { kind: "fraction", value: 2 },
    { kind: "length", value: { kind: "length", value: 10, unit: "ch" } },
    { kind: "auto" }
  ]);
  const repeated = setup("<style>x-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}</style><x-grid></x-grid>");
  assert.deepEqual(repeated.styles.style(named(repeated.document, "x-grid")).box.gridTemplateColumns, [
    {
      kind: "minmax",
      minimum: { kind: "length", value: { kind: "zero" } },
      maximum: { kind: "fraction", value: 1 }
    },
    {
      kind: "minmax",
      minimum: { kind: "length", value: { kind: "zero" } },
      maximum: { kind: "fraction", value: 1 }
    }
  ]);
  const unsupported = setup("<style>x-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10ch,1fr))}</style><x-grid></x-grid>");
  assert.deepEqual(unsupported.styles.style(named(unsupported.document, "x-grid")).box.gridTemplateColumns, []);
  assert.ok(unsupported.styles.diagnostics.some((entry) => entry.code === "value-unsupported"));

  const nestedTrack = "repeat(1,".repeat(40) + "1fr" + ")".repeat(40);
  const nested = setup(`<style>x-grid{display:grid;grid-template-columns:${nestedTrack}}</style><x-grid></x-grid>`);
  assert.deepEqual(nested.styles.style(named(nested.document, "x-grid")).box.gridTemplateColumns, []);
  assert.ok(nested.styles.diagnostics.some((entry) =>
    entry.code === "value-unsupported" || entry.code === "property-invalid"
  ));
});

test("flex wrapping and alignment retain typed computed values and CSS-wide semantics", () => {
  const { document, styles } = setup(`<style>
    #parent { display:flex; flex-direction:column; flex-wrap:wrap-reverse;
      justify-content:space-between; align-items:center }
    #child { display:flex; flex-wrap:inherit; justify-content:inherit; align-items:initial }
  </style><div id="parent"><div id="child">Child</div></div>`);
  const parent = styles.style(document.elementById("parent"));
  assert.equal(parent.box.flexDirection, "column");
  assert.equal(parent.box.flexWrap, "wrap-reverse");
  assert.equal(parent.box.justifyContent, "space-between");
  assert.equal(parent.box.alignItems, "center");
  const child = styles.style(document.elementById("child"));
  assert.equal(child.box.flexWrap, "wrap-reverse");
  assert.equal(child.box.justifyContent, "space-between");
  assert.equal(child.box.alignItems, "stretch");
});

test("position and clipping values remain typed until terminal used-value resolution", () => {
  const { document, styles } = setup(`<style>
    #legacy { position:absolute; clip:rect(0, 0, 0, 0) }
    #modern { position:fixed; clip-path:inset(50%) }
  </style><a id="legacy">Legacy</a><a id="modern">Modern</a>`);
  const legacy = styles.style(document.elementById("legacy"));
  assert.equal(legacy.box.position, "absolute");
  assert.deepEqual(legacy.box.legacyClip, {
    kind: "rect",
    edges: { top: { kind: "zero" }, right: { kind: "zero" }, bottom: { kind: "zero" }, left: { kind: "zero" } }
  });
  const modern = styles.style(document.elementById("modern"));
  assert.equal(modern.box.position, "fixed");
  assert.deepEqual(modern.box.clipPath, {
    kind: "inset",
    offsets: {
      top: { kind: "length", value: 50, unit: "%" },
      right: { kind: "length", value: 50, unit: "%" },
      bottom: { kind: "length", value: 50, unit: "%" },
      left: { kind: "length", value: 50, unit: "%" }
    }
  });
});

test("computed CSS values are immutable and preserve supported sizing-domain distinctions", () => {
  const { document, styles } = setup(`<style>
    p { --accent:#123456; color:var(--accent); margin-left:-2ch; padding-left:-2ch; max-width:none }
  </style><p>Text</p>`);
  const paragraph = styles.style(named(document, "p"));

  assert.deepEqual(paragraph.box.margin.left, { kind: "length", value: -2, unit: "ch" });
  assert.deepEqual(paragraph.box.padding.left, { kind: "zero" });
  assert.deepEqual(paragraph.box.maxWidth, { kind: "none" });
  assert.equal(Object.isFrozen(paragraph), true);
  assert.equal(Object.isFrozen(paragraph.display), true);
  assert.equal(Object.isFrozen(paragraph.text), true);
  assert.equal(Object.isFrozen(paragraph.text.color), true);
  assert.equal(Object.isFrozen(paragraph.box), true);
  assert.equal(Object.isFrozen(paragraph.box.margin), true);
  assert.equal(Object.isFrozen(paragraph.customProperties), true);
  assert.equal(typeof paragraph.customProperties.set, "undefined");
  assert.ok(styles.diagnostics.some((entry) =>
    (entry.code === "value-unsupported" || entry.code === "property-invalid")
    && entry.detail.includes("padding-left")
  ));
});

test("invalid runtime style environments produce a typed rejected outcome", () => {
  const document = parseWebDocument("<p>Text</p>", {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const styles = resolveStyles({
    document,
    state: createDocumentState(document),
    resources: [],
    environment: { ...environment, mediaType: "print" }
  });
  assert.deepEqual(styles.outcome, { status: "rejected", reason: "invalid-environment" });
  assert.equal(Object.isFrozen(styles.diagnostics), true);
});

test("unknown media types fail closed instead of applying to the terminal screen", () => {
  const { document, styles } = setup(`<style>
    @media speech { p { color:red } }
    @media screen { p { font-style:italic } }
  </style><p>paragraph</p>`);
  const paragraph = styles.style(named(document, "p"));
  assert.equal(paragraph.text.color, null);
  assert.equal(paragraph.text.fontStyle, "italic");
  assert.ok(styles.diagnostics.some((entry) =>
    entry.code === "stylesheet-media" && entry.detail.includes("speech")
  ));
});

test("dynamic pseudo-class state participates in selector matching", () => {
  const { document, styles } = setup(
    `<style>a:focus { text-decoration: underline; color: #abcdef }</style><a href="/next">Next</a>`,
    (state, document) => ({ ...state, focus: document.links[0].node })
  );
  const link = styles.style(document.links[0].node);
  assert.equal(link.text.underline, true);
  assert.deepEqual(link.text.color, { r: 171, g: 205, b: 239, a: 1 });
});

test("URL targets and selected options participate in dynamic selector matching", () => {
  const target = setup(`<style>
    :target { color:#112233 }
    option:checked { font-weight:700 }
  </style><h2 id="target">Target</h2><form><select name="choice">
    <option>First</option><option selected>Second</option>
  </select></form>`, (state, document) => ({
    ...state,
    urlTarget: document.elementById("target")
  }));
  const targetNode = target.document.elementById("target");
  assert.ok(targetNode);
  assert.deepEqual(target.styles.style(targetNode).text.color, { r: 17, g: 34, b: 51, a: 1 });
  const select = target.document.forms[0].controls.find((control) => control.kind === "select");
  assert.ok(select);
  assert.equal(target.styles.style(select.options[0].node).text.fontWeight, 400);
  assert.equal(target.styles.style(select.options[1].node).text.fontWeight, 700);
});

test("selector lists retain distinct generated pseudo-element identities", () => {
  const { document, styles } = setup(`<style>
    p::before, h1::before { content:"prefix" }
    p::after, h1::after { content:"suffix" }
  </style><h1>Heading</h1><p>Paragraph</p>`);
  for (const name of ["h1", "p"]) {
    const ref = named(document, name);
    assert.equal(styles.pseudo(ref, "before")?.generatedBefore, "prefix");
    assert.equal(styles.pseudo(ref, "after")?.generatedAfter, "suffix");
  }
});

test("user-agent disclosure rules consume dynamic open state", () => {
  const closed = setup("<details><summary>More</summary><p>Secret</p></details><dialog>Dialog</dialog>");
  assert.equal(closed.styles.style(named(closed.document, "summary")).display.listItem, true);
  assert.equal(closed.styles.style(named(closed.document, "p")).display.box, "none");
  assert.equal(closed.styles.style(named(closed.document, "dialog")).display.box, "none");

  const opened = setup(
    "<details><summary>More</summary><p>Secret</p></details><dialog>Dialog</dialog>",
    (state, document) => ({
      ...state,
      open: new Set(document.disclosures.map((entry) => entry.node))
    })
  );
  assert.equal(opened.styles.style(named(opened.document, "p")).display.box, "principal");
  assert.equal(opened.styles.style(named(opened.document, "dialog")).display.box, "principal");
});

test("user-agent hidden-resource defaults suppress datalist and media helper content", () => {
  const { document, styles } = setup(`<datalist><option>Suggestion</option></datalist>
    <source src="movie.mp4"><track src="captions.vtt"><p>Visible</p>`);
  assert.equal(styles.style(named(document, "datalist")).display.box, "none");
  assert.equal(styles.style(named(document, "source")).display.box, "none");
  assert.equal(styles.style(named(document, "track")).display.box, "none");
  assert.equal(styles.style(named(document, "p")).display.box, "principal");
});

test("user-agent defaults structurally cover HTML search, definitions, and legacy preformatted blocks", () => {
  const { document, styles } = setup(`<search>Search</search><dl><dt>Term</dt><dd>Definition</dd></dl><listing>Code</listing>`);
  for (const name of ["search", "dl", "dt", "dd", "listing"]) {
    assert.equal(styles.style(named(document, name)).display.outer, "block");
  }
  assert.equal(styles.style(named(document, "listing")).text.whiteSpace, "pre");
});

test("style work exhaustion is a typed truncation and retains already-computed UA styles", () => {
  const { document, styles } = setup(
    `<style>p { color:red } div { color:blue } span { color:green }</style><p>P</p><div>D</div><span>S</span>`,
    undefined,
    { maxSelectorQueries: 1 }
  );
  assert.deepEqual(styles.outcome, {
    status: "truncated",
    computedNodes: styles.outcome.computedNodes,
    budget: "maxSelectorQueries",
    limit: 1
  });
  assert.equal(styles.style(named(document, "p")).display.box, "principal");
});

test("computed-node exhaustion stops style work instead of dropping author origin globally", () => {
  const { document, styles } = setup(
    `<main>${"<span>word</span>".repeat(20)}</main>`,
    undefined,
    { maxComputedNodes: 4 }
  );
  assert.equal(styles.outcome.status, "truncated");
  assert.equal(styles.outcome.budget, "maxComputedNodes");
  assert.equal(styles.outcome.computedNodes, 4);
  const spans = document.children(named(document, "main"));
  assert.ok(spans.some((span) => !styles.has(span.ref)));
});
