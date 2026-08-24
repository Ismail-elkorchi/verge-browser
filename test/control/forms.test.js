import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDocumentAction,
  createDocumentState,
  parseWebDocument
} from "../../dist/document/index.js";
import {
  buildFormSubmissionRequest,
  buildGetSubmissionUrl
} from "../../dist/app/forms.js";

function documentWithForm(html) {
  return parseWebDocument(html, {
    requestUrl: "https://example.test/base",
    finalUrl: "https://example.test/base"
  });
}

test("form indexes preserve labels, successful controls, defaults, and bounded options", () => {
  const document = documentWithForm(`<form method="get" action="/search" aria-label="Search">
    <label for="query">Search terms</label><input id="query" type="search" name="q" value="alpha" required>
    <label>Nested label <input name="nested" value="inside"></label>
    <input type="checkbox" name="tag" value="one" checked>
    <select name="lang"><option value="en" selected>English</option></select>
    <input type="number" name="count" value="2" min="1" max="9" step="0.5">
    <input type="file" name="upload"><button name="intent" value="search">Search</button>
  </form>`);
  const form = document.forms[0];
  assert.equal(form.action, "https://example.test/search");
  assert.deepEqual(form.controls.map((control) => [control.kind, control.name]), [
    ["text", "q"], ["text", "nested"], ["checkbox", "tag"], ["select", "lang"],
    ["text", "count"], ["unsupported", "upload"], ["submit", "intent"]
  ]);
  assert.equal(form.controls[0].label, "Search terms");
  assert.equal(form.controls[1].label, "Nested label");
  const number = form.controls.find((control) => control.kind === "text" && control.inputType === "number");
  assert.deepEqual(number && { min: number.min, max: number.max, step: number.step }, { min: 1, max: 9, step: 0.5 });
});

test("form submission consumes typed dynamic state and only the activated submitter", () => {
  const document = documentWithForm(`<form method="post" action="/login">
    <input name="user" value="ismail"><input name="pass" type="password" value="secret">
    <button name="intent" value="login">Login</button><button name="intent" value="preview">Preview</button>
  </form>`);
  const form = document.forms[0];
  const password = form.controls.find((control) => control.name === "pass");
  const login = form.controls.find((control) => control.kind === "submit" && control.value === "login");
  let state = createDocumentState(document);
  state = applyDocumentAction(document, state, { kind: "set-control-value", target: password.node, value: "updated" });
  const submission = buildFormSubmissionRequest(form, state, login.node);
  assert.equal(submission.url, "https://example.test/login");
  assert.equal(submission.requestOptions.method, "POST");
  assert.equal(submission.requestOptions.bodyText, "user=ismail&pass=updated&intent=login");
});

test("unchecked and disabled choices are omitted and invalid selected values are rejected", () => {
  const document = documentWithForm(`<form action="/search">
    <input name="q" value="alpha"><input type="checkbox" name="debug" value="1" checked>
    <select name="lang"><option value="en" selected>English</option><option disabled value="blocked">Blocked</option></select>
  </form>`);
  const form = document.forms[0];
  const checkbox = form.controls.find((control) => control.kind === "checkbox");
  const select = form.controls.find((control) => control.kind === "select");
  let state = createDocumentState(document);
  state = applyDocumentAction(document, state, { kind: "set-checked", target: checkbox.node, checked: false });
  state = applyDocumentAction(document, state, {
    kind: "set-selected-options",
    target: select.node,
    options: [select.options.find((option) => option.value === "blocked").node]
  });
  assert.deepEqual(state.controls.get(select.node), { values: [], checked: null, selected: [] });
  assert.equal(buildGetSubmissionUrl(form, state), "https://example.test/search?q=alpha");
});

test("document state enforces radio groups and effective single-select defaults", () => {
  const document = documentWithForm(`<form action="/choose">
    <input type="radio" name="size" value="small" checked>
    <input type="radio" name="size" value="large">
    <select name="color"><option value="red">Red</option><option value="blue">Blue</option></select>
  </form>`);
  const form = document.forms[0];
  const radios = form.controls.filter((control) => control.kind === "radio");
  const select = form.controls.find((control) => control.kind === "select");
  let state = createDocumentState(document);
  assert.deepEqual(state.controls.get(select.node)?.values, ["red"]);
  state = applyDocumentAction(document, state, { kind: "set-checked", target: radios[1].node, checked: true });
  assert.equal(state.controls.get(radios[0].node)?.checked, false);
  assert.equal(state.controls.get(radios[1].node)?.checked, true);
  assert.equal(buildGetSubmissionUrl(form, state), "https://example.test/choose?size=large&color=red");
});

test("document state is immutable and form reset is a typed document action", () => {
  const document = documentWithForm(`<form><input name="value" value="initial"></form>`);
  const form = document.forms[0];
  const control = form.controls[0];
  let state = createDocumentState(document);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.controls), true);
  assert.equal(typeof state.controls.set, "undefined");
  assert.equal(Object.isFrozen(state.controls.get(control.node)), true);
  assert.equal(Object.isFrozen(state.controls.get(control.node).values), true);

  state = applyDocumentAction(document, state, {
    kind: "set-control-value",
    target: control.node,
    value: "changed"
  });
  assert.deepEqual(state.controls.get(control.node).values, ["changed"]);
  state = applyDocumentAction(document, state, { kind: "reset-form", target: form.node });
  assert.deepEqual(state.controls.get(control.node).values, ["initial"]);
});

test("submission validates selected option identities rather than equal values", () => {
  const document = documentWithForm(`<form action="/choose"><select name="choice">
    <option disabled selected value="same">Blocked</option><option value="same">Allowed</option>
  </select></form>`);
  const form = document.forms[0];
  const state = createDocumentState(document);
  assert.equal(buildGetSubmissionUrl(form, state), "https://example.test/choose");
});

test("unsupported form methods and encodings fail closed", () => {
  const dialog = documentWithForm("<form method='dialog'></form>").forms[0];
  assert.throws(() => buildFormSubmissionRequest(dialog, createDocumentState(documentWithForm("<form></form>"))), /Unsupported form method/u);
  const multipartDocument = documentWithForm("<form method='post' enctype='multipart/form-data'></form>");
  assert.throws(
    () => buildFormSubmissionRequest(multipartDocument.forms[0], createDocumentState(multipartDocument)),
    /Unsupported form encoding/u
  );
});

test("forms normalize HTML defaults and submitters override submission metadata", () => {
  const document = documentWithForm(`<base href="https://cdn.example/base/"><form method="post" action="">
    <input name="q" value="term"><button name="intent" value="find"
      formaction="/search?old=1" formmethod="get" formenctype="text/plain" formnovalidate>Find</button>
  </form>`);
  const form = document.forms[0];
  const submitter = form.controls.find((control) => control.kind === "submit");
  assert.equal(form.action, "https://example.test/base");
  assert.equal(submitter.formAction, "https://cdn.example/search?old=1");
  assert.equal(submitter.formNoValidate, true);
  const submission = buildFormSubmissionRequest(form, createDocumentState(document), submitter.node);
  assert.equal(submission.url, "https://cdn.example/search?q=term&intent=find");
  assert.equal(submission.requestOptions.method, "GET");
});

test("invalid button and input type keywords follow HTML missing-value defaults", () => {
  const document = documentWithForm(`<form><input type="future-widget" name="value"><button type="future-button">Go</button></form>`);
  assert.deepEqual(document.forms[0].controls.map((control) => control.kind), ["text", "submit"]);
});
