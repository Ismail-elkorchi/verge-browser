import test from "node:test";
import assert from "node:assert/strict";
import { URL } from "node:url";

import { assertAllowedProtocol, isHtmlLikeContentType } from "../../dist/app/security.js";

test("assertAllowedProtocol rejects javascript protocol", () => {
  assert.throws(
    () => assertAllowedProtocol(new URL("javascript:alert(1)")),
    /Blocked unsupported protocol/
  );
});

test("assertAllowedProtocol permits file protocol", () => {
  assert.doesNotThrow(() => assertAllowedProtocol(new URL("file:///tmp/test.html")));
});

test("isHtmlLikeContentType accepts text/html", () => {
  assert.equal(isHtmlLikeContentType("text/html; charset=utf-8"), true);
});

test("isHtmlLikeContentType defaults to true when content type is missing", () => {
  assert.equal(isHtmlLikeContentType(null), true);
});
