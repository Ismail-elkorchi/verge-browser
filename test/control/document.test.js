import assert from "node:assert/strict";
import test from "node:test";

import { applyDocumentAction, createDocumentState, parseWebDocument, documentTextEquivalent, htmlListMetadata, htmlListItemValue, parseHtmlInteger } from "../../dist/document/index.js";

const context = {
  requestUrl: "https://example.test/start",
  finalUrl: "https://example.test/articles/page"
};

function element(document, name) {
  const pending = [document.root];
  while (pending.length > 0) {
    const ref = pending.shift();
    const node = document.node(ref);
    if (node.kind === "element" && node.name === name) return node;
    pending.push(...node.children);
  }
  return undefined;
}

function byId(document, id) {
  const ref = document.elementById(id);
  assert.ok(ref, `Missing #${id}`);
  return ref;
}

test("document snapshots preserve structure, namespaces, stable references, and source metadata", () => {
  const document = parseWebDocument(`<!doctype html><html><head>
    <base href="/assets/"><title>Structural page</title>
    <meta name="description" content="A fixture">
    <link rel="stylesheet" href="theme.css">
  </head><body><main><x-card data-value="yes"><span>Hello</span><svg><title>Icon</title></svg></x-card></main></body></html>`, context);

  const custom = element(document, "x-card");
  const span = element(document, "span");
  const svg = element(document, "svg");
  assert.ok(custom && span && svg);
  assert.equal(document.parent(span.ref)?.ref, custom.ref);
  assert.equal(document.node(custom.ref), document.node(custom.ref));
  assert.equal(custom.attributes.find((attribute) => attribute.name === "data-value")?.value, "yes");
  assert.equal(svg.namespace, "http://www.w3.org/2000/svg");
  assert.equal(document.text(custom.ref), "HelloIcon");
  assert.equal(Object.isFrozen(custom.sourceRange), true);
  assert.equal(Object.isFrozen(custom.attributes[0]?.sourceRange), true);
  assert.throws(
    () => document.text(custom.ref, Number.POSITIVE_INFINITY),
    /non-negative safe integer/u
  );
  const spanText = document.children(span.ref)[0];
  assert.equal(spanText.kind, "text");
  const spanRange = document.textSourceRange(spanText.ref, 0, spanText.value.length);
  assert.ok(spanRange);
  assert.equal(document.sourceText.slice(spanRange.start, spanRange.end), "Hello");
  assert.equal(document.title, "Structural page");
  assert.equal(document.baseUrl, "https://example.test/assets/");
  assert.equal(document.stylesheets[0]?.kind, "external");
  assert.equal(document.stylesheets[0]?.destination, "https://example.test/assets/theme.css");
  assert.ok(document.sourceText?.includes("x-card"));
  assert.ok(document.sourceMetadata.parserNodeCount > 0);
  assert.equal(Object.isFrozen(document), true);
});

test("template contents remain inert and foreign element names preserve namespace casing", () => {
  const document = parseWebDocument(`<template><link rel="stylesheet" href="hidden.css"><p>Hidden template text</p></template>
    <svg><linearGradient id="paint"></linearGradient></svg><p>Visible text</p>`, context);
  const template = element(document, "template");
  const gradient = element(document, "linearGradient");
  assert.ok(template && gradient);
  assert.deepEqual(template.children, []);
  assert.ok(template.templateContent);
  assert.equal(document.node(template.templateContent).kind, "template-content");
  assert.equal(document.text(document.body).includes("Hidden template text"), false);
  assert.equal(document.stylesheets.length, 0);
  assert.equal(gradient.namespace, "http://www.w3.org/2000/svg");
});

test("stylesheet indexes exclude inactive and non-CSS link relationships", () => {
  const document = parseWebDocument(`<head>
    <link rel="stylesheet" href="active.css">
    <link rel="alternate stylesheet" href="alternate.css">
    <link rel="stylesheet" href="disabled.css" disabled>
    <link rel="stylesheet" href="script.js" type="text/javascript">
    <link rel="stylesheet" href="">
  </head>`, context);
  assert.deepEqual(document.stylesheets.map((entry) => entry.kind === "external" && entry.href), ["active.css"]);
});

