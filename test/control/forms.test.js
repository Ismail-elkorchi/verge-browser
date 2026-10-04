import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

import {
  applyDocumentAction,
  createDocumentState,
  controlValues,
  parseWebDocument
} from "../../dist/document/index.js";
import {
  buildFormSubmissionRequest,
  formEntries,
  resolveImplicitSubmission
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
  const submission = buildFormSubmissionRequest(document, form, state, login.node);
  assert.equal(submission.url, "https://example.test/login");
  assert.equal(submission.requestOptions.method, "POST");
  assert.equal(submission.requestOptions.bodyText, "user=ismail&pass=updated&intent=login");
});

test("ordinary buttons are controls but never successful form entries", () => {
  const document = documentWithForm(`<form action="/save">
    <input name="title" value="Draft">
    <button type="button" name="command" value="preview">Preview</button>
    <button name="intent" value="save">Save</button>
  </form>`);
  const form = document.forms[0];
  const ordinary = form.controls.find((control) => control.kind === "button");
  const submit = form.controls.find((control) => control.kind === "submit");
  assert.ok(ordinary && submit);
  assert.equal(ordinary.label, "Preview");
  assert.equal(
    buildFormSubmissionRequest(document, form, createDocumentState(document), submit.node).url,
    "https://example.test/save?title=Draft&intent=save"
  );
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
  assert.deepEqual(state.controls.get(select.node), { kind: "selected", selected: [] });
  assert.equal(buildFormSubmissionRequest(document, form, state).url, "https://example.test/search?q=alpha");
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
  assert.deepEqual(controlValues(state, select), ["red"]);
  state = applyDocumentAction(document, state, { kind: "set-checked", target: radios[1].node, checked: true });
  assert.equal(state.controls.get(radios[0].node)?.checked, false);
  assert.equal(state.controls.get(radios[1].node)?.checked, true);
  assert.equal(buildFormSubmissionRequest(document, form, state).url, "https://example.test/choose?size=large&color=red");
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

  state = applyDocumentAction(document, state, {
    kind: "set-control-value",
    target: control.node,
    value: "changed"
  });
  assert.equal(state.controls.get(control.node).value, "changed");
  state = applyDocumentAction(document, state, { kind: "reset-form", target: form.node });
  assert.equal(state.controls.get(control.node).value, "initial");
});

test("initial state and form reset share radio-group default normalization", () => {
  const document = documentWithForm(`<form>
    <input type="radio" name="choice" value="first" checked>
    <input type="radio" name="choice" value="last" checked>
  </form>`);
  const form = document.forms[0];
  const radios = form.controls.filter((control) => control.kind === "radio");
  let state = createDocumentState(document);
  assert.deepEqual(radios.map((control) => state.controls.get(control.node)?.checked), [false, true]);
  state = applyDocumentAction(document, state, {
    kind: "set-checked",
    target: radios[0].node,
    checked: true
  });
  assert.deepEqual(radios.map((control) => state.controls.get(control.node)?.checked), [true, false]);
  state = applyDocumentAction(document, state, { kind: "reset-form", target: form.node });
  assert.deepEqual(radios.map((control) => state.controls.get(control.node)?.checked), [false, true]);
});

test("submission validates selected option identities rather than equal values", () => {
  const document = documentWithForm(`<form action="/choose"><select name="choice">
    <option disabled selected value="same">Blocked</option><option value="same">Allowed</option>
  </select></form>`);
  const form = document.forms[0];
  const state = createDocumentState(document);
  assert.equal(buildFormSubmissionRequest(document, form, state).url, "https://example.test/choose");
});

