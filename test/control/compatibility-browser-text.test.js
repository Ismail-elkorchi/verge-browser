import assert from "node:assert/strict";
import test from "node:test";

import { collectVisibleBrowserText } from "../../scripts/compat/browser-text.mjs";

function element(tag, children, style = {}) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), id: "", parentElement: null, childNodes: [],
    style: { display: tag === "span" || tag === "label" ? "inline" : ["input", "select", "textarea", "button"].includes(tag) ? "inline-block" : "block", visibility: "visible", fontSize: "14px", ...style },
    pseudos: {}, rects: [{ width: 10, height: 14 }],
    getClientRects() { return this.rects; },
    matches(selector) { return selector === ":placeholder-shown" && this.placeholderShown === true; }
  };
  node.childNodes = children.map((child) => typeof child === "string" ? { nodeType: 3, textContent: child, parentElement: node } : child);
  for (const child of node.childNodes) child.parentElement = node;
  return node;
}

function inspect(body) {
  const previousDocument = globalThis.document;
  const previousComputedStyle = globalThis.getComputedStyle;
  globalThis.document = { body, createRange: () => ({
    selectNodeContents(node) { this.node = node; },
    getClientRects() { return this.node.rects ?? this.node.parentElement.getClientRects(); }
  }) };
  globalThis.getComputedStyle = (node, pseudo) => pseudo === undefined ? node.style
    : { ...node.style, display: "inline", content: "none", ...node.pseudos[pseudo] };
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

function generated(node, before, after = "none") {
  node.pseudos["::before"] = { content: before };
  node.pseudos["::after"] = { content: after };
  return node;
}

function option(text, properties = {}, style = {}) {
  return Object.assign(element("option", [text], style), { text, label: text, value: text, ...properties });
}

function select(options, properties = {}, style = {}) {
  return Object.assign(element("select", options, style), { multiple: false, size: 0, selectedOptions: options.slice(0, 1), ...properties });
}

function input(type, value, style = {}) {
  return Object.assign(element("input", [], style), { type, value, placeholder: "" });
}

test("Chromium text collector orders generated content around mixed inline descendants", () => {
  const inline = generated(element("span", ["middle"]), '"["', '"]"');
  const paragraph = generated(element("p", ["left", inline, "right"]), '"before "', '" after"');
  const result = inspect(element("body", [paragraph]));
  assert.deepEqual(result.meaningfulVisibleText, ["before left[middle]right after"]);
  assert.deepEqual(result.readingOrder, ["before ", "left", "[", "middle", "]", "right", " after"]);
  assert.deepEqual(result.textNodes[0], { text: "before ", parentId: "", parentTag: "p", source: "::before" });
});

test("Chromium text collector separates block-generated content without separating adjacent strings", () => {
  const node = generated(element("span", ["middle"]), '"before" "!"', '"after"');
  node.pseudos["::before"].display = "block";
  node.pseudos["::after"].display = "block";
  assert.deepEqual(inspect(element("body", ["left", node, "right"])).meaningfulVisibleText, ["left before! middle after right"]);
});

test("Chromium text collector decodes CSSOM strings and omits nonvisual alternatives", () => {
  const node = generated(element("p", []), String.raw`"quoted \"text\" and \\slash\a next " "\1f642 " / "spoken alternative"`);
  assert.deepEqual(inspect(element("body", [node])).meaningfulVisibleText, [String.raw`quoted "text" and \slash next 🙂`]);
});

test("Chromium text collector does not read quoted function arguments as generated text", () => {
  const body = element("body", [
    generated(element("p", []), 'url("https://example.com/not-visible") / "alternative"'),
    generated(element("p", []), 'counter(chapter, "not-text")'),
    generated(element("p", []), 'normal', 'none'),
    generated(element("p", []), '""', '"visible"')
  ]);
  assert.deepEqual(inspect(body).meaningfulVisibleText, ["visible"]);
});

test("Chromium text collector applies generated text visibility and restored pseudo styles", () => {
  const hidden = generated(element("p", []), '"hidden"', '"zero"');
  hidden.pseudos["::before"].visibility = "hidden";
  hidden.pseudos["::after"].fontSize = "0px";
  const restored = generated(element("p", ["hidden parent"], { visibility: "hidden", fontSize: "0px" }), '"restored"');
  Object.assign(restored.pseudos["::before"], { visibility: "visible", fontSize: "14px" });
  const absent = generated(element("p", []), '"no layout box"');
  absent.rects = [];
  const suppressed = generated(element("p", []), '"display none"');
  suppressed.pseudos["::before"].display = "none";
  const ancestor = element("div", [generated(element("p", []), '"hidden ancestor"')], { display: "none" });
  assert.deepEqual(inspect(element("body", [hidden, restored, absent, suppressed, ancestor])).meaningfulVisibleText, ["restored"]);
});

test("Chromium text collector keeps overflowing generated content on zero-area and contents origins", () => {
  const zeroArea = generated(element("p", []), '"overflow"');
  zeroArea.rects = [{ width: 0, height: 0 }];
  const contents = generated(element("span", [], { display: "contents" }), '" contents"');
  contents.rects = [];
  assert.deepEqual(inspect(element("body", [zeroArea, contents])).meaningfulVisibleText, ["overflow contents"]);
});

test("Chromium text collector reads only the displayed select label without range rectangles", () => {
  const selected = option("stale option text", { label: "History", value: "history-id" }, { fontSize: "0px", visibility: "hidden" });
  selected.rects = [];
  const other = option("unselected");
  other.rects = [];
  const control = select([other, selected], { selectedOptions: [selected] });
  const result = inspect(element("body", [element("label", ["Topic ", control]), " after"]));
  assert.deepEqual(result.meaningfulVisibleText, ["Topic History after"]);
  assert.deepEqual(result.readingOrder, ["Topic ", "History", " after"]);
});

test("Chromium text collector observes rendered listbox option labels once", () => {
  const visible = option("option DOM text", { label: "Visible label" });
  const unselected = option("Unselected label");
  const hidden = option("hidden", {}, { display: "none" });
  const zeroFont = option("zero", {}, { fontSize: "0px" });
  const noBox = option("no box");
  noBox.rects = [];
  const control = select([visible, unselected, hidden, zeroFont, noBox], { multiple: true });
  assert.deepEqual(inspect(element("body", [control])).meaningfulVisibleText, ["Visible label Unselected label"]);
});

test("Chromium text collector uses current text-control values and preserves button DOM content", () => {
  const textarea = Object.assign(element("textarea", ["stale textarea text"]), { value: "edited text", placeholder: "" });
  const button = Object.assign(element("button", ["Save ", element("span", ["changes"])]), { value: "submission-only" });
  const body = element("body", [input("text", "typed"), " ", textarea, " ", input("submit", "Send"), " ", button]);
  const result = inspect(body);
  assert.deepEqual(result.meaningfulVisibleText, ["typed edited text Send Save changes"]);
  assert.deepEqual(result.readingOrder, ["typed", "edited text", "Send", "Save ", "changes"]);
});

test("Chromium text collector excludes hidden, zero-font, unboxed, and nontext control values", () => {
  const noBox = input("text", "no box");
  noBox.rects = [];
  const body = element("body", [
    input("text", "hidden", { visibility: "hidden" }), input("text", "zero", { fontSize: "0px" }), noBox,
    ...["password", "checkbox", "radio", "hidden", "color", "range", "file"].map((type) => input(type, "nonvisual value")),
    select([option("hidden select")], {}, { visibility: "hidden" }),
    select([option("zero select")], {}, { fontSize: "0px" }),
    select([], { selectedOptions: [] }), input("text", "visible")
  ]);
  assert.deepEqual(inspect(body).meaningfulVisibleText, ["visible"]);
});

test("Chromium text collector reads only a shown and visible placeholder", () => {
  const shown = Object.assign(input("text", ""), { placeholder: "Shown", placeholderShown: true });
  const inactive = Object.assign(input("text", "Value"), { placeholder: "unused" });
  const hidden = Object.assign(input("text", ""), { placeholder: "hidden", placeholderShown: true });
  hidden.pseudos["::placeholder"] = { visibility: "hidden" };
  const zero = Object.assign(input("text", ""), { placeholder: "zero", placeholderShown: true });
  zero.pseudos["::placeholder"] = { fontSize: "0px" };
  assert.deepEqual(inspect(element("body", [shown, " ", inactive, hidden, zero])).meaningfulVisibleText, ["Shown Value"]);
});


test("Chromium text collector falls back to option text for an empty label attribute", () => {
  assert.deepEqual(inspect(element("body", [select([option("History", { label: "" })])])).meaningfulVisibleText, ["History"]);
});

test("Chromium text collector excludes generated content in suppressed and replaced subtrees", () => {
  const suppressed = element("div", [generated(element("p", []), '"suppressed"')], { contentVisibility: "hidden" });
  const replaced = generated(element("img", []), '"not generated"');
  const visible = generated(element("p", []), '"Valid fallback"');
  assert.deepEqual(inspect(element("body", [suppressed, replaced, visible])).meaningfulVisibleText, ["Valid fallback"]);
});

test("Chromium text collector observes password placeholders without exposing password values", () => {
  const shown = Object.assign(input("password", ""), { placeholder: "Password", placeholderShown: true });
  assert.deepEqual(inspect(element("body", [shown, input("password", "private")])).meaningfulVisibleText, ["Password"]);
});