test("document indexes bind links, forms, labels, headings, landmarks, and names to node references", () => {
  const document = parseWebDocument(`<html><head><title>Forms</title></head><body>
    <nav aria-label="Primary"><a href="../next">Next article</a></nav>
    <main><h1 id="heading">Account</h1>
      <form action="/submit" method="post" aria-label="Account form">
        <label for="email">Email address</label><input id="email" name="email" type="email" required>
        <label><input name="news" type="checkbox" value="yes"> Newsletter</label>
        <select name="plan"><option value="free">Free</option><option selected value="pro">Pro</option></select>
        <button name="intent" value="save">Save</button>
      </form>
    </main></body></html>`, context);

  assert.deepEqual(document.links.map((link) => [link.index, link.label, link.destination]), [
    [1, "Next article", "https://example.test/next"]
  ]);
  assert.equal(document.forms.length, 1);
  const form = document.forms[0];
  assert.equal(form.label, "Account form");
  assert.equal(form.action, "https://example.test/submit");
  assert.deepEqual(form.controls.map((control) => [control.kind, control.name]), [
    ["text", "email"], ["checkbox", "news"], ["select", "plan"], ["submit", "intent"]
  ]);
  assert.equal(form.controls[0]?.label, "Email address");
  assert.equal(document.labels[0]?.target, form.controls[0]?.node);
  assert.equal(document.label(document.labels[0].node), document.labels[0]);
  assert.equal(document.control(form.controls[0].node).form, form.node);
  assert.equal(document.outline[0]?.node, document.headings[0]?.node);
  assert.equal(document.outline[0]?.text, "Account");
  assert.ok(document.landmarks.some((entry) => entry.landmark === "navigation" && entry.accessibleName === "Primary"));
  assert.equal(document.semantic(form.controls[0].node)?.role, "textbox");
  const selectedOption = form.controls[2].options[1];
  assert.equal(document.option(selectedOption.node), selectedOption);
  assert.equal(document.elementById("heading"), document.headings[0].node);
  assert.equal(form.controls[2].options.find((option) => createDocumentState(document).controls.get(form.controls[2].node).selected.includes(option.node)).value, "pro");
});

test("initial document state resolves the final URL fragment through the ID index", () => {
  const document = parseWebDocument("<main><h1 id='chapter one'>Chapter</h1></main>", {
    requestUrl: "https://example.test/start",
    finalUrl: "https://example.test/page#chapter%20one"
  });
  assert.equal(createDocumentState(document).urlTarget, document.headings[0].node);
});

test("validated URL target update is renderer state, not navigation", () => {
  const document = parseWebDocument(`<a href="#chapter">Jump</a><h2 id="chapter">Chapter</h2>`, context);
  const state = applyDocumentAction(document, createDocumentState(document), {
    kind: "set-url-target",
    target: document.elementById("chapter")
  });
  assert.equal(state.urlTarget, document.elementById("chapter"));
});

test("dynamic state transitions retain unchanged immutable state collections", () => {
  const document = parseWebDocument("<a href='#chapter'>Jump</a><h2 id='chapter'>Chapter</h2>", context);
  const initial = createDocumentState(document);
  const focused = applyDocumentAction(document, initial, {
    kind: "focus",
    target: document.links[0].node
  });
  assert.strictEqual(focused.controls, initial.controls);
  assert.strictEqual(focused.open, initial.open);
  const targeted = applyDocumentAction(document, focused, {
    kind: "set-url-target",
    target: document.elementById("chapter")
  });
  assert.strictEqual(targeted.controls, focused.controls);
  assert.strictEqual(targeted.open, focused.open);
});

test("standalone controls have immutable state and indexed radio groups without a synthetic form", () => {
  const document = parseWebDocument(`<label for="query">Query</label><input id="query" value="term">
    <label><input type="radio" name="scope" value="one" checked> One</label>
    <label><input type="radio" name="scope" value="two"> Two</label>`, context);
  assert.equal(document.forms.length, 0);
  assert.equal(document.controls.length, 3);
  assert.ok(document.controls.every((control) => control.form === null));
  assert.equal(createDocumentState(document).controls.get(document.controls[0].node)?.value, "term");
  assert.deepEqual(
    document.radioGroup(document.controls[1].node).map((control) => control.value),
    ["one", "two"]
  );
});

