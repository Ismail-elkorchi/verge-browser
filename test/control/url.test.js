import assert from "node:assert/strict";
import test from "node:test";

import { resolveHref, resolveInputUrl } from "../../dist/app/url.js";

test("resolveInputUrl normalizes bare hostnames", () => {
  assert.equal(resolveInputUrl("example.com"), "https://example.com/");
});

test("resolveInputUrl resolves relative path with current URL", () => {
  assert.equal(resolveInputUrl("/docs", "https://example.com/base"), "https://example.com/docs");
});

test("resolveHref resolves links against base URL", () => {
  assert.equal(resolveHref("../a", "https://example.com/docs/page"), "https://example.com/a");
});
