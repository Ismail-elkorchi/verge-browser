import assert from "node:assert/strict";
import test from "node:test";

import { collectVisibleBrowserText } from "../../scripts/compat/browser-text.mjs";

function element(tag, children, style = {}) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), id: "", childNodes: [], style: { display: tag === "span" ? "inline" : "block", visibility: "visible", fontSize: "14px", ...style } };
  node.childNodes = children.map((child) => typeof child === "string" ? { nodeType: 3, textContent: child, parentElement: node } : child);
  for (const child of node.childNodes) child.parentElement = node;
  return node;
}

function inspect(body) {
  const previousDocument = globalThis.document;
  const previousComputedStyle = globalThis.getComputedStyle;
  globalThis.document = { body, createRange: () => ({ selectNodeContents() {}, getClientRects: () => [{ width: 10, height: 14 }] }) };
  globalThis.getComputedStyle = (node) => node.style;
  try {
    return collectVisibleBrowserText();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousComputedStyle;
  }
}

test("Chromium text collector includes direct text around inline children", () => {
  const body = element("body", [element("p", ["Before ", element("span", ["inline"]), " after"])]);
  const result = inspect(body);
  assert.deepEqual(result.meaningfulVisibleText, ["Before inline after"]);
  assert.deepEqual(result.readingOrder, ["Before ", "inline", " after"]);
});

test("Chromium text collector preserves split-inline adjacency and block separators", () => {
  const body = element("body", [element("p", [element("span", ["abc"]), element("span", ["def"])]), element("p", ["next"])]);
  assert.deepEqual(inspect(body).meaningfulVisibleText, ["abcdef next"]);
});

test("Chromium text collector excludes zero-font text but keeps restored descendants", () => {
  const body = element("body", [element("p", ["hidden", element("span", ["restored"], { fontSize: "14px" })], { fontSize: "0px" }), element("p", ["display none"], { display: "none" }), element("script", ["script source"])]);
  assert.deepEqual(inspect(body).meaningfulVisibleText, ["restored"]);
});
