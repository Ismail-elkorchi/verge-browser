import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SEARCH_URL_TEMPLATE,
  resolveHref,
  resolveInputUrl,
  resolveOmniboxInput
} from "../../dist/app/url.js";

test("resolveInputUrl normalizes bare hostnames", () => {
  assert.equal(resolveInputUrl("example.com"), "https://example.com/");
});

test("resolveInputUrl resolves relative path with current URL", () => {
  assert.equal(resolveInputUrl("/docs", "https://example.com/base"), "https://example.com/docs");
});

test("resolveHref resolves links against base URL", () => {
  assert.equal(resolveHref("../a", "https://example.com/docs/page"), "https://example.com/a");
});

test("resolveOmniboxInput separates direct locations from web searches", () => {
  assert.equal(
    resolveOmniboxInput("example.com/docs", "https://current.test/"),
    "https://example.com/docs"
  );
  assert.equal(
    resolveOmniboxInput("../guide", "https://example.com/docs/start"),
    "https://example.com/guide"
  );
  assert.equal(
    resolveOmniboxInput("terminal browser unicode"),
    "https://html.duckduckgo.com/html/?q=terminal%20browser%20unicode"
  );
  assert.match(DEFAULT_SEARCH_URL_TEMPLATE, /\{query\}/u);
  assert.throws(
    () => resolveOmniboxInput("search terms", undefined, "https://search.test/"),
    /\{query\}/u
  );
});
