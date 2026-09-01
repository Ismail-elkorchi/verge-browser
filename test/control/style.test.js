import assert from "node:assert/strict";
import test from "node:test";

import { applyDocumentAction, createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import {
  embeddedStylesheetSources,
  compileStylesheetProgram,
  implementationSupportsCondition,
  inspectStylesheetText,
  resolveStyles
} from "../../dist/presentation/style/index.js";

const environment = {
  viewportWidthCssPx: 800,
  viewportHeightCssPx: 600,
  mediaType: "screen",
  prefersColorScheme: "dark",
  reducedMotion: true,
  hover: "hover",
  pointer: "fine"
};

function setup(html, updateState = (state) => state, budgets, mediaEnvironment = environment) {
  const document = parseWebDocument(html, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const state = updateState(createDocumentState(document), document);
  const resources = embeddedStylesheetSources(document);
  const styles = resolveStyles({
    program: compileStylesheetProgram({ document, resources, ...(budgets ? { budgets } : {}) }),
    state,
    environment: mediaEnvironment,
    ...(budgets ? { budgets } : {})
  });
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

test("HTML directionality and CSS bidi properties remain distinct computed-value inputs", () => {
  const { document, styles } = setup(`<main dir="rtl" style="direction:ltr">
    <p id="inherited" style="text-align:start">text</p>
    <bdi id="isolate">עברית</bdi>
    <bdo id="override" dir="rtl">Latin</bdo>
    <p id="properties" style="direction:rtl;unicode-bidi:isolate-override;text-align:end;
      line-break:anywhere;word-break:keep-all;overflow-wrap:anywhere;hyphens:none">text</p>
  </main>`);
  const styleById = (id) => styles.style(document.elementById(id));
  assert.equal(styleById("inherited").text.direction, "ltr");
  assert.equal(styleById("inherited").text.textAlign, "start");
  assert.equal(styleById("isolate").text.direction, "rtl");
  assert.equal(styleById("isolate").text.unicodeBidi, "isolate");
  assert.equal(styleById("override").text.unicodeBidi, "bidi-override");
  assert.deepEqual(
    {
      direction: styleById("properties").text.direction,
      unicodeBidi: styleById("properties").text.unicodeBidi,
      textAlign: styleById("properties").text.textAlign,
      lineBreak: styleById("properties").text.lineBreak,
      wordBreak: styleById("properties").text.wordBreak,
      overflowWrap: styleById("properties").text.overflowWrap,
      hyphens: styleById("properties").text.hyphens
    },
    {
      direction: "rtl", unicodeBidi: "isolate-override", textAlign: "end",
      lineBreak: "anywhere", wordBreak: "keep-all", overflowWrap: "anywhere", hyphens: "none"
    }
  );
});

test("tab-size remains an inherited computed number for CSS tab-stop resolution", () => {
  const { document, styles } = setup(`<main style="tab-size:4"><pre>one\ttwo</pre></main>`);
  const main = named(document, "main");
  const pre = named(document, "pre");
  assert.equal(styles.style(main).text.tabSize, 4);
  assert.equal(styles.style(pre).text.tabSize, 4);
});

test("dir=auto control direction follows current document state during style resolution", () => {
  const { document, styles } = setup(
    `<input id="control" dir="auto" value="עברית">`,
    (state, snapshot) => applyDocumentAction(snapshot, state, {
      kind: "set-control-value",
      target: snapshot.elementById("control"),
      value: "Latin"
    })
  );
  assert.equal(styles.style(document.elementById("control")).text.direction, "ltr");
});

test("physical and logical box properties cascade through computed horizontal direction", () => {
  const { document, styles } = setup(`<style>
    #ltr { margin-left:1px; margin-inline-start:2px; padding-inline:3px 4px }
    #rtl { direction:rtl; margin-right:1px; margin-inline-start:2px; padding-inline:3px 4px }
    #important { margin-left:5px !important; margin-inline-start:6px }
  </style>
  <div id="ltr"></div>
  <div id="rtl"></div>
  <section dir="rtl"><div id="inherited-side" style="margin-inline-start:7px"></div></section>
  <div id="auto-side" dir="auto" style="margin-inline-start:8px">עברית</div>
  <div id="css-override" dir="rtl" style="direction:ltr;margin-inline-start:9px"></div>
  <div id="ordered-one" style="margin-inline-start:11px;margin-left:12px"></div>
  <div id="ordered-two" style="margin-left:13px;margin-inline-start:14px"></div>
  <div id="important"></div>
  <div id="block-axis" style="margin-block:15px 16px;padding-block:17px 18px"></div>`);
  const box = (id) => styles.style(document.elementById(id)).box;
  assert.deepEqual(box("ltr").margin.left, { kind: "length", value: 2, unit: "px" });
  assert.deepEqual(box("ltr").padding, {
    top: { kind: "zero" }, right: { kind: "length", value: 4, unit: "px" },
    bottom: { kind: "zero" }, left: { kind: "length", value: 3, unit: "px" }
  });
  assert.deepEqual(box("rtl").margin.right, { kind: "length", value: 2, unit: "px" });
  assert.deepEqual(box("rtl").padding, {
    top: { kind: "zero" }, right: { kind: "length", value: 3, unit: "px" },
    bottom: { kind: "zero" }, left: { kind: "length", value: 4, unit: "px" }
  });
  assert.deepEqual(box("inherited-side").margin.right, { kind: "length", value: 7, unit: "px" });
  assert.deepEqual(box("auto-side").margin.right, { kind: "length", value: 8, unit: "px" });
  assert.deepEqual(box("css-override").margin.left, { kind: "length", value: 9, unit: "px" });
  assert.deepEqual(box("ordered-one").margin.left, { kind: "length", value: 12, unit: "px" });
  assert.deepEqual(box("ordered-two").margin.left, { kind: "length", value: 14, unit: "px" });
  assert.deepEqual(box("important").margin.left, { kind: "length", value: 5, unit: "px" });
  assert.deepEqual(box("block-axis").margin.top, { kind: "length", value: 15, unit: "px" });
  assert.deepEqual(box("block-axis").margin.bottom, { kind: "length", value: 16, unit: "px" });
  assert.deepEqual(box("block-axis").padding.top, { kind: "length", value: 17, unit: "px" });
  assert.deepEqual(box("block-axis").padding.bottom, { kind: "length", value: 18, unit: "px" });
});

test("unsupported CSS text tailoring values produce typed diagnostics instead of approximations", () => {
  const { document, styles } = setup(`<p style="line-break:strict;hyphens:auto">text</p>`);
  const paragraph = styles.style(named(document, "p"));
  assert.equal(paragraph.text.lineBreak, "auto");
  assert.equal(paragraph.text.hyphens, "manual");
  assert.ok(styles.diagnostics.some((entry) => entry.code === "value-unsupported" && /line-break/u.test(entry.detail)));
  assert.ok(styles.diagnostics.some((entry) => entry.code === "value-unsupported" && /hyphens/u.test(entry.detail)));
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

test("computed display blockifies floated, absolute, fixed, flex-item, and grid-item principal boxes", () => {
  const { document, styles } = setup(`<span id="float" style="float:left">float</span>
    <span id="absolute" style="position:absolute">absolute</span>
    <a id="fixed" style="position:fixed">fixed</a>
    <span id="internal" style="display:table-cell;float:left">internal</span>
    <div style="display:flex"><span id="flex-item">item</span><span id="hidden" style="display:none">hidden</span></div>
    <div style="display:grid"><span id="grid-item">item</span></div>`);
  for (const id of ["float", "absolute", "fixed", "flex-item", "grid-item"]) {
    assert.equal(styles.style(document.elementById(id)).display.outer, "block");
  }
  assert.deepEqual(styles.style(document.elementById("internal")).display, {
    box: "principal", outer: "block", inner: "flow", listItem: false, internal: null, replaced: false
  });
  assert.equal(styles.style(document.elementById("hidden")).display.box, "none");
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
  assert.deepEqual(child.box.borderStyles, { top: "solid", right: "solid", bottom: "solid", left: "solid" });
  assert.deepEqual(child.box.width, { kind: "auto" });
  assert.deepEqual(child.box.maxWidth, { kind: "none" });
});

test("Grid track lists retain structured sizing functions and repeat contracts", () => {
  const supported = setup("<style>x-grid{display:grid;grid-template-columns:2fr 10ch auto}</style><x-grid></x-grid>");
  const tracks = supported.styles.style(named(supported.document, "x-grid")).box.gridTemplateColumns;
  assert.equal(tracks.kind, "track-list");
  assert.deepEqual(tracks.entries.map((entry) => entry.kind === "track" ? entry.sizing : entry), [
    { kind: "breadth", breadth: { kind: "flex", factor: 2 } },
    { kind: "breadth", breadth: { kind: "length", value: { kind: "length", value: 10, unit: "ch" } } },
    { kind: "breadth", breadth: { kind: "auto" } }
  ]);
  const repeated = setup("<style>x-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}</style><x-grid></x-grid>");
  const repeatedTracks = repeated.styles.style(named(repeated.document, "x-grid")).box.gridTemplateColumns;
  assert.equal(repeatedTracks.kind, "track-list");
  assert.equal(repeatedTracks.entries[0].kind, "repeat");
  assert.deepEqual(repeatedTracks.entries[0].repetition, { kind: "fixed", count: 2 });

  const automatic = setup("<style>x-grid{display:grid;grid-template-columns:[cards] repeat(auto-fit,minmax(10ch,1fr)) [cards-end]}</style><x-grid></x-grid>");
  const automaticTracks = automatic.styles.style(named(automatic.document, "x-grid")).box.gridTemplateColumns;
  assert.equal(automaticTracks.kind, "track-list");
  assert.equal(automaticTracks.entries[1].kind, "repeat");
  assert.deepEqual(automaticTracks.entries[1].repetition, { kind: "auto-fit" });
  assert.equal(automatic.styles.diagnostics.length, 0);

  const nestedTrack = "repeat(1,".repeat(40) + "1fr" + ")".repeat(40);
  const nested = setup(`<style>x-grid{display:grid;grid-template-columns:${nestedTrack}}</style><x-grid></x-grid>`);
  assert.deepEqual(nested.styles.style(named(nested.document, "x-grid")).box.gridTemplateColumns, { kind: "none" });
  assert.ok(nested.styles.diagnostics.some((entry) =>
    entry.code === "value-unsupported" || entry.code === "property-invalid"
  ));
});

test("Grid computed values retain templates, areas, placements, implicit tracks, and alignment", () => {
  const { document, styles } = setup(`<style>
    #grid {
      display:grid;
      grid-template:[top] "header header" 20px [middle] "sidebar main" minmax(30px,auto) [bottom]
        / [left] 80px [content] minmax(0,1fr) [right];
      grid-auto-columns:min-content 2fr;
      grid-auto-rows:fit-content(40px) max-content;
      grid-auto-flow:column dense;
      place-items:normal baseline;
      place-content:space-around space-evenly;
      gap:3px 5px;
    }
    #item {
      grid-area:sidebar-start 2 / content -1 / span 2 footer / span 3 slot;
      place-self:center stretch;
    }
  </style><div id="grid"><div id="item">item</div></div>`);
  const grid = styles.style(document.elementById("grid")).box;
  assert.equal(grid.gridTemplateRows.kind, "track-list");
  assert.equal(grid.gridTemplateRows.entries.at(-1).kind, "line-names");
  assert.equal(grid.gridTemplateColumns.kind, "track-list");
  assert.equal(grid.gridTemplateAreas.kind, "areas");
  assert.deepEqual(grid.gridTemplateAreas.areas.get("sidebar"), {
    name: "sidebar", rowStart: 1, rowEnd: 2, columnStart: 0, columnEnd: 1
  });
  assert.equal(grid.gridAutoColumns.length, 2);
  assert.equal(grid.gridAutoRows[0].kind, "fit-content");
  assert.deepEqual(grid.gridAutoFlow, { axis: "column", packing: "dense" });
  assert.deepEqual(grid.alignItems, { position: "normal", overflow: "default" });
  assert.deepEqual(grid.justifyItems, { position: "baseline", overflow: "default" });
  assert.deepEqual(grid.alignContent, { value: "space-around", overflow: "default" });
  assert.deepEqual(grid.justifyContent, { value: "space-evenly", overflow: "default" });
  assert.deepEqual(grid.rowGap, { kind: "length", value: 3, unit: "px" });
  assert.deepEqual(grid.columnGap, { kind: "length", value: 5, unit: "px" });

  const item = styles.style(document.elementById("item")).box;
  assert.deepEqual(item.gridPlacement.rowStart, {
    kind: "line", span: false, index: 2, name: "sidebar-start"
  });
  assert.deepEqual(item.gridPlacement.columnStart, {
    kind: "line", span: false, index: -1, name: "content"
  });
  assert.deepEqual(item.gridPlacement.rowEnd, {
    kind: "line", span: true, index: 2, name: "footer"
  });
  assert.deepEqual(item.gridPlacement.columnEnd, {
    kind: "line", span: true, index: 3, name: "slot"
  });
  assert.deepEqual(item.alignSelf, { position: "center", overflow: "default" });
  assert.deepEqual(item.justifySelf, { position: "stretch", overflow: "default" });
  assert.equal(styles.diagnostics.length, 0);

  const templates = setup(`<style>
    #tracks{display:grid;grid-template:none / [content] 1fr}
    #areas{display:grid;grid-template:"main main"}
  </style><div id="tracks"></div><div id="areas"></div>`);
  const trackTemplate = templates.styles.style(templates.document.elementById("tracks")).box;
  assert.equal(trackTemplate.gridTemplateRows.kind, "none");
  assert.equal(trackTemplate.gridTemplateColumns.kind, "track-list");
  const areaTemplate = templates.styles.style(templates.document.elementById("areas")).box;
  assert.equal(areaTemplate.gridTemplateAreas.kind, "areas");
  assert.equal(areaTemplate.gridTemplateColumns.kind, "none");
  assert.equal(templates.styles.diagnostics.length, 0);

  const normalGap = setup(`<div id="grid" style="display:grid;gap:normal"></div>`);
  const normalGapStyle = normalGap.styles.style(normalGap.document.elementById("grid")).box;
  assert.deepEqual(normalGapStyle.rowGap, { kind: "normal" });
  assert.deepEqual(normalGapStyle.columnGap, { kind: "normal" });
  assert.equal(implementationSupportsCondition("gap:normal"), true);
});

test("invalid Grid grammar remains invalid and implementation support uses the owning parsers", () => {
  for (const condition of [
    "grid-template-columns:[start] 1fr [end]",
    "grid-template-columns:repeat(auto-fit,minmax(10ch,1fr))",
    "grid-template-areas:\"head head\" \"side main\"",
    "grid-template:none / [content] 1fr",
    "grid-template:\"main main\"",
    "grid-column:content -1 / span 2 item",
    "grid-auto-flow:row",
    "grid-auto-flow:column",
    "grid-auto-flow:dense",
    "grid-auto-flow:row dense",
    "grid-auto-flow:dense row",
    "grid-auto-flow:column dense",
    "grid-auto-flow:dense column",
    "place-content:space-around space-evenly",
    "justify-self:safe end",
    "align-self:unsafe center"
  ]) assert.equal(implementationSupportsCondition(condition), true, condition);
  for (const condition of [
    "grid-template-columns:repeat(auto-fit,1fr)",
    "grid-template-columns:repeat(auto-fill,fit-content(20px))",
    "grid-template-columns:minmax(1fr,20px)",
    "grid-template-columns:subgrid",
    "grid-template-columns:masonry",
    "grid-column:0",
    "grid-column:span 0",
    "grid-column:-1 span",
    "grid-template-areas:\"a a\" \"a b\"",
    "grid-template:[auto] \"main\"",
    "grid-template:\"main\" / repeat(2,10px)",
    "grid-template:\"main\" / repeat(auto-fit,10px)",
    "grid-auto-flow:row row",
    "grid-auto-flow:column column",
    "grid-auto-flow:dense dense",
    "grid-auto-flow:row column",
    "grid-auto-flow:row dense column",
    "grid:auto-flow / 1fr"
  ]) assert.equal(implementationSupportsCondition(condition), false, condition);
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
  assert.deepEqual(parent.box.justifyContent, { value: "space-between", overflow: "default" });
  assert.deepEqual(parent.box.alignItems, { position: "center", overflow: "default" });
  const child = styles.style(document.elementById("child"));
  assert.equal(child.box.flexWrap, "wrap-reverse");
  assert.deepEqual(child.box.justifyContent, { value: "space-between", overflow: "default" });
  assert.deepEqual(child.box.alignItems, { position: "normal", overflow: "default" });
});

test("cascade layers, revert-layer, and implementation-backed supports conditions are ordered", () => {
  const { document, styles } = setup(`<style>
    @layer reset, theme;
    @layer reset { #target { color:red !important; background-color:red; padding-top:1px } }
    @layer theme { #target { color:blue !important; background-color:blue; padding-top:2px } }
    @layer theme { #target { background-color:revert-layer; padding-top:revert-layer } }
    #target { color:green !important; background-color:green; margin-left:3px }
    @supports (display:flex) { #target { padding-left:4px } }
    @supports (line-break:strict) { #target { padding-right:9px } }
    @supports (border-style:dashed) { #target { margin-right:9px } }
    @supports (grid-template-columns:repeat(auto-fit, 1fr)) { #target { margin-bottom:9px } }
  </style><div id="target"></div>`);
  const target = styles.style(document.elementById("target"));
  assert.deepEqual(target.text.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(target.text.background, { r: 0, g: 128, b: 0, a: 1 });
  assert.deepEqual(target.box.margin.left, { kind: "length", value: 3, unit: "px" });
  assert.deepEqual(target.box.padding.left, { kind: "length", value: 4, unit: "px" });
  assert.deepEqual(target.box.padding.right, { kind: "zero" });
  assert.deepEqual(target.box.padding.top, { kind: "length", value: 1, unit: "px" });
  assert.deepEqual(target.box.margin.right, { kind: "zero" });
  assert.deepEqual(target.box.margin.bottom, { kind: "zero" });
});

test("implementation supports conditions reflect implemented declarations and selectors", () => {
  assert.equal(implementationSupportsCondition("display:flex"), true);
  assert.equal(implementationSupportsCondition("writing-mode:vertical-rl"), false);
  assert.equal(implementationSupportsCondition("content:url(image.png)"), false);
  assert.equal(implementationSupportsCondition("selector(main > a:any-link)"), true);
  assert.equal(implementationSupportsCondition("selector(a::first-line)"), false);
  assert.equal(implementationSupportsCondition("not (writing-mode:vertical-rl)"), true);
  assert.equal(implementationSupportsCondition("(display:flex) and (not (writing-mode:vertical-rl))"), true);
  assert.equal(implementationSupportsCondition("(display:flex) and (writing-mode:vertical-rl)"), false);
  assert.equal(implementationSupportsCondition("(display:flex) or (writing-mode:vertical-rl)"), true);
  assert.equal(implementationSupportsCondition(
    "not ((display:flex) and (writing-mode:vertical-rl))"
  ), true);
  assert.equal(implementationSupportsCondition(
    "((display:flex) and (position:sticky)) or (writing-mode:vertical-rl)"
  ), true);
  assert.equal(implementationSupportsCondition("not (display:flex) and (position:sticky)"), false);
});

test("nested cascade layers retain parent-relative order and implicit final sublayers", () => {
  const normal = setup(`<style>
    @layer outer {
      @layer inner { #target { color:red } }
      #target { color:blue }
    }
  </style><p id="target">text</p>`);
  assert.deepEqual(normal.styles.style(normal.document.elementById("target")).text.color, {
    r: 0, g: 0, b: 255, a: 1
  });

  const important = setup(`<style>
    @layer outer {
      @layer inner { #target { color:red!important } }
      #target { color:blue!important }
    }
  </style><p id="target">text</p>`);
  assert.deepEqual(important.styles.style(important.document.elementById("target")).text.color, {
    r: 255, g: 0, b: 0, a: 1
  });

  const attached = setup(`<style>
    @layer theme { #target { color:red!important } }
    #target { background:red!important }
  </style><p id="target" style="color:blue!important;background:blue!important">text</p>`);
  const attachedStyle = attached.styles.style(attached.document.elementById("target"));
  assert.deepEqual(attachedStyle.text.color, { r: 0, g: 0, b: 255, a: 1 });
  assert.deepEqual(attachedStyle.text.background, { r: 0, g: 0, b: 255, a: 1 });
});

test("revert-layer rolls back only its full cascade position", () => {
  const layered = setup(`<style>
    @layer base,theme;
    @layer base { #target { color:red; margin-left:3px; --tone:red } }
    @layer theme { #target { color:revert-layer; margin:9px; margin-left:revert-layer; --tone:revert-layer } }
    #target { background:green }
  </style><p id="target" style="background:revert-layer">text</p>`);
  const target = layered.styles.style(layered.document.elementById("target"));
  assert.deepEqual(target.text.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(target.text.background, { r: 0, g: 128, b: 0, a: 1 });
  assert.deepEqual(target.box.margin.left, { kind: "length", value: 3, unit: "px" });
  assert.equal(target.customProperties.get("--tone"), "red");

  const important = setup(`<style>
    @layer theme {
      #target { color:blue; --tone:blue }
      #target { color:revert-layer !important; --tone:revert-layer !important }
    }
  </style><p id="target">text</p>`);
  const importantTarget = important.styles.style(important.document.elementById("target"));
  assert.deepEqual(importantTarget.text.color, { r: 0, g: 0, b: 255, a: 1 });
  assert.equal(importantTarget.customProperties.get("--tone"), "blue");

  const attached = setup(`<style>#target { color:red !important }</style>
    <p id="target" style="color:blue;color:revert-layer !important">text</p>`);
  assert.deepEqual(attached.styles.style(attached.document.elementById("target")).text.color, {
    r: 255, g: 0, b: 0, a: 1
  });
});

test("anonymous cascade layers have distinct identities across stylesheet sources", () => {
  const { document, styles } = setup(`<style>
    @layer { #target { color:red !important } }
  </style><style>
    @layer { #target { color:blue !important } }
  </style><p id="target">text</p>`);
  assert.deepEqual(styles.style(document.elementById("target")).text.color, {
    r: 255, g: 0, b: 0, a: 1
  });
});

test("import media, supports, and nested layers participate in the author cascade", () => {
  const document = parseWebDocument(`<link rel="stylesheet" href="/root.css"><p id="target">text</p>`, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const owner = document.stylesheets[0].owner;
  const resource = (finalUrl, css, dependencyOrder, options = {}) => ({
    ...inspectStylesheetText(css),
    sourceKind: dependencyOrder === 2 ? "linked" : "imported",
    owner,
    requestUrl: finalUrl,
    finalUrl,
    contentType: "text/css",
    rootOrder: 0,
    dependencyOrder,
    importDepth: dependencyOrder === 2 ? 0 : 1,
    importedFrom: dependencyOrder === 2 ? null : "https://example.test/root.css",
    importLayer: options.layer ?? null,
    mediaConditions: options.media ?? [],
    supportsConditions: options.supports ?? [],
    predeclaredLayers: options.predeclaredLayers ?? [],
  });
  const resources = [
    resource("https://example.test/a.css", `#target{color:red}`, 0, { layer: ["outer", "inner"] }),
    resource("https://example.test/b.css", `#target{padding-left:99px}`, 1, {
      supports: ["writing-mode:vertical-rl"]
    }),
    resource("https://example.test/root.css", `@layer outer { @layer inner { #target{color:blue} } }
      #target{background:rgb(1 2 3 / 50%)}`, 2)
  ];
  const styles = resolveStyles({
    program: compileStylesheetProgram({ document, resources }),
    state: createDocumentState(document),
    environment,
  });
  const target = styles.style(document.elementById("target"));
  assert.deepEqual(target.text.color, { r: 0, g: 0, b: 255, a: 1 });
  assert.deepEqual(target.text.background, { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(target.box.padding.left, { kind: "zero" });

  const orderedDocument = parseWebDocument(`<link rel="stylesheet" href="/ordered.css"><p id="ordered">text</p>`, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const orderedOwner = orderedDocument.stylesheets[0].owner;
  const encoded = (finalUrl, css, dependencyOrder, importDepth, importLayer, predeclaredLayers) => ({
    ...inspectStylesheetText(css),
    sourceKind: importDepth === 0 ? "linked" : "imported",
    owner: orderedOwner,
    requestUrl: finalUrl,
    finalUrl,
    contentType: "text/css",
    rootOrder: 0,
    dependencyOrder,
    importDepth,
    importedFrom: importDepth === 0 ? null : "https://example.test/ordered.css",
    importLayer,
    mediaConditions: [],
    supportsConditions: [],
    predeclaredLayers,
  });
  const orderedResources = [
    encoded("https://example.test/theme.css", `#ordered{color:blue!important}`, 0, 1, ["theme"], [["reset"], ["theme"]]),
    encoded("https://example.test/ordered.css", `@layer reset,theme;
      @layer reset{#ordered{color:red!important}}`, 1, 0, null, [])
  ];
  const orderedStyles = resolveStyles({
    program: compileStylesheetProgram({ document: orderedDocument, resources: orderedResources }),
    state: createDocumentState(orderedDocument),
    environment,
  });
  assert.deepEqual(orderedStyles.style(orderedDocument.elementById("ordered")).text.color, {
    r: 255, g: 0, b: 0, a: 1
  });
});

test("typed CSS values preserve math, nested custom-property fallback, and functional colors", () => {
  const { document, styles } = setup(`<style>
    #target { --gap:var(--missing, calc(10% + 2rem)); width:var(--gap);
      min-width:min(40px, 8ch); max-width:clamp(60px, 50vw, 500px);
      color:hsl(120 100% 25%); background-color:rgb(10 20 30 / 50%) }
  </style><div id="target"></div>`);
  const target = styles.style(document.elementById("target"));
  assert.equal(target.box.width.kind, "calculation");
  assert.equal(target.box.minWidth.kind, "calculation");
  assert.equal(target.box.maxWidth.kind, "calculation");
  assert.deepEqual(target.text.color, { r: 0, g: 128, b: 0, a: 1 });
  assert.deepEqual(target.text.background, { r: 10, g: 20, b: 30, a: 0.5 });
});

test("custom-property substitution materializes repeated and nested expansions as one CSS syntax tree", () => {
  const { document, styles } = setup(`<style>
    #target {
      --channel: 10;
      --nested: var(--missing, var(--channel));
      color: rgb(var(--nested) var(--nested) var(--nested));
      background-color: rgb(var(--channel) var(--channel) var(--channel) / 50%);
    }
  </style><div id="target"></div>`);
  const target = styles.style(document.elementById("target"));
  assert.deepEqual(target.text.color, { r: 10, g: 10, b: 10, a: 1 });
  assert.deepEqual(target.text.background, { r: 10, g: 10, b: 10, a: 0.5 });
  assert.equal(styles.diagnostics.some((entry) => entry.code === "property-invalid"), false);
});

test("flex item and positioned-flow properties retain typed computed values", () => {
  const { document, styles } = setup(`<div id="item" style="flex:2 3 calc(25% - 1px);order:-2;
    align-self:baseline;position:absolute;inset:1px 2px 3px 4px;z-index:7;
    direction:rtl;float:inline-start;clear:inline-end"></div>
    <div id="basis" style="display:flex;gap:calc(1px + 1px) calc(2px + 2px)">
      <span style="flex:12px">basis</span><span id="content-basis" style="flex-basis:content">wide content</span></div>`);
  const item = styles.style(document.elementById("item")).box;
  assert.equal(item.flexGrow, 2);
  assert.equal(item.flexShrink, 3);
  assert.equal(item.flexBasis.kind, "calculation");
  assert.equal(item.order, -2);
  assert.deepEqual(item.alignSelf, { position: "baseline", overflow: "default" });
  assert.deepEqual(item.inset.left, { kind: "length", value: 4, unit: "px" });
  assert.equal(item.zIndex, 7);
  assert.equal(item.float, "right");
  assert.equal(item.clear, "left");
  const container = styles.style(document.elementById("basis")).box;
  const basis = styles.style(named(document, "span")).box;
  assert.equal(container.rowGap.kind, "calculation");
  assert.equal(container.columnGap.kind, "calculation");
  assert.equal(basis.flexGrow, 1);
  assert.equal(basis.flexShrink, 1);
  assert.deepEqual(basis.flexBasis, { kind: "length", value: 12, unit: "px" });
  assert.deepEqual(styles.style(document.elementById("content-basis")).box.flexBasis, { kind: "content" });

  const unsafe = setup(`<div id="unsafe" style="flex-grow:9007199254740992"></div>`);
  assert.equal(unsafe.styles.style(unsafe.document.elementById("unsafe")).box.flexGrow, 0);
  assert.ok(unsafe.styles.diagnostics.some((diagnostic) =>
    diagnostic.code === "value-unsupported" && diagnostic.detail.includes("flex-grow")));
});

test("flex shorthand accepts every grammar-valid factor and basis ordering", () => {
  const declarations = [
    ["a", "2"], ["b", "2 3"], ["c", "10px"], ["d", "2 10px"],
    ["e", "10px 2"], ["f", "2 3 10px"], ["g", "10px 2 3"],
    ["h", "calc(20% - 1px) 2 3"], ["i", "none"], ["j", "auto"],
    ["k", "initial"], ["l", "1 1 0"]
  ];
  const { document, styles } = setup(declarations.map(([id, value]) =>
    `<span id="${id}" style="flex:${value}"></span>`).join(""));
  const value = (id) => styles.style(document.elementById(id)).box;
  assert.deepEqual([value("a").flexGrow, value("a").flexShrink], [2, 1]);
  assert.deepEqual([value("b").flexGrow, value("b").flexShrink], [2, 3]);
  assert.deepEqual(value("c").flexBasis, { kind: "length", value: 10, unit: "px" });
  assert.deepEqual([value("d").flexGrow, value("d").flexBasis.value], [2, 10]);
  assert.deepEqual([value("e").flexGrow, value("e").flexBasis.value], [2, 10]);
  assert.deepEqual([value("f").flexGrow, value("f").flexShrink, value("f").flexBasis.value], [2, 3, 10]);
  assert.deepEqual([value("g").flexGrow, value("g").flexShrink, value("g").flexBasis.value], [2, 3, 10]);
  assert.equal(value("h").flexBasis.kind, "calculation");
  assert.equal(value("h").flexBasis.calculation.percentageDependence, "mixed");
  assert.deepEqual([value("i").flexGrow, value("i").flexShrink, value("i").flexBasis.kind], [0, 0, "auto"]);
  assert.deepEqual([value("j").flexGrow, value("j").flexShrink, value("j").flexBasis.kind], [1, 1, "auto"]);
  assert.deepEqual([value("k").flexGrow, value("k").flexShrink, value("k").flexBasis.kind], [0, 1, "auto"]);
  assert.deepEqual([value("l").flexGrow, value("l").flexShrink, value("l").flexBasis.kind], [1, 1, "zero"]);

  const invalid = setup(`<span id="x" style="flex:2 3 4"></span>
    <span id="y" style="flex:10px 20px"></span><span id="z" style="flex:2 -1 10px"></span>`);
  for (const id of ["x", "y", "z"]) {
    const box = invalid.styles.style(invalid.document.elementById(id)).box;
    assert.deepEqual([box.flexGrow, box.flexShrink, box.flexBasis.kind], [0, 1, "auto"]);
  }
});

test("typed length-percentage calculations retain percentage-basis dependence", () => {
  const { document, styles } = setup(`<div id="target" style="height:calc(50% - 1px);
    min-height:min(25%,20px);max-height:max(10px,5%);flex-basis:calc(40% - 1rem);
    top:calc(50% - 2px);width:calc(10px + 2rem);padding-left:calc(25%)"></div>`);
  const box = styles.style(document.elementById("target")).box;
  for (const value of [box.height, box.minHeight, box.maxHeight, box.flexBasis, box.inset.top]) {
    assert.equal(value.kind, "calculation");
    assert.equal(value.calculation.percentageDependence, "mixed");
  }
  assert.equal(box.width.kind, "calculation");
  assert.equal(box.width.calculation.percentageDependence, "none");
  assert.equal(box.padding.left.kind, "calculation");
  assert.equal(box.padding.left.calculation.percentageDependence, "percentage");
});

test("position and clipping values remain typed until layout used-value resolution", () => {
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

test("sizing and inline-layout properties retain typed computed values", () => {
  const { document, styles } = setup(`<div id="parent" style="font-size:20px">
    <span id="child" style="font-size:150%;line-height:1.5;vertical-align:super;
      max-height:40px;box-sizing:border-box;border-width:1px 2px 3px 4px">x</span>
  </div>`);
  const child = document.elementById("child");
  assert.ok(child);
  const computed = styles.style(child);
  assert.deepEqual(computed.text.fontSize, { kind: "length", value: 30, unit: "px" });
  assert.deepEqual(computed.text.lineHeight, { kind: "number", value: 1.5 });
  assert.deepEqual(computed.text.verticalAlign, { kind: "keyword", value: "super" });
  assert.deepEqual(computed.box.maxHeight, { kind: "length", value: 40, unit: "px" });
  assert.equal(computed.box.boxSizing, "border-box");
  assert.deepEqual(computed.box.borderWidths, {
    top: { kind: "length", value: 1, unit: "px" },
    right: { kind: "length", value: 2, unit: "px" },
    bottom: { kind: "length", value: 3, unit: "px" },
    left: { kind: "length", value: 4, unit: "px" }
  });
});

test("invalid runtime style environments produce a typed rejected outcome", () => {
  const document = parseWebDocument("<p>Text</p>", {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const styles = resolveStyles({
    program: compileStylesheetProgram({ document, resources: [] }),
    state: createDocumentState(document),
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

test("media queries consume color, motion, hover, and pointer preferences", () => {
  const html = `<style>
    @media (prefers-color-scheme:dark) and (prefers-reduced-motion:reduce) { p { color:red } }
    @media (hover:none) and (pointer:coarse) { p { font-style:italic } }
    @media (prefers-reduced-motion:no-preference) { p { font-weight:700 } }
  </style><p>paragraph</p>`;
  const reduced = setup(html, undefined, undefined, {
    ...environment,
    hover: "none",
    pointer: "coarse"
  });
  const reducedParagraph = reduced.styles.style(named(reduced.document, "p"));
  assert.deepEqual(reducedParagraph.text.color, { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(reducedParagraph.text.fontStyle, "italic");
  assert.equal(reducedParagraph.text.fontWeight, 400);
  const noPreference = setup(html, undefined, undefined, { ...environment, reducedMotion: false });
  assert.equal(noPreference.styles.style(named(noPreference.document, "p")).text.fontWeight, 700);
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

test("the user-agent stylesheet does not make focus a layout dependency", () => {
  const unfocused = setup(`<a href="/next">Next</a>`);
  const focused = setup(
    `<a href="/next">Next</a>`,
    (state, snapshot) => ({ ...state, focus: snapshot.links[0].node })
  );
  assert.deepEqual(
    focused.styles.style(focused.document.links[0].node),
    unfocused.styles.style(unfocused.document.links[0].node)
  );
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
    assert.equal(styles.pseudo(ref, "before")?.generatedContent, "prefix");
    assert.equal(styles.pseudo(ref, "after")?.generatedContent, "suffix");
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
  assert.equal(styles.style(named(document, "p")).text.color, null);
  assert.equal(styles.style(named(document, "div")).text.color, null);
});

test("author-style exhaustion leaves a total baseline style for every retained element", () => {
  const { document, styles } = setup(
    `<style>span:first-child{color:red} span:last-child{color:blue}</style><main>${"<span>word</span>".repeat(20)}</main>`,
    undefined,
    { maxSelectorQueries: 1 }
  );
  assert.equal(styles.outcome.status, "truncated");
  assert.equal(styles.outcome.budget, "maxSelectorQueries");
  const pending = [document.root];
  let elements = 0;
  while (pending.length > 0) {
    const ref = pending.pop();
    const node = document.node(ref);
    pending.push(...node.children);
    if (node.kind !== "element") continue;
    elements += 1;
    assert.doesNotThrow(() => styles.style(node.ref));
  }
  assert.equal(styles.outcome.computedNodes, elements);
});

test("one indexed selector session admits complex author styles within the default work budget", () => {
  const count = 1_000;
  const rules = Array.from(
    { length: count },
    (_, index) => `.entry-${String(index)} { color: rgb(${String(index % 256)} 0 0) }`
  ).join("\n");
  const elements = Array.from(
    { length: count },
    (_, index) => `<span class="entry-${String(index)}">${String(index)}</span>`
  ).join("");
  const { document, styles } = setup(`<style>${rules}</style><main>${elements}</main>`);
  assert.equal(styles.outcome.status, "complete");
  const last = document.node(named(document, "main")).children.at(-1);
  assert.ok(last);
  assert.deepEqual(styles.style(last).text.color, { r: 231, g: 0, b: 0, a: 1 });
});

test("identical author selectors reuse one verified match result", () => {
  const rules = Array.from(
    { length: 100 },
    (_, index) => `.container a { color:rgb(${String(index)} 0 0) }`
  ).join("\n");
  const links = Array.from(
    { length: 500 },
    (_, index) => `<a href="/${String(index)}">${String(index)}</a>`
  ).join("");
  const { document, styles } = setup(
    `<style>${rules}</style><main class="container">${links}</main>`,
    undefined,
    { maxSelectorSteps: 10_000 }
  );

  assert.equal(styles.outcome.status, "complete");
  assert.deepEqual(
    styles.style(document.links.at(-1).node).text.color,
    { r: 99, g: 0, b: 0, a: 1 }
  );
});

test("user-agent baseline styles remain total beyond the former selector depth bound", () => {
  const depth = 2_500;
  const document = parseWebDocument(
    `${"<x-shell>".repeat(depth)}<p>deep</p>${"</x-shell>".repeat(depth)}`,
    { requestUrl: "https://example.test/", finalUrl: "https://example.test/" }
  );
  const styles = resolveStyles({
    program: compileStylesheetProgram({ document, resources: [] }),
    state: createDocumentState(document),
    environment
  });
  const paragraph = named(document, "p");
  assert.equal(styles.style(paragraph).display.box, "principal");
  assert.equal(styles.outcome.status, "complete");
});