test("unsupported form methods and encodings fail closed", () => {
  const dialogDocument = documentWithForm("<form method='dialog'></form>");
  const dialog = dialogDocument.forms[0];
  assert.throws(() => buildFormSubmissionRequest(dialogDocument, dialog, createDocumentState(dialogDocument)), /Unsupported form method/u);
  const multipartDocument = documentWithForm("<form method='post' enctype='multipart/form-data'></form>");
  assert.throws(
    () => buildFormSubmissionRequest(multipartDocument, multipartDocument.forms[0], createDocumentState(multipartDocument)),
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
  const submission = buildFormSubmissionRequest(document, form, createDocumentState(document), submitter.node);
  assert.equal(submission.url, "https://cdn.example/search?q=term&intent=find");
  assert.equal(submission.requestOptions.method, "GET");
});

test("invalid button and input type keywords follow HTML missing-value defaults", () => {
  const document = documentWithForm(`<form><input type="future-widget" name="value"><button type="future-button">Go</button></form>`);
  assert.deepEqual(document.forms[0].controls.map((control) => control.kind), ["text", "submit"]);
});

test("select option display labels stay distinct from submitted values and identities", () => {
  const document = documentWithForm(`<form><select name="choice"><option value="42" label="First label">first fallback</option><option value="42" label="Second label" selected>second fallback</option></select></form>`);
  const control = document.forms[0].controls[0];
  assert.deepEqual(control.options.map((option) => [option.label, option.value]), [["First label", "42"], ["Second label", "42"]]);
  assert.notEqual(control.options[0].node, control.options[1].node);
  assert.deepEqual(createDocumentState(document).controls.get(control.node).selected, [control.options[1].node]);
});

test("single-select initialization and reset honor explicit selectedness, enabled options and display size", () => {
  const document = documentWithForm(`<form>
    <select name="fallback"><option disabled>Choose</option><optgroup disabled><option>Blocked</option></optgroup><option>Allowed</option></select>
    <select name="listbox" size="2"><option>One</option><option>Two</option></select>
    <select name="multi" multiple><option>One</option></select>
    <select name="explicit"><option selected disabled value="same">Blocked</option><option value="same">Allowed</option></select>
    <select name="last"><option selected>A</option><option selected>B</option></select>
  </form>`);
  const form = document.forms[0];
  let state = createDocumentState(document);
  const expected = [["Allowed"], [], [], ["same"], ["B"]];
  assert.deepEqual(form.controls.map((control) => controlValues(state, control)), expected);
  assert.deepEqual(form.controls[0].options.map((option) => option.defaultSelected), [false, false, false]);
  for (const control of form.controls) state = applyDocumentAction(document, state, { kind: "set-selected-options", target: control.node, options: [] });
  state = applyDocumentAction(document, state, { kind: "reset-form", target: form.node });
  assert.deepEqual(form.controls.map((control) => controlValues(state, control)), expected);
  assert.deepEqual(formEntries(document, form, state), [{ name: "fallback", value: "Allowed" }, { name: "last", value: "B" }]);
});

test("option text values collapse only ASCII whitespace and omit script descendants", () => {
  const document = documentWithForm(`<form><select name="fruit"><option>\n  Green   apple\n&nbsp; end <script>not value</script></option></select></form>`);
  const option = document.forms[0].controls[0].options[0];
  assert.equal(option.value, "Green apple \u00a0 end");
  assert.equal(option.label, option.value);
  assert.deepEqual(formEntries(document, document.forms[0], createDocumentState(document)), [{ name: "fruit", value: option.value }]);
});

test("supported input sanitization is identical on initialization, edit and reset", () => {
  const cases = [
    ["text", false, " a\r\nb ", " ab "],
    ["search", false, " a\nb ", " ab "],
    ["password", false, "a\nb", "ab"],
    ["tel", false, "a\rb", "ab"],
    ["url", false, " \ta\nb \t", "ab"],
    ["email", false, " a@example.test\n ", "a@example.test"],
    ["email", true, " a@x.test , b@y.test\n ", "a@x.test,b@y.test"],
    ["email", false, "\u00a0a@x.test\u00a0", "\u00a0a@x.test\u00a0"],
    ["number", false, "garbage", ""],
    ["number", false, "1.", ""],
    ["number", false, "+1", ""],
    ["number", false, " 1", ""],
    ["number", false, "1e999", ""],
    ["number", false, "-.5e+2", "-.5e+2"],
  ];
  for (const [type, multiple, authored, expected] of cases) {
    const encoded = authored.replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
    const document = documentWithForm(`<form><input name="v" type="${type}" ${multiple ? "multiple" : ""} value="${encoded}"></form>`);
    const form = document.forms[0], control = form.controls[0];
    let state = createDocumentState(document);
    assert.equal(control.defaultValue, authored);
    assert.deepEqual(controlValues(state, control), [expected]);
    state = applyDocumentAction(document, state, { kind: "set-control-value", target: control.node, value: authored });
    assert.deepEqual(controlValues(state, control), [expected]);
    state = applyDocumentAction(document, state, { kind: "set-control-value", target: control.node, value: "changed" });
    state = applyDocumentAction(document, state, { kind: "reset-form", target: form.node });
    assert.deepEqual(controlValues(state, control), [expected]);
  }
});

test("submit/reset captions, accessible labels and successful values stay distinct", () => {
  const document = documentWithForm(`<form>
    <input type="submit" name="absent"><input type="submit" name="empty" value="">
    <input type="submit" name="go" value="Go" aria-label="Search now">
    <input type="reset" value=""><input type="button" value="Preview">
    <button name="intent" value="submit-value" aria-label="Accessible action"><img alt="Visible icon"></button>
  </form>`);
  const form = document.forms[0];
  assert.deepEqual(form.controls.map((control) => [control.label, control.caption, control.value]), [
    ["Submit", "Submit", "Submit"], ["", "", ""], ["Search now", "Go", "Go"],
    ["", "", ""], ["Preview", "Preview", "Preview"], ["Accessible action", "Visible icon", "submit-value"],
  ]);
  assert.deepEqual(formEntries(document, form, createDocumentState(document), form.controls[1].node), [{ name: "empty", value: "" }]);
});

test("parser associations own repaired-table controls, radios and reset", () => {
  const document = documentWithForm(`<table><form id="f" action="/search"><tr><td>
    <input name="q" value="term"><input type="radio" name="r" value="first" checked>
  </td></tr></form></table><input type="radio" form="f" name="r" value="last" checked>`);
  const form = document.forms[0];
  assert.equal(form.controls.length, 3);
  assert.ok(form.controls.every((control) => control.form === form.node));
  let state = createDocumentState(document);
  assert.deepEqual(formEntries(document, form, state), [{ name: "q", value: "term" }, { name: "r", value: "last" }]);
  state = applyDocumentAction(document, state, { kind: "set-checked", target: form.controls[1].node, checked: true });
  state = applyDocumentAction(document, state, { kind: "set-control-value", target: form.controls[0].node, value: "edited" });
  state = applyDocumentAction(document, state, { kind: "reset-form", target: form.node });
  assert.equal(buildFormSubmissionRequest(document, form, state).url, "https://example.test/search?q=term&r=last");
});

test("explicit missing and non-form first matching ID prevent ownership with no ancestry fallback", () => {
  const document = documentWithForm(`<div id="duplicate"></div><form id="duplicate"><input name="blocked" form="duplicate"><input name="missing" form="missing"><input name="ordinary"></form>
    <input form="future" name="forward"><form id="future"></form>`);
  assert.deepEqual(document.controls.map((control) => control.form), [null, null, document.forms[0].node, document.forms[1].node]);
  assert.deepEqual(document.forms.map((form) => form.controls.map((control) => control.name)), [["ordinary"], ["forward"]]);
  assert.equal("formOwner" in document, false);
});

test("entry order and UTF-8 request bytes include duplicates, charset, dirname and CRLF normalization", () => {
  for (const method of ["get", "post"]) {
    const document = documentWithForm(`<form method="${method}" action="/submit?old=1">
      <input name="same" value="é"><input name="same" value="">
      <input type="hidden" name="_charset_" value="wrong">
      <input name="query" value="שלום" dirname="query.dir" dir="auto">
      <textarea name="a&#10;b" dirname="area.dir" dir="rtl">a\nb</textarea>
      <input type="hidden" name="raw" value="a&#13;b&#10;c&#13;&#10;d">
    </form>`);
    const form = document.forms[0], state = createDocumentState(document);
    assert.deepEqual(formEntries(document, form, state), [
      { name: "same", value: "é" }, { name: "same", value: "" }, { name: "_charset_", value: "UTF-8" },
      { name: "query", value: "שלום" }, { name: "query.dir", value: "rtl" }, { name: "a\nb", value: "a\nb" },
      { name: "area.dir", value: "rtl" }, { name: "raw", value: "a\rb\nc\r\nd" },
    ]);
    const expected = "same=%C3%A9&same=&_charset_=UTF-8&query=%D7%A9%D7%9C%D7%95%D7%9D&query.dir=rtl&a%0D%0Ab=a%0D%0Ab&area.dir=rtl&raw=a%0D%0Ab%0D%0Ac%0D%0Ad";
    const request = buildFormSubmissionRequest(document, form, state);
    assert.equal(method === "get" ? new URL(request.url).search.slice(1) : request.requestOptions.bodyText, expected);
    if (method === "post") assert.equal(request.requestOptions.headers["content-type"], "application/x-www-form-urlencoded; charset=UTF-8");
  }
});

test("unsupported contributing controls and invalid submitters fail closed", () => {
  for (const type of ["file", "date", "range", "color"]) {
    const document = documentWithForm(`<form><input name="supported"><input type="${type}" name="unsupported"></form>`);
    assert.throws(() => buildFormSubmissionRequest(document, document.forms[0], createDocumentState(document)), /Unsupported contributing/u);
  }
  const document = documentWithForm(`<form><input type="file" disabled name="ignored"><input type="date"><input type="image" name="image"><button disabled>Disabled</button><input name="text"><button type="button">Ordinary</button></form><form><button>Other</button></form>`);
  const form = document.forms[0], state = createDocumentState(document);
  assert.deepEqual(formEntries(document, form, state), [{ name: "text", value: "" }]);
  for (const invalid of [form.controls[2].node, form.controls[3].node, form.controls[4].node, form.controls[5].node, document.forms[1].controls[0].node, document.root]) {
    assert.throws(() => buildFormSubmissionRequest(document, form, state, invalid), /Invalid form submitter/u);
  }
});

test("index exhaustion never sends a partial form", () => {
  for (const indexLimits of [{ maxControlsPerForm: 1 }, { maxOptionsPerSelect: 1 }, { maxIndexedNodes: 7 }]) {
    const document = parseWebDocument(`<form><input name="a"><input name="b"><select name="choice"><option>A</option><option>B</option></select></form>`, {
      requestUrl: "https://example.test", finalUrl: "https://example.test", indexLimits,
    });
    assert.equal(document.indexOutcome.status, "truncated");
    assert.throws(() => buildFormSubmissionRequest(document, document.forms[0], createDocumentState(document)), /incompletely indexed/u);
  }
});

test("button captions do not substitute descendant ARIA names for visible text", () => {
  const document = documentWithForm(`<form><button name="b" value="sent"><span aria-label="Accessible">Visible</span><img alt=" icon"></button></form>`);
  const button = document.forms[0].controls[0];
  assert.equal(button.label, "Accessible icon");
  assert.equal(button.caption, "Visible icon");
  assert.equal(button.value, "sent");
});

test("charset matching is ASCII-insensitive and dirname follows auto-directionality controls", () => {
  const document = documentWithForm(`<form><input type="hidden" name="_CHARSET_" value="wrong"><input type="password" name="password" dirname="password.dir" dir="rtl" value="abc"><input type="submit" name="send" dirname="send.dir" value="Send" dir="rtl"><button type="submit" name="button" dirname="ignored" value="button">Button</button></form>`);
  const form = document.forms[0], state = createDocumentState(document);
  assert.deepEqual(formEntries(document, form, state, form.controls[2].node), [
    { name: "_CHARSET_", value: "UTF-8" }, { name: "password", value: "abc" }, { name: "password.dir", value: "rtl" },
    { name: "send", value: "Send" }, { name: "send.dir", value: "rtl" },
  ]);
});

test("entry construction normalizes lone surrogates before URL encoding", () => {
  const document = documentWithForm(`<form><input name="value"></form>`);
  const form = document.forms[0];
  const state = applyDocumentAction(document, createDocumentState(document), { kind: "set-control-value", target: form.controls[0].node, value: "a\ud800b" });
  assert.deepEqual(formEntries(document, form, state), [{ name: "value", value: "a\ufffdb" }]);
  assert.equal(buildFormSubmissionRequest(document, form, state).url, "https://example.test/base?value=a%EF%BF%BDb");
});

test("enumerated form and input keywords do not treat surrounding whitespace as valid", () => {
  const document = documentWithForm(`<form method=" post " enctype=" multipart/form-data "><input type=" number " name="value" value="invalid"><button type=" reset ">Submit</button></form>`);
  const form = document.forms[0];
  assert.equal(form.method, "get");
  assert.equal(form.encoding, "application/x-www-form-urlencoded");
  assert.equal(form.controls[0].inputType, "text");
  assert.equal(form.controls[1].kind, "submit");
  assert.equal(createDocumentState(document).controls.get(form.controls[0].node).value, "invalid");
});

test("implicit submission resolves the first default submitter, including external owners", () => {
  const document = documentWithForm(`<button id=first form=f name=intent value=external>External</button>
    <form id=f action=/search><input id=q name=q><button id=second>Second</button></form>`);
  assert.deepEqual(resolveImplicitSubmission(document, document.elementById("q")), {
    kind: "submit", formId: document.elementById("f"), submitterId: document.elementById("first")
  });
  const disabled = documentWithForm(`<form><input id=q><button disabled>First</button><button>Second</button></form>`);
  assert.deepEqual(resolveImplicitSubmission(disabled, disabled.elementById("q")), { kind: "none" });
  const image = documentWithForm(`<form><input id=q><input type=image><button>Second</button></form>`);
  assert.equal(resolveImplicitSubmission(image, image.elementById("q")).kind, "unsupported");
  const disabledImage = documentWithForm(`<form><input id=q><input type=image disabled><button>Second</button></form>`);
  assert.deepEqual(resolveImplicitSubmission(disabledImage, disabledImage.elementById("q")), { kind: "none" });
});

test("implicit submission counts blocking inputs independently of successful entries", () => {
  for (const type of ["text", "search", "url", "tel", "email", "password", "date", "month", "week", "time", "datetime-local", "number"]) {
    for (const attribute of ["", "disabled", "readonly"]) {
      const document = documentWithForm(`<form><input id=q><input type=${type} ${attribute}></form>`);
      assert.deepEqual(resolveImplicitSubmission(document, document.elementById("q")), { kind: "none" }, `${type} ${attribute}`);
    }
  }
  for (const other of ["<input type=hidden>", "<textarea></textarea>", "<select><option>One</option></select>", "<input type=checkbox>"]) {
    const document = documentWithForm(`<form id=f><input id=q readonly>${other}</form>`);
    assert.deepEqual(resolveImplicitSubmission(document, document.elementById("q")), { kind: "submit", formId: document.elementById("f") });
  }
});

test("implicit submission ignores ineligible or unowned controls", () => {
  for (const html of ["<input id=q>", "<form><textarea id=q></textarea></form>", "<form><input id=q disabled></form>",
    "<form><input id=q type=checkbox></form>", "<form><datalist><input id=q></datalist></form>"]) {
    const document = documentWithForm(html);
    assert.deepEqual(resolveImplicitSubmission(document, document.elementById("q")), { kind: "none" });
  }
});
