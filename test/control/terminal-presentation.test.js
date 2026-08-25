import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { resolveStyles } from "../../dist/presentation/style/index.js";
import { buildFragmentTree } from "../../dist/presentation/terminal/index.js";
import { terminalTextMeasurer } from "../../dist/ui/terminal-measure.js";

const profile = {
  cellWidthPx: 8,
  rowHeightPx: 16,
  colorDepth: 24,
  unicode: true,
  ambiguousWidth: 1
};

function formatting(html) {
  const document = parseWebDocument(html, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const state = createDocumentState(document);
  const styles = resolveStyles({
    document,
    state,
    resources: [],
    environment: {
      viewportWidthPx: 640,
      viewportHeightPx: 400,
      mediaType: "screen",
      prefersColorScheme: "dark",
      reducedMotion: true
    }
  });
  return buildFormattingTree({ document, state, styles });
}

function fragments(tree, columns, rows = 24) {
  return buildFragmentTree({
    formatting: tree,
    viewport: { columns, rows },
    measurer: terminalTextMeasurer(),
    profile
  });
}

function nodesByKind(tree, kind) {
  const result = [];
  const pending = [tree.root];
  while (pending.length > 0) {
    const id = pending.shift();
    const node = tree.node(id);
    if (node.kind === kind) result.push(node);
    pending.push(...node.children);
  }
  return result;
}

test("fragment identities survive resize while text source ranges track wrapping", () => {
  const tree = formatting("<main><p>alpha beta gamma delta epsilon</p></main>");
  const wide = fragments(tree, 40);
  const narrow = fragments(tree, 10);
  const wideText = wide.rows.flatMap((row) => row.fragments).filter((entry) => entry.sourceRange !== null);
  const narrowText = narrow.rows.flatMap((row) => row.fragments).filter((entry) => entry.sourceRange !== null);
  assert.equal(wide.root, narrow.root);
  assert.ok(narrow.rows.length > wide.rows.length);
  assert.equal(narrowText[0].source, wideText[0].source);
  for (let index = 1; index < narrowText.length; index += 1) {
    assert.ok(narrowText[index].sourceRange.start >= narrowText[index - 1].sourceRange.start);
  }
});

test("fragment snapshots freeze nested geometry, rows, actions, and search results", () => {
  const tree = formatting("<p><a href='/next'>immutable link</a></p>");
  const layout = fragments(tree, 30);
  const fragment = layout.fragment(layout.root);
  const rowFragment = layout.rows.flatMap((row) => row.fragments)[0];
  const hit = layout.hitRegions[0];
  const result = layout.search("link");

  assert.equal(Object.isFrozen(layout), true);
  assert.equal(Object.isFrozen(layout.viewport), true);
  assert.equal(Object.isFrozen(layout.profile), true);
  assert.equal(Object.isFrozen(fragment), true);
  assert.equal(Object.isFrozen(fragment.rect), true);
  assert.equal(Object.isFrozen(fragment.clip), true);
  assert.equal(Object.isFrozen(layout.rows), true);
  assert.equal(Object.isFrozen(layout.rows[0]), true);
  assert.equal(Object.isFrozen(rowFragment), true);
  assert.equal(Object.isFrozen(hit), true);
  assert.equal(Object.isFrozen(hit.action), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.matches), true);
  assert.equal(Object.isFrozen(result.matches[0]), true);
  assert.equal(Object.isFrozen(result.matches[0].ranges), true);
  assert.equal(Object.isFrozen(result.ranges), true);
  assert.equal(Object.isFrozen(result.ranges[0]), true);
  const sourceRange = result.ranges[0]?.sourceRange;
  assert.ok(sourceRange);
  assert.equal(tree.document.sourceText.slice(sourceRange.start, sourceRange.end), "link");
  assert.equal(layout.search("link"), result);
});

