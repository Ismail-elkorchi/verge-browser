import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "@ismail-elkorchi/html-parser";

import { buildFormSubmissionRequest, buildGetSubmissionUrl, extractForms } from "../../dist/app/forms.js";

test("extractForms preserves semantic controls, unchecked choices, and duplicate names", () => {
  const document = parse(`
    <html><body>
      <label for="query">Search terms</label>
      <form method="get" action="/search">
        <input id="query" type="search" name="q" value="alpha" required />
        <label>Nested label <input name="nested" value="inside" /></label>
        <input type="checkbox" name="debug" value="1" />
        <input type="checkbox" name="tag" value="one" checked />
        <input type="checkbox" name="tag" value="two" checked />
        <select name="lang"><option value="en" selected>English</option></select>
        <input type="number" name="count" value="2" min="1" max="9" step="0.5" />
        <input type="file" name="upload" />
        <button type="submit" name="intent" value="search">Search</button>
      </form>
    </body></html>
  `);

  const form = extractForms(document.tree, "https://example.com/base")[0];
  assert.equal(form?.method, "get");
  assert.equal(form?.label, "Search terms");
  assert.equal(form?.encoding, "application/x-www-form-urlencoded");
  assert.equal(form?.actionUrl, "https://example.com/search");
  assert.deepEqual(form?.controls.map((control) => [control.kind, control.name]), [
    ["text", "q"],
    ["text", "nested"],
    ["checkbox", "debug"],
    ["checkbox", "tag"],
    ["checkbox", "tag"],
    ["select", "lang"],
    ["text", "count"],
    ["unsupported", "upload"],
    ["submit", "intent"]
  ]);
  assert.equal(form?.controls[0]?.label, "Search terms");
  assert.equal(form?.controls[1]?.label, "Nested label");
  assert.equal(form?.controls[2]?.kind === "checkbox" && form.controls[2].checked, false);
  const count = form?.controls.find((control) => control.kind === "text" && control.inputType === "number");
  assert.deepEqual(count && { min: count.min, max: count.max, step: count.step }, { min: 1, max: 9, step: 0.5 });
  assert.equal(form?.controls.find((control) => control.kind === "submit")?.label, "Search");
});

test("buildGetSubmissionUrl preserves ordering, duplicates, and explicit unchecked state", () => {
  const form = {
    id: "form:1",
    index: 1,
    label: "Search",
    method: "get",
    encoding: "application/x-www-form-urlencoded",
    actionUrl: "https://example.com/search",
    controls: [
      { id: "q", kind: "text", inputType: "search", name: "q", label: "Query", value: "alpha", disabled: false, required: false, readOnly: false },
      { id: "one", kind: "checkbox", name: "tag", label: "One", value: "one", checked: true, disabled: false, required: false },
      { id: "two", kind: "checkbox", name: "tag", label: "Two", value: "two", checked: true, disabled: false, required: false }
    ]
  };
  const url = buildGetSubmissionUrl(form, [
    { controlId: "q", value: "beta" },
    { controlId: "one", value: null },
    { controlId: "two", value: "two" }
  ]);
  assert.equal(url, "https://example.com/search?q=beta&tag=two");
});

test("buildFormSubmissionRequest includes only the activated submitter", () => {
  const submission = buildFormSubmissionRequest(
    {
      id: "form:2",
      index: 2,
      label: "Login",
      method: "post",
      encoding: "application/x-www-form-urlencoded",
      actionUrl: "https://example.com/login",
      controls: [
        { id: "user", kind: "text", inputType: "text", name: "user", label: "User", value: "ismail", disabled: false, required: false, readOnly: false },
        { id: "pass", kind: "text", inputType: "password", name: "pass", label: "Password", value: "secret", disabled: false, required: false, readOnly: false },
        { id: "login", kind: "submit", name: "intent", label: "Login", value: "login", disabled: false, required: false },
        { id: "preview", kind: "submit", name: "intent", label: "Preview", value: "preview", disabled: false, required: false }
      ]
    },
    [{ controlId: "pass", value: "updated" }],
    "login"
  );

  assert.equal(submission.url, "https://example.com/login");
  assert.equal(submission.requestOptions.method, "POST");
  assert.equal(submission.requestOptions.headers?.["content-type"], "application/x-www-form-urlencoded; charset=UTF-8");
  assert.equal(submission.requestOptions.bodyText, "user=ismail&pass=updated&intent=login");
});

