import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../../dist/mod.js";
import { isHtmlLikeContentType, parseWebDocument } from "../../dist/mod.js";

test("root API publishes the document boundary and removes former rendering contracts", () => {
  assert.equal(typeof publicApi.parseWebDocument, "function");
  assert.equal(typeof publicApi.createDocumentState, "function");
  assert.equal(typeof publicApi.PageNetworkClient, "function");
  for (const name of [
    "parseHtml",
    "renderDocumentToTerminal",
    "renderPageContent",
    "buildPageContent",
    "layoutPageContent",
    "createPager",
    "createSearchState",
    "formatRenderedPage",
    "WebDocumentSnapshot"
  ]) assert.equal(publicApi[name], undefined, `${name} must not remain exported`);
});

test("public document parsing preserves deliberate semantic contracts", () => {
  const document = parseWebDocument(
    "<title>Docs</title><main><h1>Guide</h1><a href='/next'>Next</a></main>",
    { requestUrl: "https://example.test/", finalUrl: "https://example.test/" }
  );
  assert.equal(document.title, "Docs");
  assert.equal(document.outline[0]?.text, "Guide");
  assert.equal(document.links[0]?.destination, "https://example.test/next");
});

test("HTML-like content types use an exact media-type boundary", () => {
  assert.equal(isHtmlLikeContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlLikeContentType("text/xml"), true);
  assert.equal(isHtmlLikeContentType("application/not-text/html"), false);
  assert.equal(isHtmlLikeContentType("image/svg+xml"), false);
});