test("invalid runtime terminal profiles produce typed rejected fragment trees", () => {
  const tree = formatting("<p>Text</p>");
  const layout = buildFragmentTree({
    formatting: tree,
    viewport: { columns: 30, rows: 10 },
    measurer: terminalTextMeasurer(),
    profile: { ...profile, ambiguousWidth: 3 }
  });
  assert.deepEqual(layout.outcome, { status: "rejected", reason: "invalid-profile" });
  assert.equal(layout.rows.length, 0);
  assert.equal(Object.isFrozen(layout.viewport), true);
});

test("search keeps one stable match with source-linked slices across adjacent inline nodes", () => {
  const tree = formatting("<p>hel<span>lo</span></p>");
  const result = fragments(tree, 30).search("hello");
  assert.equal(result.matches.length, 1);
  assert.equal(result.ranges.length, 2);
  assert.equal(new Set(result.ranges.map((range) => range.match)).size, 1);
  assert.ok(result.ranges.every((range) => range.source !== null && range.sourceRange !== null));
  assert.equal(result.ranges.map((range) =>
    tree.document.sourceText.slice(range.sourceRange.start, range.sourceRange.end)
  ).join(""), "hello");
});

test("visible-text matches span terminal wraps and keep their identity across resize", () => {
  const tree = formatting("<p>alpha beta gamma delta</p>");
  const narrow = fragments(tree, 8).search("beta gamma");
  const wide = fragments(tree, 40).search("beta gamma");
  assert.equal(narrow.matches.length, 1);
  assert.equal(wide.matches.length, 1);
  assert.equal(narrow.matches[0].id, wide.matches[0].id);
  assert.ok(new Set(narrow.matches[0].ranges.map((range) => range.row)).size > 1);
  assert.equal(new Set(wide.matches[0].ranges.map((range) => range.row)).size, 1);
});

test("collapsible whitespace is shared across adjacent inline source nodes", () => {
  const tree = formatting("<p>alpha <span>  beta</span>\n<strong> gamma</strong></p>");
  const row = fragments(tree, 40).rows.find((entry) => entry.text.includes("alpha"));
  assert.ok(row);
  assert.equal(row.text.trim(), "alpha beta gamma");
});

test("preformatted whitespace remains a terminal-layout concern and is preserved", () => {
  const layout = fragments(formatting("<pre>a  b\n c</pre>"), 40);
  assert.ok(layout.rows.some((row) => row.text === "a  b"));
  assert.ok(layout.rows.some((row) => row.text === " c"));
});

test("terminal used values apply text alignment, indentation, and automatic inline margins", () => {
  const aligned = fragments(formatting(`<p style="width:10ch;text-align:right;text-indent:2ch">x</p>`), 20);
  const alignedRow = aligned.rows.find((row) => row.text.includes("x"));
  assert.ok(alignedRow);
  assert.equal(alignedRow.fragments.find((entry) => entry.source !== null)?.column, 9);

  const centeredTree = formatting(`<div id="centered" style="width:10ch;margin-inline:auto">centered</div>`);
  const centeredSource = centeredTree.document.elementById("centered");
  assert.ok(centeredSource);
  const centered = fragments(centeredTree, 20);
  assert.equal(centered.forSource(centeredSource).find((fragment) => fragment.kind === "container")?.rect.column, 5);
});

test("row flex layout resolves wrapping, justification, gaps, and cross-axis alignment", () => {
  const tree = formatting(`<style>
    .flex { display:flex; width:7ch; column-gap:1ch; row-gap:1em; flex-wrap:wrap;
      justify-content:end; align-items:center }
    .item { display:block; width:3ch }
    .tall { height:3em }
  </style><div class="flex"><span class="item tall">A</span><span class="item">B</span><span class="item">C</span></div>`);
  const layout = fragments(tree, 20);
  const output = layout.rows.map((row) => row.text);
  assert.equal(output[0]?.indexOf("A"), 0);
  assert.equal(output[1]?.indexOf("B"), 4);
  assert.equal(output[4]?.indexOf("C"), 4);
});

