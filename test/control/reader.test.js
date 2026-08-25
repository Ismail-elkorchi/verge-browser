import assert from "node:assert/strict";
import test from "node:test";

import { parseWebDocument } from "../../dist/document/index.js";
import { buildReaderDocument, readerDocumentLines } from "../../dist/reader/index.js";

function readerDocument(html, budgets) {
  const document = parseWebDocument(html, {
    requestUrl: "https://example.test/",
    finalUrl: "https://example.test/"
  });
  return buildReaderDocument(document, budgets ? { budgets } : {});
}

test("reader budgets charge emitted semantic content rather than generic ancestors", () => {
  const reader = readerDocument("<main><article><h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p></article></main>", {
    maxTextCodeUnits: 38
  });
  assert.deepEqual(reader.blocks.map((block) => block.kind), ["heading", "paragraph", "paragraph"]);
  assert.match(readerDocumentLines(reader).join("\n"), /First paragraph/u);
});

test("reader lists preserve nested item depth without duplicating descendant list text", () => {
  const reader = readerDocument("<ol><li>Parent<ul><li>Child</li></ul></li><li>Sibling</li></ol>");
  const items = reader.blocks.filter((block) => block.kind === "list-item");
  assert.deepEqual(items.map((item) => [item.depth, item.marker, item.text]), [
    [1, "1.", "Parent"],
    [2, "•", "Child"],
    [1, "2.", "Sibling"]
  ]);
});

test("reader document retains generic and custom-element prose around semantic blocks", () => {
  const reader = readerDocument(`<main>Introduction <x-card>custom <span>content</span></x-card>
    <h2>Section</h2><section>Loose <a href="/more">linked prose</a></section></main>`);
  assert.deepEqual(reader.blocks.map((block) => [block.kind, block.text]), [
    ["paragraph", "Introduction custom content"],
    ["heading", "Section"],
    ["paragraph", "Loose linked prose"]
  ]);
});
