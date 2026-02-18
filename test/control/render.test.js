import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "html-parser";

import { renderDocumentToTerminal } from "../../dist/app/render.js";

test("renderDocumentToTerminal collects links and renders body text", () => {
  const tree = parse(`
    <html>
      <head><title>Sample page</title></head>
      <body>
        <h1>Welcome</h1>
        <p>Open the <a href="/docs">documentation</a> for details.</p>
      </body>
    </html>
  `);

  const renderedPage = renderDocumentToTerminal({
    tree,
    requestUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    fetchedAtIso: "2026-01-01T00:00:00.000Z",
    width: 100
  });

  assert.equal(renderedPage.title, "Sample page");
  assert.equal(renderedPage.links.length, 1);
  assert.equal(renderedPage.links[0].resolvedHref, "https://example.com/docs");
  assert.ok(renderedPage.lines.some((line) => line.includes("Welcome")));
  assert.ok(renderedPage.lines.some((line) => line.includes("[1]")));
});
