import assert from "node:assert/strict";
import test from "node:test";

import * as publicApi from "../../dist/mod.js";
import {
  isHtmlLikeContentType,
  parseHtml,
  renderDocumentToTerminal
} from "../../dist/mod.js";

test("root API does not publish flatten-first renderer internals", () => {
  assert.equal(publicApi.buildPageContent, undefined);
  assert.equal(publicApi.layoutPageContent, undefined);
  assert.equal(publicApi.documentBaseUrl, undefined);
  assert.equal(typeof publicApi.PageNetworkClient, "function");
});

test("HTML-like content types use an exact media-type boundary", () => {
  assert.equal(isHtmlLikeContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlLikeContentType("text/xml"), true);
  assert.equal(isHtmlLikeContentType("application/not-text/html"), false);
  assert.equal(isHtmlLikeContentType("image/svg+xml"), false);
});

test("parseHtml supports low-level rendering from the verge-browser entrypoint", () => {
  const document = parseHtml("<main><h1>Docs</h1><p>Deterministic output.</p></main>");
  const rendered = renderDocumentToTerminal({
    tree: document.tree,
    requestUrl: "https://example.test",
    finalUrl: "https://example.test",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  });

  const output = rendered.lines.join("\n");
  assert.match(output, /Docs/);
  assert.match(output, /Deterministic output/);
});

test("parseHtml treats Verge as a non-script browser unless explicitly overridden", () => {
  const html = '<noscript><a href="/fallback">Fallback link</a></noscript>';
  const disabled = parseHtml(html);
  const inert = parseHtml(html, { scriptingMode: "inert" });
  const input = {
    requestUrl: "https://example.test",
    finalUrl: "https://example.test",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 80
  };
  assert.equal(renderDocumentToTerminal({ ...input, tree: disabled.tree }).links.length, 1);
  assert.equal(renderDocumentToTerminal({ ...input, tree: inert.tree }).links.length, 0);
});