test("column flex layout resolves main-axis justification and cross-axis alignment", () => {
  const tree = formatting(`<style>
    .flex { display:flex; flex-direction:column; width:10ch; height:5em;
      justify-content:space-between; align-items:end }
    .item { display:block; width:2ch }
  </style><div class="flex"><span class="item">A</span><span class="item">B</span></div>`);
  const layout = fragments(tree, 20);
  const output = layout.rows.map((row) => row.text);
  assert.equal(output[0]?.indexOf("A"), 8);
  assert.equal(output[4]?.indexOf("B"), 8);
});

test("case transformation expansion maps wrapped output to original source", () => {
  const tree = formatting("<style>p{text-transform:uppercase}</style><p>aßb</p>");
  const layout = fragments(tree, 1);
  const textFragments = layout.rows.flatMap((row) => row.fragments)
    .filter((entry) => entry.sourceRange !== null && layout.fragment(entry.fragment).kind === "text");
  assert.equal(layout.rows.map((row) => row.text).join(""), "ASSB");
  assert.deepEqual(
    textFragments.map((entry) => tree.document.sourceText.slice(entry.sourceRange.start, entry.sourceRange.end)),
    ["a", "ß", "ß", "b"]
  );
});

test("Unicode graphemes use terminal cells without splitting clusters", () => {
  const tree = formatting("<p>A 👩🏽‍💻 é 界 Z</p>");
  const layout = fragments(tree, 8);
  const output = layout.rows.map((row) => row.text).join("\n");
  assert.match(output, /👩🏽‍💻/u);
  assert.match(output, /é/u);
  assert.ok(layout.rows.every((row) => row.fragments.every((entry) => entry.width >= 1)));
});

test("visibility keeps layout participation without paint, hits, search, or accessibility", () => {
  const tree = formatting("<p><a style='visibility:hidden' href='/secret'>Secret</a><span>Visible</span></p>");
  const layout = fragments(tree, 30);
  assert.doesNotMatch(layout.rows.map((row) => row.text).join("\n"), /Secret/u);
  assert.equal(layout.search("Secret").ranges.length, 0);
  assert.equal(layout.focusTargets.length, 0);
  assert.ok(layout.rows.some((row) => row.text.includes("      Visible")));
});

test("the supported visually-clipped pattern leaves terminal paint and hit geometry", () => {
  const tree = formatting(`<style>.screen-reader {
    position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%)
  }</style><a class="screen-reader" href="#main">Skip to main</a><main id="main">Visible</main>`);
  const layout = fragments(tree, 30);
  assert.doesNotMatch(layout.rows.map((row) => row.text).join("\n"), /Skip to main/u);
  assert.equal(layout.search("Skip to main").ranges.length, 0);
  assert.equal(layout.hitRegions.some((entry) => entry.action.kind === "link"), false);
  assert.ok(layout.accessibility.some((entry) => entry.role === "link" && entry.name === "Skip to main"));
});

test("aria-hidden content remains visual but leaves the accessibility projection", () => {
  const tree = formatting(`<p aria-hidden="true">Visible prose <a href="/next">and link</a></p>`);
  const layout = fragments(tree, 30);
  assert.match(layout.rows.map((row) => row.text).join("\n"), /Visible prose and link/u);
  const hiddenSources = new Set();
  const pending = [tree.document.body];
  while (pending.length > 0) {
    const ref = pending.pop();
    const node = tree.document.node(ref);
    if (node.kind === "element" && tree.document.attribute(ref, "aria-hidden") === "true") {
      const descendants = [ref];
      while (descendants.length > 0) {
        const descendant = descendants.pop();
        hiddenSources.add(descendant);
        descendants.push(...tree.document.node(descendant).children);
      }
    }
    pending.push(...node.children);
  }
  assert.ok(layout.accessibility.every((entry) => !hiddenSources.has(entry.source)));
});

