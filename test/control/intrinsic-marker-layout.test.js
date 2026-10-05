import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { buildLayoutFragmentTree, cssCoordinate, cssMultiply, cssPixels, cssPx, cssRect } from "../../dist/presentation/layout/index.js";
import { compileStylesheetProgram, embeddedStylesheetSources, resolveStyles } from "../../dist/presentation/style/index.js";
import { buildInlineItemStreamSet } from "../../dist/presentation/text/index.js";
import { buildTextSearchIndex } from "../../dist/presentation/search/index.js";
import { terminalCssControlMeasurer, terminalCssTextMeasurer } from "../../dist/ui/terminal-measure.js";

function render(html, budgets) {
  const document = parseWebDocument(`<style>html,body,p{margin:0}</style>${html}`, {
    requestUrl: "https://intrinsic-marker.test/", finalUrl: "https://intrinsic-marker.test/"
  });
  const state = createDocumentState(document);
  const styles = resolveStyles({ program: compileStylesheetProgram({ document, resources: embeddedStylesheetSources(document) }), state,
    environment: { viewportWidthCssPx: 640, viewportHeightCssPx: 480, mediaType: "screen", prefersColorScheme: "light",
      reducedMotion: false, hover: "hover", pointer: "fine" } });
  const formatting = buildFormattingTree({ document, state, styles });
  const inlineItemStreams = buildInlineItemStreamSet(formatting);
  const rect = cssRect(cssCoordinate(cssPx(0)), cssCoordinate(cssPx(0)), cssPx(640), cssPx(480));
  const layout = buildLayoutFragmentTree({ formatting, inlineItemStreams, context: { viewport: { width: rect.width, height: rect.height },
    initialContainingBlock: rect, scrollport: rect, textMeasurer: terminalCssTextMeasurer(), controlMeasurer: terminalCssControlMeasurer(),
    ...(budgets === undefined ? {} : { budgets }) } });
  if (budgets === undefined) assert.equal(layout.outcome.status, "complete", JSON.stringify(layout.outcome));
  const fragment = (id) => layout.forDocumentNode(document.elementById(id))
    .find((value) => value.kind === "box" && value.pseudoElement === null && formatting.node(value.formattingNode).appliesBoxStyle);
  const text = (id) => layout.forDocumentNode(document.elementById(id)).filter((value) => value.kind === "text");
  const descendants = (fragmentId) => {
    const result = [], pending = [fragmentId];
    while (pending.length) { const value = layout.fragment(pending.pop()); result.push(value); pending.push(...value.children); }
    return result;
  };
  return { document, state, styles, formatting, inlineItemStreams, layout, fragment, text, descendants };
}

for (const display of ["float:left", "float:right", "display:inline-block", "position:absolute", "display:inline-flex", "display:inline-grid"]) {
  test(`canonical intrinsic edges are charged once for ${display}`, () => {
    const result = render(`<div id=target style="${display}"><a style="display:block;padding:0 14px">Home</a></div>`);
    assert.equal(cssPixels(result.fragment("target").borderRect.width), 60);
  });
}

test("grid and float contributions preserve inline run boundaries instead of DOM text boundaries", () => {
  for (const content of ["HomeDocumentation", "<span>Home</span><span>Documentation</span>"])
    for (const display of ["display:grid;grid-template-columns:max-content", "display:block"] ) {
      const result = render(`<div style="${display}"><div id=target style="${display.startsWith("display:block") ? "float:left" : ""}">${content}</div></div>`);
      assert.equal(cssPixels(result.fragment("target").borderRect.width), 136);
    }
  const padded = render('<div style="display:grid;grid-template-columns:max-content"><div id=target><a style="display:block;padding:0 14px">Home</a></div></div>');
  assert.equal(cssPixels(padded.fragment("target").borderRect.width), 60);
});