test("buildFormSubmissionRequest rejects unsupported encodings and methods", () => {
  const base = {
    id: "form:3",
    index: 3,
    label: "Upload",
    actionUrl: "https://example.com/upload",
    controls: []
  };
  assert.throws(
    () => buildFormSubmissionRequest({ ...base, method: "post", encoding: "multipart/form-data" }),
    /Unsupported form encoding/
  );
  assert.throws(
    () => buildFormSubmissionRequest({ ...base, method: "delete", encoding: "application/x-www-form-urlencoded" }),
    /Unsupported form method/
  );
});

test("forms honor disabled ancestors, empty numeric constraints, and button defaults", () => {
  const document = parse(`
    <form method="invalid" action="/submit" enctype="multipart/form-data">
      <fieldset disabled>
        <legend><input name="legend" value="kept"></legend>
        <div><input name="disabled" value="secret"></div>
      </fieldset>
      <input type="number" name="count" min="" max="" step="">
      <select name="choice"><optgroup disabled><option selected value="blocked">Blocked</option></optgroup></select>
      <button name="intent">Send</button>
    </form>
  `);
  const form = extractForms(document.tree, "https://example.test/base")[0];
  assert.ok(form);
  assert.equal(form.method, "get");
  assert.equal(form.controls.find((control) => control.name === "legend")?.disabled, false);
  assert.equal(form.controls.find((control) => control.name === "disabled")?.disabled, true);
  const number = form.controls.find((control) => control.kind === "text" && control.inputType === "number");
  assert.deepEqual(number && { min: number.min, max: number.max, step: number.step }, {
    min: undefined,
    max: undefined,
    step: undefined
  });
  const select = form.controls.find((control) => control.kind === "select");
  assert.ok(select);
  assert.equal(select?.options[0]?.disabled, true);
  assert.equal(form.controls.find((control) => control.kind === "submit")?.value, "");

  assert.equal(
    buildFormSubmissionRequest(
      form,
      [],
      form.controls.find((control) => control.kind === "submit")?.id
    ).url,
    "https://example.test/submit?legend=kept&count=&intent="
  );
  assert.equal(
    buildGetSubmissionUrl(form, [{ controlId: select.id, value: "blocked" }]),
    "https://example.test/submit?legend=kept&count="
  );
});

test("form extraction bounds page, control, and select-option expansion", () => {
  const manyForms = parse(Array.from(
    { length: 300 },
    (_, index) => `<form aria-label="form-${String(index)}"></form>`
  ).join(""));
  assert.equal(extractForms(manyForms.tree, "https://example.test/").length, 256);

  const largeForm = parse(`<form>
    ${Array.from(
      { length: 2_100 },
      (_, index) => `<input name="field-${String(index)}">`
    ).join("")}
  </form>`);
  assert.equal(
    extractForms(largeForm.tree, "https://example.test/")[0]?.controls.length,
    2_000
  );

  const largeSelect = parse(`<form><select name="choice">
    ${Array.from(
      { length: 2_100 },
      (_, index) => `<option value="${String(index)}">${String(index)}</option>`
    ).join("")}
  </select></form>`);
  const select = extractForms(largeSelect.tree, "https://example.test/")[0]
    ?.controls.find((control) => control.kind === "select");
  assert.equal(select?.kind === "select" ? select.options.length : 0, 2_000);
});
