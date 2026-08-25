import assert from "node:assert/strict";
import test from "node:test";

import { createDocumentState, parseWebDocument } from "../../dist/document/index.js";
import { buildFormattingTree } from "../../dist/presentation/formatting/index.js";
import { resolveStyles } from "../../dist/presentation/style/index.js";

const environment = {
  viewportWidthPx: 800,
  viewportHeightPx: 600,
  mediaType: "screen",
  prefersColorScheme: "dark",
  reducedMotion: true
};

function formatted(html, budgets, styleBudgets) {
  const document = parseWebDocument(html, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  const state = createDocumentState(document);
  const styles = resolveStyles({
    document,
    state,
    resources: [],
    environment,
    ...(styleBudgets ? { budgets: styleBudgets } : {})
  });
  const formatting = buildFormattingTree({ document, state, styles, ...(budgets ? { budgets } : {}) });
  return { document, state, styles, formatting };
}

function nodes(tree) {
  const output = [];
  const pending = [tree.root];
  while (pending.length > 0) {
    const id = pending.shift();
    const node = tree.node(id);
    output.push(node);
    pending.push(...node.children);
  }
  return output;
}

function sourceNamed(document, name) {
  const pending = [document.root];
  while (pending.length > 0) {
    const ref = pending.shift();
    const node = document.node(ref);
    if (node.kind === "element" && node.name === name) return node.ref;
    pending.push(...node.children);
  }
  throw new Error(`Missing ${name}`);
}

function subtreeShape(tree, id) {
  const node = tree.node(id);
  const source = node.source === null ? null : tree.document.node(node.source);
  return {
    kind: node.kind,
    source: source?.kind === "element" ? source.name : source?.kind === "text" ? "#text" : null,
    ...("text" in node ? { text: node.text } : {}),
    children: node.children.map((child) => subtreeShape(tree, child))
  };
}

function structuralShape(tree, id) {
  const node = tree.node(id);
  return [
    node.kind,
    ...("text" in node ? [node.text] : []),
    ...node.children.map((child) => structuralShape(tree, child))
  ];
}

function principalShape(document, tree, name) {
  const source = sourceNamed(document, name);
  const node = tree.forSource(source).find((candidate) => candidate.appliesBoxStyle && candidate.pseudo === null);
  assert.ok(node, `Missing principal formatting box for ${name}`);
  return subtreeShape(tree, node.id);
}

test("box generation follows computed display rather than HTML tag names", () => {
  const { document, formatting } = formatted(`<style>span { display:block } div { display:inline }</style>
    <main><span>Block span</span><div>Inline div</div></main>`);
  assert.equal(formatting.forSource(sourceNamed(document, "span"))[0]?.kind, "block-container");
  assert.equal(formatting.forSource(sourceNamed(document, "div"))[0]?.kind, "inline-container");
  assert.equal(document.semantic(sourceNamed(document, "div"))?.role, "generic");
});

test("display contents preserves descendants and display none emits no boxes", () => {
  const { document, formatting } = formatted(`<style>.contents {display:contents}.none {display:none}</style>
    <section class="contents"><strong>Visible</strong></section><section class="none"><em>Hidden</em></section>`);
  const contents = sourceNamed(document, "strong");
  const hidden = sourceNamed(document, "em");
  assert.ok(formatting.forSource(contents).length > 0);
  assert.equal(formatting.forSource(hidden).length, 0);
  assert.ok(formatting.suppressed.some((entry) => entry.source === document.parent(hidden)?.ref));
});

test("ARIA accessibility hiding does not masquerade as CSS box suppression", () => {
  const { document, formatting } = formatted(`<p aria-hidden="true"><span>Still painted</span></p>
    <p hidden><em>Actually hidden</em></p>`);
  assert.ok(formatting.forSource(sourceNamed(document, "span")).length > 0);
  assert.equal(formatting.forSource(sourceNamed(document, "em")).length, 0);
  assert.equal(document.semantic(sourceNamed(document, "span"))?.accessibilityHidden, true);
  assert.equal(document.semantic(sourceNamed(document, "p"))?.accessibilityHidden, true);
});

test("mixed inline and block children produce anonymous block structure", () => {
  const { formatting } = formatted("<div>before<span>inline</span><p>block</p>after</div>");
  const kinds = nodes(formatting).map((node) => node.kind);
  assert.ok(kinds.filter((kind) => kind === "anonymous-block").length >= 2);
  assert.ok(kinds.includes("anonymous-inline"));
});

test("nested inline boxes split into ordered continuations around block descendants", () => {
  const { document, formatting } = formatted("<div><span>A<em>B<section>C</section>D</em>E</span>F</div>");
  assert.deepEqual(principalShape(document, formatting, "div"), {
    kind: "block-container",
    source: "div",
    children: [
      {
        kind: "anonymous-block", source: null, children: [{
          kind: "anonymous-inline", source: null, children: [{
            kind: "inline-container", source: "span", children: [
              { kind: "text-sequence", source: "#text", text: "A", children: [] },
              { kind: "inline-container", source: "em", children: [
                { kind: "text-sequence", source: "#text", text: "B", children: [] }
              ] }
            ]
          }]
        }]
      },
      {
        kind: "block-container", source: "section", children: [
          { kind: "text-sequence", source: "#text", text: "C", children: [] }
        ]
      },
      {
        kind: "anonymous-block", source: null, children: [{
          kind: "anonymous-inline", source: null, children: [
            {
              kind: "inline-container", source: "span", children: [
                { kind: "inline-container", source: "em", children: [
                  { kind: "text-sequence", source: "#text", text: "D", children: [] }
                ] },
                { kind: "text-sequence", source: "#text", text: "E", children: [] }
              ]
            },
            { kind: "text-sequence", source: "#text", text: "F", children: [] }
          ]
        }]
      }
    ]
  });
});

test("generated pseudo boxes retain their computed display participation", () => {
  const { formatting } = formatted(`<style>p::before{content:"prefix";display:block;color:red}</style><p>body</p>`);
  const generated = nodes(formatting).find((node) => node.kind === "generated-text");
  const box = nodes(formatting).find((node) => node.kind === "pseudo-box");
  assert.ok(generated);
  assert.ok(box);
  assert.equal(box.outer, "block");
  assert.deepEqual(box.children, [generated.id]);
  assert.equal(formatting.styles.pseudo(generated.source, "before")?.text.color.r, 255);
});

test("lists generate marker boxes tied to their source item", () => {
  const { document, formatting } = formatted("<ol><li>One</li><li>Two</li></ol>");
  const items = nodes(formatting).filter((node) => node.kind === "list-item");
  const markers = nodes(formatting).filter((node) => node.kind === "marker");
  assert.equal(items.length, 2);
  assert.deepEqual(markers.map((node) => node.text), ["1.", "2."]);
  assert.deepEqual(markers.map((node) => node.source), document.children(sourceNamed(document, "ol")).map((node) => node.ref));
});

test("generated marker, before, and after boxes preserve their exact list-item order", () => {
  const { document, formatting } = formatted(`<style>
    li::marker{content:"M"}li::before{content:"B"}li::after{content:"A"}
  </style><ol><li>body</li></ol>`);
  const shape = principalShape(document, formatting, "li");
  assert.deepEqual(shape.children.map((child) => [child.kind, child.text ?? child.children[0]?.text]), [
    ["marker", "M"],
    ["pseudo-box", "B"],
    ["text-sequence", "body"],
    ["pseudo-box", "A"]
  ]);
});

test("table internals remain structured and misparented cells gain anonymous wrappers", () => {
  const { formatting } = formatted(`<style>x-cell {display:table-cell}x-column{display:table-column}</style>
    <div><x-cell>Loose A</x-cell><x-cell>Loose B</x-cell><x-column></x-column></div>
    <table><caption>Cap</caption><tbody><tr><td>A</td><td><table><tr><td>Nested</td></tr></table></td></tr></tbody></table>`);
  const allNodes = nodes(formatting);
  const kinds = allNodes.map((node) => node.kind);
  assert.ok(kinds.includes("table-wrapper"));
  assert.ok(kinds.includes("table-body-group"));
  assert.ok(kinds.includes("table-row"));
  assert.ok(kinds.includes("table-cell"));
  assert.ok(kinds.filter((kind) => kind === "table").length >= 3);
  assert.ok(allNodes.some((node) => node.kind === "table-row" && node.source === null && node.children.length === 2));
  assert.ok(allNodes.some((node) => node.kind === "table-column-group" && node.source === null));
});

test("form controls, replaced content, flex, and grid retain structural node kinds", () => {
  const { formatting } = formatted(`<style>.flex{display:flex}.grid{display:grid}</style>
    <div class="flex"><span>A</span><span>B</span></div><div class="grid"><span>C</span></div>
    <img alt="Portrait"><form><input name="q"><button>Go</button></form>`);
  const kinds = nodes(formatting).map((node) => node.kind);
  assert.ok(kinds.includes("flex-container") && kinds.includes("flex-item"));
  assert.ok(kinds.includes("grid-container") && kinds.includes("grid-item"));
  assert.ok(kinds.includes("image-fallback"));
  assert.ok(kinds.filter((kind) => kind === "form-control").length >= 2);
});

test("flex and grid form one anonymous item for contiguous text and discard collapsed whitespace-only runs", () => {
  for (const [display, containerKind, itemKind] of [
    ["flex", "flex-container", "flex-item"],
    ["grid", "grid-container", "grid-item"]
  ]) {
    const { document, formatting } = formatted(`<style>
      x-layout{display:${display}}x-contents{display:contents}
    </style><x-layout>alpha<x-contents> beta</x-contents> gamma<span>E</span>   <i>I</i> tail</x-layout>`);
    const shape = principalShape(document, formatting, "x-layout");
    assert.equal(shape.kind, containerKind);
    assert.deepEqual(shape.children.map((item) => ({
      kind: item.kind,
      children: item.children.map((child) => child.kind),
      text: item.children.filter((child) => child.kind === "text-sequence").map((child) => child.text).join("")
    })), [
      { kind: itemKind, children: ["text-sequence", "text-sequence", "text-sequence"], text: "alpha beta gamma" },
      { kind: itemKind, children: ["inline-container"], text: "" },
      { kind: itemKind, children: ["inline-container"], text: "" },
      { kind: itemKind, children: ["text-sequence"], text: " tail" }
    ]);
  }
});

test("anonymous table repair preserves row, group, column, caption, and cell order", () => {
  const { document, formatting } = formatted(`<style>
    x-cell{display:table-cell}x-row{display:table-row}x-group{display:table-row-group}
    x-col{display:table-column}x-cap{display:table-caption}
  </style><div><x-row><x-cell>R</x-cell></x-row><x-group><x-cell>G</x-cell></x-group>
    <x-col></x-col><x-cap>Cap</x-cap><x-col></x-col><x-cell>C</x-cell></div>`);
  const div = principalShape(document, formatting, "div");
  assert.equal(div.children.length, 1);
  const table = div.children[0].children[0];
  assert.equal(div.children[0].kind, "table-wrapper");
  assert.deepEqual(table.children.map((child) => child.kind), [
    "table-body-group",
    "table-body-group",
    "table-column-group",
    "table-caption",
    "table-column-group",
    "table-body-group"
  ]);
  assert.deepEqual(table.children.map((child) => child.source), [null, "x-group", null, "x-cap", null, null]);
  assert.equal(table.children[0].children[0].source, "x-row");
  assert.equal(table.children[1].children[0].kind, "table-row");
  assert.equal(table.children[5].children[0].children[0].source, "x-cell");
});

test("nested tables preserve complete independent table structure and surrounding cell order", () => {
  const { formatting } = formatted(
    "<table><tr><td>outer<table><caption>cap</caption><tr><td>inner</td></tr></table>tail</td></tr></table>"
  );
  const table = nodes(formatting).find((node) => node.kind === "table");
  assert.ok(table);
  assert.deepEqual(structuralShape(formatting, table.id), [
    "table",
    ["table-body-group",
      ["table-row",
        ["table-cell",
          ["anonymous-block", ["anonymous-inline", ["text-sequence", "outer"]]],
          ["table-wrapper",
            ["table",
              ["table-caption", ["text-sequence", "cap"]],
              ["table-body-group",
                ["table-row", ["table-cell", ["text-sequence", "inner"]]]]]],
          ["anonymous-block", ["anonymous-inline", ["text-sequence", "tail"]]]]]]
  ]);
});

test("display contents participates structurally inside lists and tables", () => {
  const list = formatted(`<style>span{display:contents}</style><ol><li><span>item</span></li></ol>`);
  const listItem = principalShape(list.document, list.formatting, "li");
  assert.deepEqual(listItem.children.map((child) => child.kind), ["marker", "text-sequence"]);

  const table = formatted(`<style>tbody{display:contents}</style><table><tbody><tr><td>cell</td></tr></tbody></table>`);
  const tableBox = table.formatting.forSource(sourceNamed(table.document, "table"))
    .find((node) => node.kind === "table");
  assert.ok(tableBox);
  const shape = subtreeShape(table.formatting, tableBox.id);
  assert.deepEqual(shape.children.map((child) => [child.kind, child.source]), [["table-body-group", null]]);
  assert.equal(shape.children[0].children[0].source, "tr");
});

test("standalone HTML controls generate control boxes instead of disappearing", () => {
  const { document, state, formatting } = formatted(`<main><label for="query">Query</label><input id="query" value="term"></main>`);
  const control = document.controls[0];
  assert.ok(control);
  assert.equal(control.form, null);
  assert.equal(state.controls.get(control.node)?.values[0], "term");
  assert.equal(formatting.forSource(control.node)[0]?.kind, "form-control");
});

test("formatting budgets return typed truncation without reconstructing flat content", () => {
  const { formatting } = formatted(`<div>${"<span>x</span>".repeat(100)}</div>`, { maxFormattingNodes: 12 });
  assert.equal(formatting.outcome.status, "truncated");
  assert.equal(formatting.outcome.budget, "maxFormattingNodes");
  assert.ok(nodes(formatting).length <= 12);
});

test("author-style truncation cannot suppress retained document content", () => {
  const { formatting } = formatted(
    `<style>span:first-child{color:red} span:last-child{color:blue}</style><main>${"<span>word</span>".repeat(20)}</main>`,
    undefined,
    { maxSelectorQueries: 1 }
  );
  assert.ok(formatting.suppressed.every((entry) => entry.reason === "display-none"));
  assert.equal(nodes(formatting).filter((node) => node.kind === "text-sequence").length, 20);
});