test("implicit landmark indexes respect naming and sectioning ancestry", () => {
  const document = parseWebDocument(`<header>Site header</header>
    <main><article><header>Article header</header><footer>Article footer</footer></article>
      <form><input name="unnamed"></form>
      <form aria-label="Named form"><input name="named"></form>
      <section aria-label="Named region">Content</section><section>Not a region</section>
      <search>Search tools</search>
    </main><footer>Site footer</footer>`, context);
  const landmarks = document.landmarks.map((entry) => entry.landmark);
  assert.deepEqual(landmarks, ["banner", "main", "form", "region", "search", "contentinfo"]);
});

test("document index outcomes are typed and cap semantic expansion", () => {
  const document = parseWebDocument(
    `<body>${Array.from({ length: 20 }, (_, index) => `<a href="/${index}">${index}</a>`).join("")}</body>`,
    { ...context, indexLimits: { maxLinks: 3, maxIndexedNodes: 100 } }
  );
  assert.equal(document.links.length, 3);
  assert.deepEqual(document.indexOutcome, {
    status: "truncated",
    indexedNodes: document.indexOutcome.indexedNodes,
    exhausted: "maxLinks",
    limit: 3
  });
});

test("form indexing does not retain controls with dangling truncated owners", () => {
  const document = parseWebDocument(
    `<form id="first"><input name="a"></form>
     <form id="second"><input name="b"></form>
     <input name="external" form="first">`,
    { ...context, indexLimits: { maxForms: 1, maxIndexedNodes: 100 } }
  );
  assert.equal(document.forms.length, 1);
  assert.deepEqual(document.forms[0].controls.map((control) => control.name), ["a", "external"]);
  const unowned = (() => {
    const pending = [document.root];
    while (pending.length > 0) {
      const ref = pending.shift();
      const node = document.node(ref);
      if (node.kind === "element" && document.attribute(ref, "name") === "b") return ref;
      pending.push(...node.children);
    }
    throw new Error("Missing second form control");
  })();
  assert.equal(document.control(unowned), null);
  assert.equal(document.control(unowned)?.form ?? null, null);
});

test("deep documents preserve structure without recursive indexing stack exhaustion", () => {
  const depth = 12_000;
  const document = parseWebDocument(
    `${"<x-shell>".repeat(depth)}deep${"</x-shell>".repeat(depth)}`,
    context
  );
  assert.ok(document.sourceMetadata.parserMaxDepth > 10_000);
  assert.equal(document.text(document.body), "deep");
  let current = element(document, "x-shell");
  let observedDepth = 0;
  while (current !== undefined) {
    observedDepth += 1;
    const child = document.children(current.ref)
      .find((node) => node.kind === "element" && node.name === "x-shell");
    current = child?.kind === "element" ? child : undefined;
  }
  assert.equal(observedDepth, depth);
});

