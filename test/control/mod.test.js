import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../../dist/mod.js";
import { isHtmlLikeContentType } from "../../dist/mod.js";

test("root API keeps document construction and mutable state orchestration internal", () => {
  assert.equal(typeof publicApi.PageNetworkClient, "function");
  for (const name of [
    "parseWebDocument",
    "parseWebDocumentBytes",
    "parseWebDocumentStream",
    "createDocumentState",
    "applyDocumentAction",
    "buildGetSubmissionUrl",
    "buildFormSubmissionRequest",
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

test("HTML-like content types use an exact media-type boundary", () => {
  assert.equal(isHtmlLikeContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlLikeContentType("text/xml"), true);
  assert.equal(isHtmlLikeContentType("application/not-text/html"), false);
  assert.equal(isHtmlLikeContentType("image/svg+xml"), false);
});