test("block intrinsic composition, nested edges, border-box constraints and conflict priority", () => {
  for (const [content, style, expected] of [
    ["<p>Home</p><p>Documentation</p>", "", 104],
    ['<div style="margin:0 3px;border:2px solid;padding:0 7px"><span style="padding:0 5px">Home</span></div>', "padding:0 4px;border:1px solid", 76],
    ["Home", "width:80px;padding:0 10px;border:2px solid;box-sizing:border-box", 80],
    ["Home", "min-width:100px;max-width:50px", 100],
  ]) {
    const result = render(`<div id=target style="float:left;${style}">${content}</div>`);
    assert.equal(cssPixels(result.fragment("target").borderRect.width), expected);
  }
});

test("intrinsic whitespace, cross-span words, forced breaks, tabs and nowrap retain CSS semantics", () => {
  for (const [content, style, expected] of [
    ["<span>Home </span><span> Documentation </span>", "", 144],
    ["Home<br>Documentation", "", 104],
    ["Home\nDocumentation", "white-space:pre", 104],
    ["A\tB", "white-space:pre;tab-size:4", 40],
    ["<span>Home</span><span>Documentation</span>", "", 136],
    ["Home Documentation", "white-space:nowrap", 144],
  ]) {
    const result = render(`<div id=target style="float:left;${style}">${content}</div>`);
    assert.equal(cssPixels(result.fragment("target").borderRect.width), expected, content);
  }
  const min = render('<div style="display:grid;grid-template-columns:min-content"><div id=target><span>Home</span><span>Documentation</span></div></div>');
  assert.equal(cssPixels(min.fragment("target").borderRect.width), 136);
});

test("outside marker follows first content baseline without contributing principal width or height", () => {
  for (const content of ["First item begins here", "<p>First item begins here</p>", "<div><p>First item begins here</p></div>"]) {
    const result = render(`<ul><li id=target style="float:left">${content}</li></ul>`);
    const item = result.fragment("target");
    assert.equal(cssPixels(item.contentRect.width), 176);
    const texts = result.descendants(item.id).filter((value) => value.kind === "text");
    const marker = texts.find((value) => value.pseudoElement === "marker" && value.text.includes("•"));
    const contentText = texts.find((value) => value.pseudoElement === null);
    assert.ok(marker); assert.ok(contentText);
    assert.equal(marker.borderRect.y + marker.baseline, contentText.borderRect.y + contentText.baseline);
    assert.ok(marker.borderRect.x + marker.borderRect.width < contentText.borderRect.x);
    assert.equal(cssPixels(item.contentRect.height), 16);
  }
});

test("outside marker continuation alignment, RTL, nested and empty list fallback", () => {
  const result = render('<ul><li id=wrap style="width:80px">one two three four</li><li id=empty></li><li id=nested>outer<ul><li>inner</li></ul></li></ul><ul style="direction:rtl"><li id=rtl>RTL content</li></ul>');
  const wrap = result.fragment("wrap");
  const texts = result.descendants(wrap.id).filter((value) => value.kind === "text" && value.pseudoElement === null);
  assert.ok(texts.length > 1);
  for (const text of texts) assert.equal(text.borderRect.x, wrap.contentRect.x);
  assert.equal(cssPixels(result.fragment("empty").contentRect.height), 16);
  const rtl = result.fragment("rtl");
  const marker = result.descendants(rtl.id).find((value) => value.kind === "text" && value.text.includes("•"));
  assert.ok(marker.borderRect.x >= rtl.contentRect.x + rtl.contentRect.width);
  const nestedMarkers = result.descendants(result.fragment("nested").id).filter((value) => value.kind === "text" && value.text.includes("•"));
  assert.equal(nestedMarkers.length, 2);
  assert.notEqual(nestedMarkers[0].borderRect.x, nestedMarkers[1].borderRect.x);
});

test("inside markers enter flow, custom content gets no synthetic suffix, and none stays empty", () => {
  const result = render('<style>#custom::marker{content:"X"} #none::marker{content:none}</style><ul><li id=inside style="list-style-position:inside;float:left">Hi</li><li id=custom style="list-style-position:inside;float:left">Hi</li><li id=none style="float:left">Hi</li></ul>');
  assert.equal(cssPixels(result.fragment("inside").contentRect.width), 32);
  assert.equal(cssPixels(result.fragment("custom").contentRect.width), 24);
  assert.equal(cssPixels(result.fragment("none").contentRect.width), 16);
});