test("HTML directionality is indexed with Unicode first-strong, isolation, override, and rendered attribute text", () => {
  const document = parseWebDocument(`<main dir="rtl">
    <p id="inherited">neutral 123</p>
    <p id="ltr" dir="LTR">العربية Latin</p>
    <p id="auto-rtl" dir="auto">123 العربية Latin</p>
    <p id="auto-ltr" dir="auto">123 Latin العربية</p>
    <p id="auto-neutral" dir="auto">123</p>
    <p id="malformed" dir="sideways">text</p>
    <bdi id="bdi">123 עברית</bdi>
    <bdi id="bdi-neutral">123</bdi>
    <bdo id="bdo" dir="rtl">Latin</bdo>
    <input id="telephone" type="tel" value="العربية">
    <input id="explicit-telephone" type="tel" dir="rtl" value="123">
    <input id="control" dir="auto" value="123 עברית" placeholder="Latin placeholder" aria-label="العربية">
    <textarea id="textarea" dir="auto">123 Latin</textarea>
    <img id="image" alt="עברית" title="Latin">
  </main>`, context);

  assert.deepEqual(document.directionality(byId(document, "inherited")), {
    node: byId(document, "inherited"), direction: "rtl", htmlMode: null,
    source: "inherited", isolates: false, overrides: false, renderedText: []
  });
  assert.equal(document.directionality(byId(document, "ltr")).direction, "ltr");
  assert.equal(document.directionality(byId(document, "auto-rtl")).direction, "rtl");
  assert.equal(document.directionality(byId(document, "auto-ltr")).direction, "ltr");
  assert.equal(document.directionality(byId(document, "auto-neutral")).direction, "ltr");
  assert.equal(document.directionality(byId(document, "malformed")).direction, "rtl");
  assert.deepEqual(
    {
      direction: document.directionality(byId(document, "bdi")).direction,
      mode: document.directionality(byId(document, "bdi")).htmlMode,
      isolates: document.directionality(byId(document, "bdi")).isolates
    },
    { direction: "rtl", mode: "auto", isolates: true }
  );
  assert.equal(document.directionality(byId(document, "bdi-neutral")).direction, "ltr");
  assert.equal(document.directionality(byId(document, "bdo")).overrides, true);
  assert.equal(document.directionality(byId(document, "telephone")).direction, "ltr");
  assert.equal(document.directionality(byId(document, "explicit-telephone")).direction, "rtl");
  assert.equal(document.directionality(byId(document, "control")).direction, "rtl");
  assert.equal(document.directionality(byId(document, "textarea")).direction, "ltr");
  assert.equal(document.directionForRenderedText(byId(document, "telephone"), "العربية"), "ltr");
  assert.equal(document.directionForRenderedText(byId(document, "control"), "Latin"), "ltr");
  assert.deepEqual(
    document.directionality(byId(document, "control")).renderedText.map(({ kind, direction }) => [kind, direction]),
    [["placeholder", "ltr"], ["control-value", "rtl"], ["accessible-name", "rtl"]]
  );
  assert.deepEqual(
    document.directionality(byId(document, "image")).renderedText.map(({ kind, direction }) => [kind, direction]),
    [["alternative-text", "rtl"], ["title", "rtl"]]
  );
});

test("control intrinsic dimensions normalize HTML integer attributes independently of values", () => {
  const document = parseWebDocument(`<input id="default"><input id="sized" size=" +12tail">
    <input id="invalid" size="-4"><input id="overflow" size="999999999999999999999">
    <textarea id="area" rows="3" cols="32">one\ntwo</textarea>
    <textarea id="fallback" rows="0" cols="n/a"></textarea>`, context);
  assert.equal(document.control(byId(document, "default")).size, 20);
  assert.equal(document.control(byId(document, "sized")).size, 12);
  assert.equal(document.control(byId(document, "invalid")).size, 20);
  assert.equal(document.control(byId(document, "overflow")).size, 20);
  const area = document.control(byId(document, "area"));
  assert.equal(area.rows, 3);
  assert.equal(area.cols, 32);
  assert.equal(area.defaultValue, "one\ntwo");
  const fallback = document.control(byId(document, "fallback"));
  assert.equal(fallback.rows, 2);
  assert.equal(fallback.cols, 20);
});

test("bounded text equivalents name image actions and ARIA references with explicit label targeting", () => {
  const document = parseWebDocument(`<a id="home" href="/home"><img alt="Home"></a>
    <span id="first"><img alt="First"></span><span id="second">Second</span>
    <button id="references" aria-labelledby="first second">Caption</button>
    <button id="self" aria-labelledby="self" aria-label="Self label">Caption</button>
    <label for="missing">Wrong <input id="unlabelled"></label>
    <div id="noncontrol"></div><label for="noncontrol">Wrong again <input id="other"></label>
    <label for="hidden">Hidden label</label><input id="hidden" type="hidden">
    <label for="target"><img alt="Image label"></label><input id="target">
    <label for="target">Second label</label>
    <img id="decorative" alt=""><img id="missingalt"><img id="named" alt="Picture">
  `, context);
  assert.equal(document.links[0].label, "Home");
  assert.equal(document.semantic(byId(document, "references")).accessibleName, "First Second");
  assert.equal(document.semantic(byId(document, "self")).accessibleName, "Self label");
  assert.equal(document.control(byId(document, "unlabelled")).label, "");
  assert.equal(document.control(byId(document, "other")).label, "");
  assert.equal(document.labels.length, 2);
  assert.equal(document.control(byId(document, "target")).label, "Image label Second label");
  assert.deepEqual(["decorative", "missingalt", "named"].map((id) => {
    const image = document.replaced(byId(document, id));
    return [image.alternativeText, image.fallbackText];
  }), [["", ""], [null, "Image"], ["Picture", "Picture"]]);
});

