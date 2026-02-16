import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "html-parser";

import { buildFormSubmissionRequest, buildGetSubmissionUrl, extractForms } from "../../dist/app/forms.js";

test("extractForms lists forms and fields", () => {
  const tree = parse(`
    <html>
      <body>
        <form method="get" action="/search">
          <input type="text" name="q" value="alpha" />
          <input type="checkbox" name="debug" value="1" checked />
          <select name="lang"><option value="en" selected>English</option></select>
        </form>
      </body>
    </html>
  `);

  const forms = extractForms(tree, "https://example.com/base");
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.method, "get");
  assert.equal(forms[0]?.actionUrl, "https://example.com/search");
  assert.deepEqual(
    forms[0]?.fields.map((field) => [field.name, field.value]),
    [
      ["q", "alpha"],
      ["debug", "1"],
      ["lang", "en"]
    ]
  );
});

test("buildGetSubmissionUrl applies overrides deterministically", () => {
  const url = buildGetSubmissionUrl(
    {
      index: 1,
      method: "get",
      actionUrl: "https://example.com/search",
      fields: [
        { name: "q", type: "text", value: "alpha" },
        { name: "page", type: "text", value: "1" }
      ]
    },
    {
      page: "2",
      q: "beta"
    }
  );

  assert.equal(url, "https://example.com/search?q=beta&page=2");
});

test("buildFormSubmissionRequest supports POST forms", () => {
  const submission = buildFormSubmissionRequest(
    {
      index: 2,
      method: "post",
      actionUrl: "https://example.com/login",
      fields: [
        { name: "user", type: "text", value: "ismail" },
        { name: "pass", type: "password", value: "secret" }
      ]
    },
    {
      pass: "updated"
    }
  );

  assert.equal(submission.url, "https://example.com/login");
  assert.equal(submission.requestOptions.method, "POST");
  assert.equal(submission.requestOptions.headers?.["content-type"], "application/x-www-form-urlencoded; charset=UTF-8");
  assert.equal(submission.requestOptions.bodyText, "user=ismail&pass=updated");
});