test("outside marker font baseline and scroll attachment follow principal border, not local contents", () => {
  const result = render('<style>#target::marker{font-size:32px}</style><div id=outer style="height:64px;overflow:auto"><ul><li id=target style="height:16px;width:80px;overflow:auto"><p>first line</p><p style="height:80px">later</p></li></ul><div style="height:160px"></div></div>');
  const item = result.fragment("target");
  const texts = result.descendants(item.id).filter((value) => value.kind === "text");
  const marker = texts.find((value) => value.pseudoElement === "marker" && value.text.includes("•"));
  const content = texts.find((value) => value.pseudoElement === null && value.text.startsWith("first"));
  assert.equal(marker.borderRect.y + marker.baseline, content.borderRect.y + content.baseline);
  assert.equal(result.layout.scrollAncestor(marker.id)?.documentNode, result.document.elementById("outer"));
  assert.equal(result.layout.scrollAncestor(content.id)?.documentNode, result.document.elementById("target"));
  assert.equal(result.layout.scrollContainer(item.id).maxInline, 0);
});

test("outside marker retains source identity and logical search order under budget exhaustion", () => {
  const result = render('<style>li::marker{content:"MARKER" / "spoken"}</style><ul><li id=target>body text</li></ul>');
  const marker = result.text("target").find((value) => value.pseudoElement === "marker");
  assert.equal(marker.documentNode, result.document.elementById("target"));
  const index = buildTextSearchIndex(result.formatting, result.inlineItemStreams);
  assert.equal(index.search("MARKER", 10).matches.length, 1);
  assert.equal(index.search("body text", 10).matches.length, 1);
  assert.equal(index.search("spoken", 10).matches.length, 0);
  assert.ok(index.text.indexOf("MARKER") < index.text.indexOf("body text"));
  const truncated = render('<ul><li>first</li><li>second</li><li>third</li></ul>', { maxLineBoxes: 1 });
  assert.equal(truncated.layout.outcome.status, "truncated");
});


test("signed inline margins, definite percentage edges, and flex content bases retain box ownership", () => {
  const negative = render('<div id=target style="float:left"><span style="margin-left:-8px">Home</span></div>');
  assert.equal(cssPixels(negative.fragment("target").borderRect.width), 24);
  const percentage = render('<div style="width:200px"><div id=target style="float:left;padding:0 10%">Home</div></div>');
  assert.equal(cssPixels(percentage.fragment("target").borderRect.width), 72);
  const flex = render('<div style="display:flex;width:200px"><div id=target style="flex:0 0 content;width:80px;box-sizing:border-box;padding:0 10px">Home</div></div>');
  assert.equal(cssPixels(flex.fragment("target").contentRect.width), 32);
  assert.equal(cssPixels(flex.fragment("target").borderRect.width), 52);
});

test("intrinsic block selection respects actual word breaks, forced breaks, nowrap and explicit child width", () => {
  for (const [content, style, expected] of [
    ["abcdefghijk", "", 16],
    ["aa bb cc", "", 48],
    ["aa bb cc", "white-space:nowrap", 16],
    ["aa<br>bb<br>cc", "", 48],
    ["<span>aa </span><span>bb </span><span>cc</span>", "", 48],
  ]) {
    const result = render(`<div style="display:flex;flex-direction:column;width:32px"><div id=target style="${style}">${content}</div></div>`);
    assert.equal(cssPixels(result.fragment("target").contentRect.height), expected, content + style);
  }
  const explicit = render('<div style="display:flex;flex-direction:column;width:200px"><div id=target style="width:32px">aa bb cc</div></div>');
  assert.equal(cssPixels(explicit.fragment("target").contentRect.height), 48);
});