test("display contents removes the box without removing semantic accessibility identity", () => {
  const tree = formatting(`<p><a href="/next" style="display:contents">Semantic link</a></p>`);
  const layout = fragments(tree, 30);
  const link = tree.document.links[0];
  assert.ok(link);
  assert.equal(tree.document.semantic(link.node)?.role, "link");
  assert.equal(tree.forSource(link.node).length, 0);
  const accessible = layout.accessibility.find((entry) => entry.source === link.node);
  assert.equal(accessible?.role, "link");
  assert.equal(accessible?.name, "Semantic link");
  assert.ok(accessible && accessible.rect.width > 0);
  assert.ok(layout.focusTargets.some((entry) => entry.node === link.node));
});

test("accessibility semantics belong to one principal formatting box per source", () => {
  const tree = formatting(`<style>li::before{content:"prefix"}</style>
    <main><ul><li>item</li></ul><table><tr><td>cell</td></tr></table></main>`);
  const layout = fragments(tree, 30);
  const sources = layout.accessibility.map((entry) => entry.source);
  assert.equal(new Set(sources).size, sources.length);
  assert.equal(layout.accessibility.filter((entry) => entry.role === "listitem").length, 1);
  assert.equal(layout.accessibility.filter((entry) => entry.role === "table").length, 1);
});

test("details summaries expose typed focus and pointer actions", () => {
  const tree = formatting(`<details><summary>More</summary><p>Secret</p></details>`);
  const layout = fragments(tree, 20);
  const disclosure = tree.document.disclosures[0];
  assert.ok(disclosure);
  const focus = layout.focusTargets.find((entry) => entry.node === disclosure.node);
  assert.deepEqual(focus?.action, { kind: "disclosure", node: disclosure.node, open: false });
  assert.equal(focus?.label.trim(), "More");
  assert.ok(layout.hitRegions.some((entry) => entry.action.node === disclosure.node));
  assert.doesNotMatch(layout.rows.map((row) => row.text).join("\n"), /Secret/u);
});

test("link action geometry spans wrapped fragments and pointer hit testing is structural", () => {
  const tree = formatting("<p><a href='/next'>a deliberately long actionable link label</a></p>");
  const layout = fragments(tree, 12);
  assert.equal(layout.focusTargets.length, 1);
  assert.equal(layout.focusTargets[0].action.kind, "link");
  assert.ok(layout.focusTargets[0].rects.length > 1);
  for (const rect of layout.focusTargets[0].rects) {
    assert.equal(layout.hitTest(rect.row, rect.column)?.action.node, layout.focusTargets[0].node);
  }
});

test("wrapped link hit geometry excludes blank cells inside a fragment union", () => {
  const tree = formatting(`<p><a href="/wrapped">alpha be gamma</a></p>`);
  const layout = fragments(tree, 6);
  const link = tree.document.links[0];
  assert.ok(link);
  const union = layout.forSource(link.node)
    .find((fragment) => fragment.kind === "container" && fragment.rect.height > 1);
  assert.ok(union);
  const actionable = layout.hitRegions.filter((entry) => entry.action.node === link.node);
  assert.ok(actionable.length > 1);
  assert.ok(actionable.every((entry) => entry.rect.height === 1));
  let blankCell = null;
  for (let row = union.rect.row; row < union.rect.row + union.rect.height && blankCell === null; row += 1) {
    for (let column = union.rect.column; column < union.rect.column + union.rect.width; column += 1) {
      if (!actionable.some((entry) => row >= entry.rect.row && row < entry.rect.row + entry.rect.height
        && column >= entry.rect.column && column < entry.rect.column + entry.rect.width)) {
        blankCell = { row, column };
        break;
      }
    }
  }
  assert.ok(blankCell);
  assert.equal(layout.hitTest(blankCell.row, blankCell.column), null);
});

test("search ranges retain fragment and document source identities", () => {
  const tree = formatting("<main><p>first needle and second needle</p></main>");
  const layout = fragments(tree, 16);
  const result = layout.search("needle");
  assert.equal(result.ranges.length, 2);
  assert.ok(result.ranges.every((range) => range.fragment !== null && range.source !== null && range.sourceRange !== null));
});