test("one text-equivalent path integrates generated semantic text beneath DOM and ARIA precedence", () => {
  const document = parseWebDocument(`<a id="link" href="/"><span id="suppressed">old</span>core</a><button id="aria" aria-label="Author">core</button>`, context);
  const generated = (ref, pseudo) => ref === byId(document, "link") || ref === byId(document, "aria") ? pseudo === "before" ? "before " : pseudo === "after" ? " after" : "" : "";
  assert.equal(documentTextEquivalent(document, byId(document, "link"), generated, (ref) => ref === byId(document, "suppressed")), "before core after");
  assert.equal(documentTextEquivalent(document, byId(document, "aria"), generated), "Author");
});

test("HTML list metadata preserves signed integer prefixes and authored reversed state", () => {
  const document = parseWebDocument(`<ol id="list" start=" -3tail" reversed><li id="item" value="+4more">Item</li></ol><ul id="unordered"><li id="invalid" value="x">Invalid</li></ul>`, context);
  assert.deepEqual(htmlListMetadata(document, byId(document, "list")), { start: -3, reversed: true });
  assert.equal(htmlListMetadata(document, byId(document, "unordered")), null);
  assert.equal(htmlListItemValue(document, byId(document, "item")), 4);
  assert.equal(htmlListItemValue(document, byId(document, "invalid")), null);
  assert.equal(parseHtmlInteger("\u00a01"), null);
  assert.equal(parseHtmlInteger("9007199254740992"), null);
  assert.equal(parseHtmlInteger("0"), 0);
});

test("empty HTML IDs cannot target labels or ARIA references", () => {
  const document = parseWebDocument(`<input id=""><label for="">Wrong</label><select aria-label=" "><option>Option</option></select>`, context);
  assert.equal(document.elementById(""), null);
  assert.equal(document.labels.length, 0);
  assert.deepEqual(document.controls.map((control) => control.label), ["", ""]);
});

test("empty content actions use title names without changing empty visible captions", () => {
  const document = parseWebDocument(`<a href="/" title="Home"><img alt=""></a><button title="Action"><span> </span></button>`, context);
  assert.equal(document.links[0].label, "Home");
  assert.equal(document.controls[0].label, "Action");
  assert.equal(document.controls[0].caption, "");
});

test("generated text on associated labels shares the bounded naming traversal without label recursion", () => {
  const document = parseWebDocument(`<label id="label" for="named">Visible<input id="named"></label><label for="named">More</label><input id="aria" aria-labelledby="label">`, context);
  const generated = (ref, pseudo) => ref === byId(document, "label") && pseudo === "before" ? "Prefix " : "";
  assert.equal(documentTextEquivalent(document, byId(document, "named"), generated), "Prefix Visible More");
  assert.equal(documentTextEquivalent(document, byId(document, "aria"), generated), "Prefix Visible");
});

test("empty and whitespace-only labels retain explicit and implicit association for generated names", () => {
  const document = parseWebDocument(`<label id="explicit" for="first"></label><input id="first"><label id="implicit"> \n <input id="second"></label>`, context);
  assert.deepEqual(document.labels.map((label) => [label.node, label.target, label.text]), [
    [byId(document, "explicit"), byId(document, "first"), ""], [byId(document, "implicit"), byId(document, "second"), ""],
  ]);
  const generated = (ref, pseudo) => pseudo === "before" && document.label(ref) !== null ? "Name" : "";
  assert.equal(documentTextEquivalent(document, byId(document, "first"), generated), "Name");
  assert.equal(documentTextEquivalent(document, byId(document, "second"), generated), "Name");
});

test("empty label associations preserve native title and placeholder fallback when generated text is absent", () => {
  const document = parseWebDocument(`<label for="title"></label><input id="title" title="Title name"><label for="hint"> </label><input id="hint" placeholder="Hint name">`, context);
  const generated = () => "";
  assert.equal(documentTextEquivalent(document, byId(document, "title"), generated), "Title name");
  assert.equal(documentTextEquivalent(document, byId(document, "hint"), generated), "Hint name");
});