test("inline list items use the same final first-line marker placement without changing adjacent flow", () => {
  const result = render('<div style="padding:32px"><div id=target style="display:inline list-item">hello world</div><span id=after> after</span></div>');
  const item = result.fragment("target");
  const children = result.descendants(item.id).filter((value) => value.kind === "text");
  const marker = children.find((value) => value.pseudoElement === "marker" && value.text.includes("•"));
  const text = children.find((value) => value.pseudoElement === null);
  assert.equal(marker.borderRect.y + marker.baseline, text.borderRect.y + text.baseline);
  assert.equal(cssPixels(item.contentRect.width), 88);
  assert.equal(result.fragment("after").contentRect.x, item.contentRect.x + item.contentRect.width);
});

test("intrinsic cache exhaustion stays typed during nested box contribution traversal", () => {
  const result = render('<div style="float:left"><div><span>one</span><span>two</span></div></div>', { maxIntrinsicContributionCacheEntries: 0 });
  assert.equal(result.layout.outcome.status, "truncated");
  assert.equal(result.layout.outcome.budget, "maxIntrinsicContributionCacheEntries");
});


test("outside marker aligns finalized line-height leading instead of stale pre-line baseline", () => {
  const result = render('<ul style="font-size:14px;line-height:1.5"><li id=target><p>First content line</p></li></ul>');
  const texts = result.descendants(result.fragment("target").id).filter((value) => value.kind === "text");
  const marker = texts.find((value) => value.pseudoElement === "marker" && value.text.includes("•"));
  const content = texts.find((value) => value.pseudoElement === null);
  assert.equal(marker.borderRect.y + marker.baseline, content.borderRect.y + content.baseline);
  assert.equal(marker.borderRect.y, content.borderRect.y);
});

test("SQLite menu declaration combines ex resolution with canonical floated descendant padding", () => {
  const result = render('<style>.menu ul{margin:0;padding:0;list-style:none}.menu li{float:left}.menu ul li a{display:block;padding:0.7ex 1.4ex}</style><div class=menu><ul><li><a id=home href=/home>Home</a></li><li><a id=docs href=/docs>Documentation</a></li></ul></div>');
  const home = result.fragment("home"), docs = result.fragment("docs");
  assert.equal(home.borderRect.width, cssPx(32) + cssMultiply(cssPx(8), 1.4) * 2);
  assert.equal(docs.borderRect.x, home.borderRect.x + home.borderRect.width);
  assert.equal(result.styles.diagnostics.length, 0);
});


test("anonymous flex and grid text items do not inherit their container's box properties", () => {
  for (const display of ["display:flex", "display:grid;grid-template-columns:max-content max-content"]) {
    const result = render(`<div style="${display};width:200px;padding:0 14px">Home<span id=second>Docs</span></div>`);
    assert.equal(cssPixels(result.fragment("second").borderRect.x), 46, display);
  }
  const margin = render('<div id=target style="display:inline-flex"><span style="margin:0 5px;padding:0 3px">Home</span></div>');
  assert.equal(cssPixels(margin.fragment("target").borderRect.width), 48);
});


test("blockified atomic boxes do not acquire a surrounding inline strut", () => {
  for (const context of ["display:grid", "display:flex", "display:block"]) {
    const result = render(`<div style="${context}"><img id=target style="display:block" width=20 height=10 alt=photo></div>`);
    const fragment = result.layout.forDocumentNode(result.document.elementById("target")).find((value) => value.kind === "replaced");
    assert.equal(cssPixels(fragment.borderRect.y), 0, context);
    assert.equal(cssPixels(fragment.borderRect.height), 10, context);
  }
  for (const position of ["float:left", "position:absolute;top:0", "position:fixed;top:0"]) {
    const result = render(`<img id=target style="${position}" width=20 height=10 alt=photo>`);
    const fragment = result.layout.forDocumentNode(result.document.elementById("target")).find((value) => value.kind === "replaced");
    assert.equal(cssPixels(fragment.borderRect.y), 0, position);
  }
  const margin = render('<div style="padding-top:8px"><img id=target style="display:block;margin-top:10px" width=20 height=10 alt=photo></div>');
  const fragment = margin.layout.forDocumentNode(margin.document.elementById("target")).find((value) => value.kind === "replaced");
  assert.equal(cssPixels(fragment.borderRect.y), 18, "block margin is applied once before its border-box origin");
});