test("case-insensitive search maps case-fold expansion to row code units", () => {
  const tree = formatting("<p>İstanbul</p>");
  const layout = fragments(tree, 20);
  const result = layout.search("STAN");
  assert.equal(result.ranges.length, 1);
  const range = result.ranges[0];
  assert.equal(layout.rows[range.row].text.slice(range.startCodeUnit, range.endCodeUnit), "stan");
});

test("structured tables, controls, clipping, and accessibility retain nested geometry", () => {
  const tree = formatting(`<style>.clip {overflow:hidden;width:12ch}</style><div class="clip">
    <table><colgroup><col><col></colgroup><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></table>
    <form aria-label="Lookup"><label for="q">Query</label><input id="q" name="q"></form>
  </div>`);
  const layout = fragments(tree, 40);
  const cellFragments = layout.formatting.document
    .children(layout.formatting.document.body)
    .flatMap((node) => layout.forSource(node.ref));
  assert.ok(layout.rows.some((row) => row.text.includes("Name") && row.text.includes("Value")));
  assert.ok(layout.focusTargets.some((target) => target.action.kind === "form-control"));
  assert.ok(layout.accessibility.some((entry) => entry.role === "table"));
  const column = nodesByKind(layout.formatting, "table-column")[0];
  assert.ok(column);
  assert.ok(layout.forSource(column.source).every((fragment) => fragment.rect.height === 0));
  assert.ok([...cellFragments, layout.fragment(layout.root)].every((fragment) => fragment.clip.width <= 40));
});

test("nested overflow clips paint, action hits, and accessibility geometry", () => {
  const tree = formatting(`<style>
    .clip { width:5ch; height:1em; overflow:hidden }
    a { white-space:nowrap }
  </style><div class="clip"><a href="/next">abcdefghij</a><p>second row</p></div>`);
  const layout = fragments(tree, 20);
  assert.match(layout.rows[0].text, /^abcde$/u);
  assert.ok(layout.rows.slice(1).every((row) => !row.text.includes("second row")));
  assert.equal(layout.hitTest(0, 4)?.action.kind, "link");
  assert.equal(layout.hitTest(0, 5), null);
  const link = tree.document.links[0];
  assert.ok(layout.accessibility
    .filter((entry) => entry.source === link.node)
    .every((entry) => entry.rect.width <= 5 && entry.rect.height <= 1));
});

test("an inner table cannot change its containing table's column measure", () => {
  const tree = formatting(`<table><tr><td><table><tr>
    <td>a</td><td>b</td><td>c</td><td>d</td><td>e</td>
  </tr></table></td><td>OUTER</td></tr></table>`);
  const layout = fragments(tree, 20);
  const outerRow = layout.rows.find((row) => row.text.includes("OUTER"));
  assert.ok(outerRow);
  assert.ok(outerRow.text.indexOf("OUTER") >= 9);
});

test("solid CSS borders become terminal paint around content-box dimensions", () => {
  const tree = formatting(`<style>.box{border:solid 1px #ff0000;width:6ch}</style><div class="box">body</div>`);
  const layout = fragments(tree, 20);
  const painted = layout.rows.map((row) => row.text);
  assert.ok(painted.some((row) => row.includes("┌──────┐")));
  assert.ok(painted.some((row) => row.includes("│body  │")));
  assert.ok(painted.some((row) => row.includes("└──────┘")));
});

test("generated pseudo-element boxes own their terminal box geometry", () => {
  const tree = formatting(`<style>
    p::before{content:"prefix";display:block;width:6ch;border:solid 1px}
  </style><p>body</p>`);
  const painted = fragments(tree, 20).rows.map((row) => row.text);
  assert.ok(painted.some((row) => row.includes("┌──────┐")));
  assert.ok(painted.some((row) => row.includes("│prefix│")));
  assert.ok(painted.some((row) => row.includes("└──────┘")));
});

test("ancestor text decoration propagates to descendant text paint", () => {
  const tree = formatting(`<p style="text-decoration:underline"><span>decorated</span></p>`);
  const layout = fragments(tree, 20);
  const run = layout.rows.flatMap((row) => row.styles).find((entry) => entry.endCodeUnit > entry.startCodeUnit);
  assert.equal(run?.style.underline, true);
});

test("viewport lengths convert through terminal pixel geometry on either axis", () => {
  const tree = formatting(`<style>.box{width:10vh;height:10vw}</style><div class="box">x</div>`);
  const layout = fragments(tree, 20, 10);
  const div = (() => {
    const pending = [tree.document.root];
    while (pending.length > 0) {
      const ref = pending.pop();
      const node = tree.document.node(ref);
      if (node.kind === "element" && tree.document.attribute(ref, "class") === "box") return ref;
      pending.push(...node.children);
    }
    throw new Error("Missing box");
  })();
  const box = layout.forSource(div).find((fragment) => fragment.rect.width > 0);
  assert.equal(box?.rect.width, 2);
  assert.equal(box?.rect.height, 1);
});

test("grid rows share a row origin and resolve typed track widths", () => {
  const tree = formatting(`<style>.grid{display:grid;grid-template-columns:1fr 2fr;gap:1ch}</style>
    <div class="grid"><span>one</span><span>two</span><span>three wraps here</span><span>four</span></div>`);
  const layout = fragments(tree, 18);
  const items = nodesByKind(layout.formatting, "grid-item");
  const itemFragments = items.map((item) => {
    const pending = [layout.root];
    while (pending.length > 0) {
      const fragment = layout.fragment(pending.shift());
      if (fragment.formatting === item.id) return fragment;
      pending.push(...fragment.children);
    }
    throw new Error("Missing grid item fragment");
  });
  assert.equal(itemFragments[0].rect.row, itemFragments[1].rect.row);
  assert.equal(itemFragments[2].rect.row, itemFragments[3].rect.row);
  assert.ok(itemFragments[1].rect.width > itemFragments[0].rect.width);
});

test("inline grid keeps outer inline participation and its inner grid context", () => {
  const tree = formatting(`<style>.grid{display:inline-grid;width:8ch;grid-template-columns:1fr 1fr}</style>
    <p>before <span class="grid"><b>one</b><b>two</b></span> after</p>`);
  const layout = fragments(tree, 30);
  const items = nodesByKind(layout.formatting, "grid-item");
  const itemFragments = items.map((item) => {
    const pending = [layout.root];
    while (pending.length > 0) {
      const candidate = layout.fragment(pending.pop());
      if (candidate.formatting === item.id) return candidate;
      pending.push(...candidate.children);
    }
    throw new Error("Missing inline-grid item fragment");
  });
  assert.equal(itemFragments[0].rect.row, itemFragments[1].rect.row);
  assert.ok(itemFragments[1].rect.column > itemFragments[0].rect.column);
  assert.ok(layout.rows.some((row) => row.text.includes("before") && row.text.includes("one") && row.text.includes("two")));
});

test("anonymous grid items do not duplicate principal box styles and retain item placement", () => {
  const tree = formatting(`<style>
    .grid{display:grid;width:8ch;padding:1ch;border:solid 1px;grid-template-columns:1fr 1fr}
    .second{grid-column:2}
  </style><div class="grid"><span class="second">B</span></div>`);
  const layout = fragments(tree, 20);
  const painted = layout.rows.map((row) => row.text);
  assert.equal(painted.filter((row) => row.includes("┌")).length, 1);
  assert.equal(painted.filter((row) => row.includes("└")).length, 1);
  const targets = new Set(nodesByKind(layout.formatting, "grid-container")
    .concat(nodesByKind(layout.formatting, "grid-item")).map((node) => node.id));
  const found = new Map();
  const pending = [layout.root];
  while (pending.length > 0) {
    const fragment = layout.fragment(pending.pop());
    if (targets.has(fragment.formatting)) found.set(layout.formatting.node(fragment.formatting).kind, fragment);
    pending.push(...fragment.children);
  }
  assert.ok(found.get("grid-item").rect.column >= found.get("grid-container").rect.column + 6);
});

test("terminal row projection lets later paint order win overlapping cells", () => {
  const tree = formatting(`<style>
    .grid { display:grid; width:4ch; grid-template-columns:4ch 4ch }
    .first, .second { grid-column:1 }
  </style><div class="grid"><span class="first">AAAA</span><span class="second">BBBB</span></div>`);
  const layout = fragments(tree, 20);
  assert.equal(layout.rows[0]?.text, "BBBB");
  assert.equal(layout.rows[0]?.fragments.length, 1);
});

test("recorded common-page fixtures traverse the structural fragment path", () => {
  const article = readFileSync(new URL("../fixtures/pages/article-form.html", import.meta.url), "utf8");
  const articleLayout = fragments(formatting(article), 72);
  assert.match(articleLayout.rows.map((row) => row.text).join("\n"), /A practical terminal article/u);
  assert.ok(articleLayout.focusTargets.some((entry) => entry.action.kind === "form-control"));
  const navigation = articleLayout.formatting.document.landmarks.find((entry) => entry.landmark === "navigation");
  assert.ok(navigation && articleLayout.accessibility.some((entry) => entry.source === navigation.node));

  const dashboard = readFileSync(new URL("../fixtures/pages/dashboard-table.html", import.meta.url), "utf8");
  const dashboardTree = formatting(dashboard);
  const dashboardLayout = fragments(dashboardTree, 72);
  assert.ok(nodesByKind(dashboardTree, "table-cell").length >= 6);
  assert.ok(nodesByKind(dashboardTree, "grid-container").length >= 1);
  assert.match(dashboardLayout.rows.map((row) => row.text).join("\n"), /Auto refresh/u);
});

test("fragment work budgets fail with a typed truncation", () => {
  const tree = formatting(`<div>${"<span>word </span>".repeat(100)}</div>`);
  const layout = buildFragmentTree({
    formatting: tree,
    viewport: { columns: 20, rows: 10 },
    measurer: terminalTextMeasurer(),
    profile,
    budgets: { maxPaintCells: 25 }
  });
  assert.equal(layout.outcome.status, "truncated");
  assert.equal(layout.outcome.budget, "maxPaintCells");
  assert.match(layout.rows.map((row) => row.text).join("\n"), /^word word/u);
});

test("row exhaustion finalizes ancestors without clearing completed rows", () => {
  const tree = formatting("<pre>first\nsecond\nthird</pre>");
  const layout = buildFragmentTree({
    formatting: tree,
    viewport: { columns: 20, rows: 3 },
    measurer: terminalTextMeasurer(),
    profile,
    budgets: { maxRows: 3 }
  });
  assert.equal(layout.outcome.status, "truncated");
  assert.equal(layout.outcome.budget, "maxRows");
  assert.deepEqual(layout.rows.map((row) => row.text), ["", "first", "second"]);
  assert.ok(layout.children(layout.root).length > 0);
});

test("atomic controls consume the same paint-cell budget as text", () => {
  const tree = formatting("<form><label for='q'>Query</label><input id='q' name='q' value='long'></form>");
  const layout = buildFragmentTree({
    formatting: tree,
    viewport: { columns: 20, rows: 10 },
    measurer: terminalTextMeasurer(),
    profile,
    budgets: { maxPaintCells: 1 }
  });
  assert.equal(layout.outcome.status, "truncated");
  assert.equal(layout.outcome.budget, "maxPaintCells");
  assert.ok(layout.rows.every((row) => !row.text.includes("Query: long")));
});

test("fragment count exhaustion retains the completed authoritative prefix", () => {
  const tree = formatting(`<div>${"<span>word </span>".repeat(20)}</div>`);
  const layout = buildFragmentTree({
    formatting: tree,
    viewport: { columns: 20, rows: 10 },
    measurer: terminalTextMeasurer(),
    profile,
    budgets: { maxFragments: 12 }
  });
  assert.equal(layout.outcome.status, "truncated");
  assert.equal(layout.outcome.budget, "maxFragments");
  assert.equal(layout.outcome.fragments, 12);
  assert.ok(layout.children(layout.root).length > 0);
  assert.match(layout.rows.map((row) => row.text).join("\n"), /^word word/u);
});
